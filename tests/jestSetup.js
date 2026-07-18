/**
 * Global test setup.
 *
 * Silences operational logging so suite output stays readable. Tests that care
 * about a specific log line configure their own capturing writer instead.
 */

const logger = require('../utils/logger');
const { PRIVACY } = require('../constants');

logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} });

/**
 * Fixed secret for hashing assertions. Real deployments generate this with a
 * CSPRNG and persist it; tests need it stable so hashes are reproducible.
 */
const TEST_VISITOR_SECRET = 'a'.repeat(PRIVACY.SECRET_BYTES * 2);

/** A key long enough to satisfy the minimum-length rule. */
const TEST_API_KEY = 'k'.repeat(PRIVACY.MIN_API_KEY_LENGTH);

module.exports = { TEST_VISITOR_SECRET, TEST_API_KEY };
