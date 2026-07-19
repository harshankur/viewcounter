const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { APP_NAME, HTTP_STATUS, PAYLOAD_LIMITS, SERVER } = require('./constants');
const config = require('./config');
const DatabaseManager = require('./db/DatabaseManager');
const logger = require('./utils/logger');
const { buildCorsOptions } = require('./middleware/security');
const { createAnalyticsRouter } = require('./routes/analytics');

logger.configure({ level: config.server.logLevel });

const dbManager = new DatabaseManager(config.dbInfo);
let isServerReady = false;
let httpServer = null;

/**
 * Build the Express application.
 *
 * Kept separate from the bootstrap below so the same wiring can be exercised
 * by tests and reused by embedders.
 */
function createApp() {
    const app = express();

    app.disable('x-powered-by');
    app.use(helmet());
    app.use(cors(buildCorsOptions(config.server.corsOrigins)));

    // Bounded well below body-parser's 100kb default; /event is the only
    // endpoint taking a body and its payload is small.
    app.use(express.json({ limit: PAYLOAD_LIMITS.MAX_BODY_BYTES }));

    // Never bare `true`. Trusting every hop lets any caller set
    // X-Forwarded-For and be believed, which forges geolocation and rotates
    // the rate-limiter key at will.
    app.set('trust proxy', config.server.trustProxy);

    app.use(rateLimit({
        windowMs: config.server.rateLimit.windowMs,
        limit: config.server.rateLimit.max,
        message: { message: 'Too many requests, please try again later.' },
        standardHeaders: true,
        legacyHeaders: false,
    }));

    app.use(createAnalyticsRouter({
        config,
        dbManager,
        isReady: () => isServerReady,
    }));

    // Malformed JSON and payloads over the limit surface here.
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        const status = err.status || err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
        logger.warn(`Request rejected: ${err.message}`, { requestId: req.id });
        res.status(status === HTTP_STATUS.INTERNAL_SERVER_ERROR ? HTTP_STATUS.BAD_REQUEST : status)
            .json({ message: 'Malformed or oversized request' });
    });

    return app;
}

const app = createApp();

/**
 * Fold the database-backed app registry into the in-memory allowlist.
 *
 * Config-declared apps and registry-declared apps are unioned: the file stays
 * authoritative for a fixed single-operator deployment, while the registry
 * carries tenants provisioned at runtime. A registry that cannot be read is a
 * warning rather than a startup failure — config-declared apps still work.
 */
async function mergeRegisteredApps() {
    try {
        const registered = await dbManager.listRegisteredApps();
        const merged = new Set([...config.allowed.appId, ...registered]);
        config.allowed.appId = [...merged];

        const origins = await dbManager.loadRegisteredOrigins();
        for (const [appId, list] of Object.entries(origins)) {
            // allowed.json wins, so an operator can override a tenant's own
            // origin list without editing the database.
            if (!config.allowed.origins[appId]) config.allowed.origins[appId] = list;
        }

        if (registered.length) {
            logger.info(`Loaded ${registered.length} registered app(s) from the database`);
        }
    } catch (error) {
        logger.warn(`Could not read the app registry: ${error.message}`);
    }
}

/**
 * Validate config, connect the database, and start listening.
 */
const initializeServer = async () => {
    try {
        config.validate();
        await dbManager.initialize(config.allowed.appId);

        // Merge dynamically registered tenants into the live allowlist, so
        // apps provisioned through the admin API survive a restart without
        // anyone editing allowed.json.
        await mergeRegisteredApps();

        isServerReady = true;

        if (require.main === module) {
            httpServer = app.listen(config.server.port, () => {
                logger.info(`${APP_NAME} listening on port ${config.server.port}`);
                logger.info(`Database mode: ${config.dbInfo.mode}`);
                logger.info(`Allowed apps: ${config.allowed.appId.join(', ')}`);
            });
        }
    } catch (error) {
        logger.error(`Failed to start: ${error.message}`);
        if (require.main === module) process.exit(1);
    }
};

// Only when run directly. Requiring this module as a library — to mount
// createAnalyticsRouter into an existing app — must not validate config,
// connect to a database, or bind a port as a side effect of the import.
if (require.main === module) {
    initializeServer();
}

/**
 * Graceful shutdown.
 *
 * Closes the HTTP listener first so in-flight requests can finish; previously
 * the listener was never closed at all, so "graceful" covered only the
 * database pool while active requests were severed.
 */
const shutdown = async (signal, exitCode = 0) => {
    logger.info(`${signal} received, shutting down gracefully...`);

    const forceExit = setTimeout(() => {
        logger.error('Shutdown timed out, exiting');
        process.exit(1);
    }, SERVER.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
        if (httpServer) {
            await new Promise((resolve) => httpServer.close(resolve));
        }
        await dbManager.close();
        // Preserve the caller's code: a crash-triggered shutdown must not
        // report success, or a process manager sees a clean exit and may
        // decline to restart the service.
        process.exit(exitCode);
    } catch (error) {
        logger.error(`Error during shutdown: ${error.message}`);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejected promise with no handler would otherwise terminate the process on
// modern Node with no log line explaining why.
process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : reason}`);
});

process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.message}`);
    logger.error(error.stack || '(no stack)');
    shutdown('uncaughtException', 1);
});

module.exports = app;
module.exports.createApp = createApp;
module.exports.createAnalyticsRouter = createAnalyticsRouter;
module.exports.DatabaseManager = DatabaseManager;
module.exports.dbManager = dbManager;
module.exports.initializeServer = initializeServer;
