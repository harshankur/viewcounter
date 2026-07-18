/**
 * Persisted server secret for visitor hashing.
 *
 * agent-instructions SECURITY.md §1: never fall back to a weak, guessable
 * default for a security-relevant value — generate one cryptographically and
 * persist it. This module is that generator.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { PRIVACY } = require('../constants');
const { getError, logWarning, ErrorType, WarningType } = require('./errorUtils');

/** Matches a hex string of exactly the expected entropy. */
const SECRET_PATTERN = new RegExp(`^[0-9a-f]{${PRIVACY.SECRET_BYTES * 2}}$`);

/**
 * Load the visitor-hash secret, generating and persisting it on first run.
 *
 * The file is written with mode 0600 (owner read/write only): this secret is
 * the sole reason a stored visitor hash cannot be brute-forced back to the raw
 * IP that produced it, so it is as sensitive as a database password.
 *
 * @param {string} filePath - absolute path to the secret file
 * @returns {string} hex-encoded secret
 * @throws {Error} ErrorType.SECRET_PERSIST_FAILED if it cannot be written
 */
function loadOrCreate(filePath) {
    if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8').trim();
        if (SECRET_PATTERN.test(existing)) {
            return existing;
        }
        // A malformed file is treated as absent and replaced. Keeping a short
        // or corrupted secret would silently weaken every hash derived from it.
        logWarning(WarningType.CONFIG_FILE_UNREADABLE, { file: filePath });
    }

    const secret = crypto.randomBytes(PRIVACY.SECRET_BYTES).toString('hex');

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${secret}\n`, { mode: PRIVACY.SECRET_FILE_MODE });
        // writeFileSync only applies `mode` when creating the file, so an
        // existing file with looser permissions keeps them. Force it.
        fs.chmodSync(filePath, PRIVACY.SECRET_FILE_MODE);
    } catch (cause) {
        throw getError(ErrorType.SECRET_PERSIST_FAILED, { path: filePath, cause: cause.message });
    }

    logWarning(WarningType.SECRET_GENERATED, { path: filePath });
    return secret;
}

module.exports = { loadOrCreate, SECRET_PATTERN };
