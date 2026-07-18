const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const geoip = require('geoip-country');
const config = require('./config');
const DatabaseManager = require('./db/DatabaseManager');
const UserAgentParser = require('./utils/userAgentParser');
const ReferrerParser = require('./utils/referrerParser');
const {
    isValidIP,
    validateRegisterView,
    validateStatsRequest,
    validateViewsRequest,
    handleValidationErrors
} = require('./middleware/validation');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json()); // Parse JSON bodies for POST requests

// Trust proxy for IP detection
app.set('trust proxy', true);

// Rate limiting
const limiter = rateLimit({
    windowMs: config.server.rateLimit.windowMs,
    limit: config.server.rateLimit.max,
    message: { message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

// Initialize database
const dbManager = new DatabaseManager(config.dbInfo);
let isServerReady = false;

// Initialize and Start Server (only if not in test environment or if run directly)
const initializeServer = async () => {
    try {
        await dbManager.initialize(config.allowed.appId);
        isServerReady = true;

        // Start server if this is the main module
        if (require.main === module) {
            const PORT = config.server.port;
            app.listen(PORT, () => {
                console.log(`✓ Server started on port ${PORT}`);
                console.log(`✓ Database mode: ${config.dbInfo.mode}`);
                console.log(`✓ Allowed apps: ${config.allowed.appId.join(', ')}`);
            });
        }
    } catch (error) {
        console.error('Failed to start server:', error.message);
        if (require.main === module) process.exit(1);
    }
};

// Start initialization if not in test
if (process.env.NODE_ENV !== 'test') {
    initializeServer();
}

// Export for testing
module.exports = app;
// Also export dbManager for testing if needed
module.exports.dbManager = dbManager;
module.exports.initializeServer = initializeServer;

// Utility: Get real IP address
function getIp(req) {
    return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
}

// Utility: Structured logging
function logRequest(req, message, level = 'info') {
    const timestamp = new Date().toISOString();
    const ip = getIp(req);
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message} | IP: ${ip}`);
}

/**
 * Health check endpoint
 */
app.get('/health', async (req, res) => {
    const dbHealth = await dbManager.healthCheck();

    if (!isServerReady || !dbHealth.healthy) {
        return res.status(503).json({
            status: 'unhealthy',
            database: dbHealth.healthy ? 'connected' : 'disconnected',
            error: dbHealth.error
        });
    }

    res.json({
        status: 'healthy',
        database: 'connected',
        mode: config.dbInfo.mode,
        uptime: process.uptime()
    });
});

/**
 * Get your own IP (test endpoint)
 */
app.get('/ip', (req, res) => {
    const ip = getIp(req);
    const ipInfo = geoip.lookup(ip);
    const userAgent = req.headers['user-agent'];
    const uaData = UserAgentParser.parse(userAgent);

    res.json({
        ip,
        ipInfo,
        valid: isValidIP(ip),
        userAgent: uaData
    });
});

/**
 * Register a view (enhanced with optional tracking parameters)
 */
app.get('/registerView',
    validateRegisterView(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId, deviceSize, page, title, referrer, sessionId } = req.query;
            const ip = getIp(req);

            // Validate IP format
            if (!isValidIP(ip)) {
                logRequest(req, `Invalid IP format: ${ip}`, 'warn');
                return res.status(400).json({ message: 'Invalid IP address format' });
            }

            // Get country from IP
            const ipInfo = geoip.lookup(ip);
            const country = ipInfo?.country || null;

            // Parse user agent
            const userAgent = req.headers['user-agent'];
            const uaData = UserAgentParser.parse(userAgent);

            // Parse referrer
            const referrerHeader = referrer || req.headers['referer'] || req.headers['referrer'];
            const referrerData = ReferrerParser.parse(referrerHeader);

            // Register view with all tracking data
            const result = await dbManager.registerEvent(appId, {
                ip,
                country,
                deviceSize,
                pagePath: page,
                pageTitle: title,
                referrer: referrerData.referrer,
                referrerDomain: referrerData.referrerDomain,
                sourceType: referrerData.sourceType,
                browser: uaData.browser,
                browserVersion: uaData.browserVersion,
                os: uaData.os,
                osVersion: uaData.osVersion,
                deviceType: uaData.deviceType,
                sessionId,
                eventType: 'pageview',
                uniqueWindowHours: config.server.uniqueVisitorWindowHours
            });

            if (result.duplicate) {
                logRequest(req, `Duplicate view for ${appId}`, 'info');
                return res.status(200).json({
                    message: 'View already registered recently',
                    duplicate: true
                });
            }

            logRequest(req, `Registered view for ${appId}${page ? ` (${page})` : ''}`, 'info');
            res.status(200).json({
                message: 'Success!',
                duplicate: false
            });

        } catch (error) {
            logRequest(req, `Error registering view: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to register view',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Track custom event
 */
app.post('/event', async (req, res) => {
    try {
        const { appId, eventType, eventData, sessionId, page, title } = req.body;

        // Validate appId
        if (!appId || !config.allowed.appId.includes(appId)) {
            return res.status(422).json({ message: 'Invalid or missing appId' });
        }

        if (!eventType) {
            return res.status(422).json({ message: 'eventType is required' });
        }

        const ip = getIp(req);
        if (!isValidIP(ip)) {
            return res.status(400).json({ message: 'Invalid IP address format' });
        }

        const ipInfo = geoip.lookup(ip);
        const userAgent = req.headers['user-agent'] || '';
        const uaData = UserAgentParser.parse(userAgent);
        const deviceSize = UserAgentParser.getDeviceSize(userAgent);

        // Track event
        const result = await dbManager.registerEvent(appId, {
            ip,
            country: ipInfo?.country || null,
            deviceSize,
            pagePath: page,
            pageTitle: title,
            browser: uaData.browser,
            browserVersion: uaData.browserVersion,
            os: uaData.os,
            osVersion: uaData.osVersion,
            deviceType: uaData.deviceType,
            sessionId,
            eventType,
            eventData,
            userAgent, // Required for transient hashing
            uniqueWindowHours: 0 // Don't prevent duplicates for custom events
        });

        logRequest(req, `Tracked event '${eventType}' for ${appId}`, 'info');
        res.status(200).json({
            message: 'Event tracked successfully',
            insertId: result.insertId
        });

    } catch (error) {
        logRequest(req, `Error tracking event: ${error.message}`, 'error');
        res.status(500).json({
            message: 'Failed to track event',
            error: config.server.nodeEnv === 'development' ? error.message : undefined
        });
    }
});

/**
 * Get statistics for an app
 */
app.get('/stats/:appId',
    validateStatsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId } = req.params;
            const stats = await dbManager.getStats(appId);

            res.json({
                appId,
                stats
            });

        } catch (error) {
            logRequest(req, `Error fetching stats: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch statistics',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Get time-based trends
 */
app.get('/trends/:appId',
    validateStatsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId } = req.params;
            const period = req.query.period || 'daily';
            const days = parseInt(req.query.days || '30', 10);

            if (!['hourly', 'daily', 'weekly'].includes(period)) {
                return res.status(422).json({ message: 'period must be hourly, daily, or weekly' });
            }

            const trends = await dbManager.getTrends(appId, period, days);

            res.json({
                appId,
                period,
                days,
                trends
            });

        } catch (error) {
            logRequest(req, `Error fetching trends: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch trends',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Get referrer statistics
 */
app.get('/referrers/:appId',
    validateStatsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId } = req.params;
            const limit = parseInt(req.query.limit || '20', 10);

            const stats = await dbManager.getReferrerStats(appId, limit);

            res.json({
                appId,
                ...stats
            });

        } catch (error) {
            logRequest(req, `Error fetching referrers: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch referrer statistics',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Get browser/OS statistics
 */
app.get('/browsers/:appId',
    validateStatsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId } = req.params;
            const stats = await dbManager.getBrowserStats(appId);

            res.json({
                appId,
                ...stats
            });

        } catch (error) {
            logRequest(req, `Error fetching browser stats: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch browser statistics',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Get page statistics
 */
app.get('/pages/:appId',
    validateStatsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId } = req.params;
            const limit = parseInt(req.query.limit || '20', 10);

            const pages = await dbManager.getPageStats(appId, limit);

            res.json({
                appId,
                pages
            });

        } catch (error) {
            logRequest(req, `Error fetching page stats: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch page statistics',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Get session details
 */
app.get('/sessions/:appId/:sessionId',
    validateStatsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId, sessionId } = req.params;
            const events = await dbManager.getSessionDetails(appId, sessionId);

            res.json({
                appId,
                sessionId,
                events,
                count: events.length
            });

        } catch (error) {
            logRequest(req, `Error fetching session: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch session details',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * Get recent views for an app
 */
app.get('/views/:appId',
    validateViewsRequest(config.allowed),
    handleValidationErrors,
    async (req, res) => {
        try {
            const { appId } = req.params;
            const limit = parseInt(req.query.limit || '50', 10);
            const offset = parseInt(req.query.offset || '0', 10);

            const result = await dbManager.getViews(appId, limit, offset);

            res.json({
                appId,
                ...result
            });

        } catch (error) {
            logRequest(req, `Error fetching views: ${error.message}`, 'error');
            res.status(500).json({
                message: 'Failed to fetch views',
                error: config.server.nodeEnv === 'development' ? error.message : undefined
            });
        }
    }
);

/**
 * List all registered app IDs
 */
app.get('/apps', (req, res) => {
    res.json({
        apps: config.allowed.appId,
        count: config.allowed.appId.length
    });
});

// Graceful shutdown
const shutdown = async (signal) => {
    console.log(`\n${signal} received, shutting down gracefully...`);

    await dbManager.close();

    process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));