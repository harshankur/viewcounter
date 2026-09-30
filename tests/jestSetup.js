/**
 * Global test setup.
 *
 * Silences operational logging so suite output stays readable. Tests that care
 * about a specific log line configure their own capturing writer instead.
 */

const logger = require('../utils/logger');
const { PRIVACY } = require('../constants');

logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} });

/*
 * supertest's own servers listen on 127.0.0.1 too (see support/loopback.js
 * for why). It starts one per request with listen(0) and reads the port at
 * once; binding a named address completes a moment later, so the request is
 * held until the server is listening and then sent to its port.
 */
const Test = require('supertest/lib/test');
const tls = require('tls');
const { LOOPBACK } = require('./support/loopback');

const pendingPath = Symbol('path waiting for the server to listen');
const { serverAddress, end } = Test.prototype;
Test.prototype.serverAddress = function serverAddressOnLoopback(app, path) {
    if (app.address()) return serverAddress.call(this, app, path);
    this._server = app.listen(0, LOOPBACK);
    this[pendingPath] = path;
    // Port-less until it is known; cookies only look at the host and path.
    return `http://${LOOPBACK}${path}`;
};
Test.prototype.end = function endOnceListening(fn) {
    const path = this[pendingPath];
    if (path === undefined) return end.call(this, fn);
    delete this[pendingPath];
    const server = this._server;
    const send = () => {
        const protocol = server instanceof tls.Server ? 'https' : 'http';
        this.url = `${protocol}://${LOOPBACK}:${server.address().port}${path}`;
        end.call(this, fn);
    };
    if (server.listening) send();
    else {
        server.once('listening', send);
        server.once('error', (error) => fn(error));
    }
    return this;
};

/**
 * Fixed secret for hashing assertions. Real deployments generate this with a
 * CSPRNG and persist it; tests need it stable so hashes are reproducible.
 */
const TEST_VISITOR_SECRET = 'a'.repeat(PRIVACY.SECRET_BYTES * 2);

/** A key long enough to satisfy the minimum-length rule. */
const TEST_API_KEY = 'k'.repeat(PRIVACY.MIN_API_KEY_LENGTH);

module.exports = { TEST_VISITOR_SECRET, TEST_API_KEY };
