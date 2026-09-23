/**
 * Schema for the admin feature: per-app admin columns, the two log tables, and
 * the idempotent migration that brings an existing deployment up to date.
 *
 * Every statement here is additive. Nothing is dropped or rewritten, so a
 * deployment can move to this version and back without losing a row.
 */

const crypto = require('crypto');

const {
    ADMIN_LOG_TABLE,
    DATABASE,
    FIELD_MAX_LENGTH,
    VIEW_LOG_TABLE,
} = require('../constants');
const { getError, logWarning, ErrorType, WarningType } = require('../utils/errorUtils');
const { isValidAppId } = require('../utils/appIdUtils');

/**
 * Columns added to every app table.
 *
 * `public_id` is the identity the admin API and UI use (CODE_STANDARDS.md §8):
 * the auto-increment `id` is enumerable and reveals how many rows exist, so it
 * never leaves the server. It starts nullable only so an existing table can be
 * backfilled; the migration then makes it NOT NULL and unique.
 *
 * `admin_modified_at` is the "modified by an admin" marker: NULL means the row
 * is exactly as observed, a timestamp says when an admin last changed its
 * content. `deleted_at` is the soft-delete marker.
 */
const ADMIN_COLUMNS = [
    { name: 'public_id', ddl: `CHAR(${FIELD_MAX_LENGTH.UUID}) DEFAULT NULL` },
    { name: 'note', ddl: `VARCHAR(${FIELD_MAX_LENGTH.NOTE}) DEFAULT NULL` },
    { name: 'admin_modified_at', ddl: 'DATETIME DEFAULT NULL' },
    { name: 'deleted_at', ddl: 'DATETIME DEFAULT NULL' },
];

/** Indexes the admin columns need, keyed by index name. */
const ADMIN_INDEXES = {
    uq_public_id: 'UNIQUE INDEX `uq_public_id` (`public_id`)',
    idx_deleted_at: 'INDEX `idx_deleted_at` (`deleted_at`)',
    idx_admin_modified_at: 'INDEX `idx_admin_modified_at` (`admin_modified_at`)',
};

/**
 * The admin operation log: who did what, when, to which rows.
 *
 * Deliberately records WHICH fields an edit touched, never their values, and
 * never an IP beyond its masked form. A log that kept copies of row content
 * would survive the row's permanent erasure and defeat it (GDPR Art. 17).
 */
const ADMIN_LOG_DDL = `
    CREATE TABLE IF NOT EXISTS \`${ADMIN_LOG_TABLE}\` (
        \`id\` CHAR(${FIELD_MAX_LENGTH.UUID}) PRIMARY KEY,
        \`created_at\` DATETIME(3) NOT NULL,
        \`action\` VARCHAR(32) NOT NULL,
        \`session_id\` CHAR(${FIELD_MAX_LENGTH.UUID}) DEFAULT NULL,
        \`masked_ip\` VARCHAR(${FIELD_MAX_LENGTH.MASKED_IP}) DEFAULT NULL,
        \`app_id\` VARCHAR(64) DEFAULT NULL,
        \`target_count\` INT NOT NULL DEFAULT 0,
        \`target_ids\` JSON DEFAULT NULL,
        \`fields\` JSON DEFAULT NULL,
        INDEX \`idx_created_at\` (\`created_at\`),
        INDEX \`idx_action\` (\`action\`),
        INDEX \`idx_app_id\` (\`app_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * The view register log: one entry per accepted view or event.
 *
 * Independent of the app tables on purpose, so it still says a view was
 * reported, and when, after an admin edits, deletes, or erases that view. It
 * holds no IP, hash, or User-Agent, so it contains no personal data to erase.
 */
const VIEW_LOG_DDL = `
    CREATE TABLE IF NOT EXISTS \`${VIEW_LOG_TABLE}\` (
        \`id\` CHAR(${FIELD_MAX_LENGTH.UUID}) PRIMARY KEY,
        \`created_at\` DATETIME(3) NOT NULL,
        \`app_id\` VARCHAR(64) NOT NULL,
        \`source\` VARCHAR(16) NOT NULL,
        \`view_id\` CHAR(${FIELD_MAX_LENGTH.UUID}) NOT NULL,
        \`event_type\` VARCHAR(${FIELD_MAX_LENGTH.EVENT_TYPE}) DEFAULT NULL,
        \`is_unique\` TINYINT(1) NOT NULL,
        INDEX \`idx_created_at\` (\`created_at\`),
        INDEX \`idx_app_created\` (\`app_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

/**
 * Column and index definitions for a brand-new app table, spliced into
 * `appTableDDL` so a fresh table is born in the migrated shape.
 */
const NEW_TABLE_ADMIN_COLUMNS = [
    `\`public_id\` CHAR(${FIELD_MAX_LENGTH.UUID}) NOT NULL`,
    `\`note\` VARCHAR(${FIELD_MAX_LENGTH.NOTE}) DEFAULT NULL`,
    '`admin_modified_at` DATETIME DEFAULT NULL',
    '`deleted_at` DATETIME DEFAULT NULL',
];

const NEW_TABLE_ADMIN_INDEXES = Object.values(ADMIN_INDEXES);

/**
 * @param {object} pool mysql2 promise pool
 * @param {string} table
 * @returns {Promise<Map<string, {nullable: boolean}>>} existing columns
 */
async function readColumns(pool, table) {
    const [rows] = await pool.query(
        `SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    );
    return new Map(rows.map((row) => [row.name, { nullable: row.nullable === 'YES' }]));
}

/**
 * @param {object} pool
 * @param {string} table
 * @returns {Promise<Set<string>>} existing index names
 */
async function readIndexes(pool, table) {
    const [rows] = await pool.query(
        `SELECT DISTINCT INDEX_NAME AS name
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table]
    );
    return new Set(rows.map((row) => row.name));
}

/**
 * Give every row without a public_id a fresh UUID, a batch at a time.
 *
 * Generated in Node with a CSPRNG rather than MySQL's UUID(), which is a
 * time-and-host based v1 value (CODE_STANDARDS.md §8), and batched so a large
 * table is not rewritten in one giant statement.
 *
 * @param {object} pool
 * @param {string} table already validated
 * @returns {Promise<number>} rows backfilled
 */
async function backfillPublicIds(pool, table) {
    let total = 0;

    for (;;) {
        const [rows] = await pool.query(
            `SELECT id FROM \`${table}\` WHERE public_id IS NULL LIMIT ?`,
            [DATABASE.BACKFILL_BATCH_SIZE]
        );
        if (rows.length === 0) return total;

        const ids = rows.map((row) => row.id);
        const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
        const params = ids.flatMap((id) => [id, crypto.randomUUID()]);

        await pool.query(
            `UPDATE \`${table}\` SET public_id = CASE id ${cases} END WHERE id IN (?)`,
            [...params, ids]
        );
        total += ids.length;
    }
}

/**
 * Bring one app table up to the admin schema. Idempotent: a table already in
 * shape is read and left alone.
 *
 * @param {object} pool
 * @param {string} appId
 * @returns {Promise<{migrated: boolean, backfilled: number}>}
 * @throws {Error} ErrorType.MIGRATION_FAILED, so startup fails loudly rather
 *   than serving an admin UI over a half-migrated table
 */
async function migrateAppTable(pool, appId) {
    if (!isValidAppId(appId)) {
        throw getError(ErrorType.INVALID_APP_ID, { appId });
    }

    try {
        const columns = await readColumns(pool, appId);
        if (columns.size === 0) {
            logWarning(WarningType.MIGRATION_TABLE_MISSING, { table: appId });
            return { migrated: false, backfilled: 0 };
        }

        for (const column of ADMIN_COLUMNS) {
            if (!columns.has(column.name)) {
                await pool.query(`ALTER TABLE \`${appId}\` ADD COLUMN \`${column.name}\` ${column.ddl}`);
            }
        }

        const backfilled = await backfillPublicIds(pool, appId);

        const publicId = columns.get('public_id');
        if (!publicId || publicId.nullable) {
            await pool.query(
                `ALTER TABLE \`${appId}\` MODIFY \`public_id\` CHAR(${FIELD_MAX_LENGTH.UUID}) NOT NULL`
            );
        }

        const indexes = await readIndexes(pool, appId);
        for (const [name, definition] of Object.entries(ADMIN_INDEXES)) {
            if (!indexes.has(name)) {
                await pool.query(`ALTER TABLE \`${appId}\` ADD ${definition}`);
            }
        }

        return { migrated: true, backfilled };
    } catch (cause) {
        throw getError(ErrorType.MIGRATION_FAILED, { table: appId, cause: cause.message });
    }
}

/**
 * Create the log tables. Safe in `connect` mode for the same reason the app
 * registry is: they are the service's own bookkeeping, not the operator's
 * schema.
 * @param {object} pool
 */
async function ensureLogTables(pool) {
    await pool.query(ADMIN_LOG_DDL);
    await pool.query(VIEW_LOG_DDL);
}

module.exports = {
    ADMIN_COLUMNS,
    ADMIN_INDEXES,
    ADMIN_LOG_DDL,
    VIEW_LOG_DDL,
    NEW_TABLE_ADMIN_COLUMNS,
    NEW_TABLE_ADMIN_INDEXES,
    backfillPublicIds,
    ensureLogTables,
    migrateAppTable,
};
