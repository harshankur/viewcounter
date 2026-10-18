/**
 * Admin schema migration, trash retention, and the DatabaseManager changes
 * that came with them, asserted at the SQL level.
 */

const {
    ADMIN_LOG_DDL,
    VIEW_LOG_DDL,
    TRACKING_REJECTIONS_DDL,
    TRACKING_COLUMNS,
    ADMIN_INDEXES,
    backfillPublicIds,
    ensureLogTables,
    migrateAppTable,
} = require('../db/adminSchema');
const DatabaseManager = require('../db/DatabaseManager');
const { expireViews, purgeExpiredTrash, pruneViewLog, startRetention } = require('../db/retention');
const { ADMIN_ACTION, COLLECTED_BY, DATABASE, TRACKING, VIEW_LOG_SOURCE } = require('../constants');
const logger = require('../utils/logger');
const { createScriptedPool, withVisitorSalt } = require('./support/scriptedPool');
const { createMemoryRepos } = require('./support/memoryRepos');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let lines;
beforeEach(() => {
    lines = [];
    logger.configure({ level: logger.LogLevel.DEBUG, writer: (line) => lines.push(line) });
});
afterEach(() => logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} }));

/**
 * Rows 1..count still without a public_id, answering the backfill's keyset
 * SELECT (`id > ? ... ORDER BY id LIMIT ?`) and UPDATE like a real table.
 */
function pendingRows(count) {
    const pending = new Set(Array.from({ length: count }, (_, i) => i + 1));
    return {
        select: ([afterId, limit]) => [[...pending].filter((id) => id > afterId).slice(0, limit).map((id) => ({ id }))],
        update: (params) => {
            for (const id of params[params.length - 1]) pending.delete(id);
            return [{ affectedRows: 0 }];
        },
    };
}

const isBackfillSelect = (sql) => sql.includes('AND public_id IS NULL ORDER BY id LIMIT');
const isBackfillUpdate = (sql) => sql.includes('SET public_id = CASE id');

/**
 * A pool scripted to look like a pre-admin app table: the original columns,
 * `pending` rows still without a public_id, and whatever indexes are given.
 */
function legacyTablePool({ columns = ['id', 'masked_ip'], nullable = {}, pending = 0, indexes = ['PRIMARY'] } = {}) {
    const rows = pendingRows(pending);
    return createScriptedPool((sql, params) => {
        if (sql.includes('information_schema.COLUMNS')) {
            return [columns.map((name) => ({ name, nullable: nullable[name] ? 'YES' : 'NO' }))];
        }
        if (sql.includes('information_schema.STATISTICS')) {
            return [indexes.map((name) => ({ name }))];
        }
        if (isBackfillSelect(sql)) return rows.select(params);
        if (isBackfillUpdate(sql)) return rows.update(params);
        return [{ affectedRows: 0 }];
    });
}

describe('migrateAppTable', () => {
    test('adds every admin column, backfills IDs, enforces NOT NULL, and adds indexes', async () => {
        const pool = legacyTablePool({ pending: 2 });
        const result = await migrateAppTable(pool, 'blog');

        expect(result).toEqual({ migrated: true, backfilled: 2 });
        const alters = pool.matching('ALTER TABLE').map((q) => q.sql);
        expect(alters).toEqual(expect.arrayContaining([
            expect.stringContaining('ADD COLUMN `public_id` CHAR(36) DEFAULT NULL'),
            expect.stringContaining('ADD COLUMN `note` VARCHAR(1000) DEFAULT NULL'),
            expect.stringContaining('ADD COLUMN `admin_modified_at` DATETIME DEFAULT NULL'),
            expect.stringContaining('ADD COLUMN `deleted_at` DATETIME DEFAULT NULL'),
            expect.stringContaining('MODIFY `public_id` CHAR(36) NOT NULL'),
            ...Object.values(ADMIN_INDEXES).map((definition) => expect.stringContaining(`ADD ${definition}`)),
        ]));
    });

    test('backfills with CSPRNG v4 UUIDs, bound as parameters', async () => {
        const pool = legacyTablePool({ pending: 2 });
        await migrateAppTable(pool, 'blog');
        const [update] = pool.matching('SET public_id = CASE id');
        expect(update.sql).toContain('WHEN ? THEN ? WHEN ? THEN ?');
        const [id1, uuid1, id2, uuid2, ids] = update.params;
        expect([id1, id2]).toEqual([1, 2]);
        expect(uuid1).toMatch(UUID_V4);
        expect(uuid2).toMatch(UUID_V4);
        expect(uuid1).not.toBe(uuid2);
        expect(ids).toEqual([1, 2]);
    });

    test('backfills a large table in bounded batches', async () => {
        const pool = legacyTablePool({ pending: DATABASE.BACKFILL_BATCH_SIZE + 3 });
        const result = await migrateAppTable(pool, 'blog');
        expect(result.backfilled).toBe(DATABASE.BACKFILL_BATCH_SIZE + 3);
        expect(pool.matching('SET public_id = CASE id')).toHaveLength(2);
    });

    test('each batch resumes after the last id, so no row is scanned twice', async () => {
        const size = DATABASE.BACKFILL_BATCH_SIZE;
        const pool = legacyTablePool({ pending: size * 2 + 3 });
        await migrateAppTable(pool, 'blog');
        const resumedAfter = pool.matching('AND public_id IS NULL ORDER BY id LIMIT').map((q) => q.params[0]);
        expect(resumedAfter).toEqual([0, size, size * 2, size * 2 + 3]);
    });

    const MIGRATED = ['id', 'public_id', 'note', 'admin_modified_at', 'deleted_at', ...TRACKING_COLUMNS.map((c) => c.name)];

    test('an already migrated table is read and left alone', async () => {
        const pool = legacyTablePool({
            columns: MIGRATED,
            indexes: ['PRIMARY', ...Object.keys(ADMIN_INDEXES)],
        });
        expect(await migrateAppTable(pool, 'blog')).toEqual({ migrated: true, backfilled: 0 });
        expect(pool.matching('ALTER TABLE')).toHaveLength(0);
        expect(pool.matching('UPDATE')).toHaveLength(0);
    });

    test('a nullable public_id left by an interrupted migration is tightened', async () => {
        const pool = legacyTablePool({
            columns: MIGRATED,
            nullable: { public_id: true },
            indexes: ['PRIMARY', ...Object.keys(ADMIN_INDEXES)],
        });
        await migrateAppTable(pool, 'blog');
        expect(pool.matching('ALTER TABLE').map((q) => q.sql)).toEqual([
            expect.stringContaining('MODIFY `public_id` CHAR(36) NOT NULL'),
        ]);
    });

    test('a missing table is skipped with a warning', async () => {
        const pool = legacyTablePool({ columns: [] });
        expect(await migrateAppTable(pool, 'ghost')).toEqual({ migrated: false, backfilled: 0 });
        expect(lines.join('\n')).toContain("Table 'ghost' does not exist; skipping its schema migration.");
        expect(pool.matching('ALTER TABLE')).toHaveLength(0);
    });

    test('an invalid app id is refused before any statement', async () => {
        const pool = legacyTablePool();
        await expect(migrateAppTable(pool, 'x`; DROP TABLE y; --')).rejects.toMatchObject({ code: 'INVALID_APP_ID' });
        expect(pool.queries).toHaveLength(0);
    });

    test('a database error becomes MIGRATION_FAILED naming the table', async () => {
        const pool = createScriptedPool(() => { throw new TypeError('ALTER command denied'); });
        await expect(migrateAppTable(pool, 'blog')).rejects.toMatchObject({
            code: 'MIGRATION_FAILED',
            message: "Schema migration failed for table 'blog': ALTER command denied",
        });
    });

    test('a 3.1 table gains the tracking columns, nullable but for which side collected a view, and nothing else', async () => {
        const pool = legacyTablePool({
            columns: ['id', 'public_id', 'note', 'admin_modified_at', 'deleted_at'],
            indexes: ['PRIMARY', ...Object.keys(ADMIN_INDEXES)],
        });
        await migrateAppTable(pool, 'blog');
        const alters = pool.matching('ALTER TABLE').map((q) => q.sql);
        expect(alters).toEqual(TRACKING_COLUMNS.map((c) => `ALTER TABLE \`blog\` ADD COLUMN \`${c.name}\` ${c.ddl}`));
        for (const sql of alters.filter((alter) => !alter.includes('`collected_by`'))) expect(sql).toMatch(/DEFAULT NULL$/);
    });

    test('a 3.5 table gains collected_by alone (schema v8), and every existing row reads as the script\'s', async () => {
        const pool = legacyTablePool({
            columns: ['id', 'public_id', 'note', 'admin_modified_at', 'deleted_at',
                ...TRACKING_COLUMNS.map((c) => c.name).filter((name) => name !== 'collected_by')],
            indexes: ['PRIMARY', ...Object.keys(ADMIN_INDEXES)],
        });
        await migrateAppTable(pool, 'blog');
        // NOT NULL with a default: the engine fills every existing row with it as the column is added.
        expect(pool.matching('ALTER TABLE').map((q) => q.sql)).toEqual([
            "ALTER TABLE `blog` ADD COLUMN `collected_by` VARCHAR(8) NOT NULL DEFAULT 'script'",
        ]);
        expect(DATABASE.SCHEMA_VERSION).toBe('schema_v8');
    });

    test('a table already on schema v8 is left alone', async () => {
        const pool = legacyTablePool({
            columns: ['id', 'public_id', 'note', 'admin_modified_at', 'deleted_at', ...TRACKING_COLUMNS.map((c) => c.name)],
            indexes: ['PRIMARY', ...Object.keys(ADMIN_INDEXES)],
        });
        await migrateAppTable(pool, 'blog');
        expect(pool.matching('ALTER TABLE')).toHaveLength(0);
    });

    test('backfillPublicIds returns zero when every row already has an ID', async () => {
        const pool = legacyTablePool({ pending: 0 });
        expect(await backfillPublicIds(pool, 'blog')).toBe(0);
    });
});

describe('log table DDL', () => {
    test('ensureLogTables creates the log tables and adds the hostname a 3.1 view log lacks', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('information_schema.COLUMNS')
            ? [[{ name: 'id', nullable: 'NO' }, { name: 'is_unique', nullable: 'NO' }]] : undefined));
        await ensureLogTables(pool);
        const statements = pool.queries.map((q) => q.sql);
        expect(statements.slice(0, 3)).toEqual([ADMIN_LOG_DDL, VIEW_LOG_DDL, TRACKING_REJECTIONS_DDL]);
        expect(statements.at(-1)).toBe('ALTER TABLE `_view_log` ADD COLUMN `hostname` VARCHAR(253) DEFAULT NULL');
    });

    test('ensureLogTables leaves a current view log alone', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('information_schema.COLUMNS')
            ? [[{ name: 'id', nullable: 'NO' }, { name: 'hostname', nullable: 'YES' }]] : undefined));
        await ensureLogTables(pool);
        expect(pool.matching('ALTER TABLE')).toHaveLength(0);
    });

    test('rejections are counted per minute and key, with no column for anything about the requester', () => {
        expect(TRACKING_REJECTIONS_DDL).toContain('PRIMARY KEY (`minute`, `source`, `reason`, `app_id`, `detail`, `hostname`)');
        expect(TRACKING_REJECTIONS_DDL).not.toMatch(/ip|hash|agent/i);
    });

    test.each([['admin log', ADMIN_LOG_DDL], ['view log', VIEW_LOG_DDL]])(
        'the %s has a UUID primary key and no column for raw personal data', (_label, ddl) => {
            expect(ddl).toMatch(/`id` CHAR\(36\) PRIMARY KEY/);
            for (const column of ['`ip`', 'visitor_hash', 'user_agent', 'page_title', 'referrer', 'note', 'event_data']) {
                expect(ddl).not.toContain(column);
            }
        });
});

describe('DatabaseManager admin wiring', () => {
    const managerWith = (respond) => {
        const manager = new DatabaseManager({ mode: 'connect' });
        manager.pool = createScriptedPool(withVisitorSalt(respond));
        return manager;
    };

    test('a new app table is born on schema v8, with collected_by', () => {
        expect(DatabaseManager.appTableDDL('blog')).toContain("`collected_by` VARCHAR(8) NOT NULL DEFAULT 'script'");
    });

    test('a new app table is created with the admin columns and indexes', () => {
        const ddl = DatabaseManager.appTableDDL('blog');
        expect(ddl).toContain('`public_id` CHAR(36) NOT NULL');
        expect(ddl).toContain('`deleted_at` DATETIME DEFAULT NULL');
        expect(ddl).toContain('UNIQUE INDEX `uq_public_id`');
    });

    test('registerEvent stores a v4 public_id and writes the view log', async () => {
        const manager = managerWith(() => [{ insertId: 9 }]);
        const result = await manager.registerEvent('blog', {
            ip: '203.0.113.5', deviceSize: 'large', eventType: 'click', source: VIEW_LOG_SOURCE.EVENT,
            uniqueWindowHours: 0, visitorSecret: 'a'.repeat(64),
        });
        expect(result.publicId).toMatch(UUID_V4);

        const [insert] = manager.pool.matching('INSERT INTO `blog`');
        expect(insert.params[0]).toBe(result.publicId);
        const [log] = manager.pool.matching('INSERT INTO `_view_log`');
        expect(log.params.slice(1)).toEqual(['blog', VIEW_LOG_SOURCE.EVENT, result.publicId, 'click', 1, null]);
    });

    test('registerEvent stores the 3.2 context columns, bounded to their widths', async () => {
        const manager = managerWith(() => [{ insertId: 1 }]);
        await manager.registerEvent('blog', {
            ip: '203.0.113.5', deviceSize: 'large', uniqueWindowHours: 0, visitorSecret: 'a'.repeat(64),
            hostname: 'www.example.com', language: 'en', utmSource: 's'.repeat(150), utmMedium: 'email',
            utmCampaign: 'launch', utmTerm: null, utmContent: 'hero', region: 'Bavaria', city: 'Munich',
        });
        const [insert] = manager.pool.matching('INSERT INTO `blog`');
        expect(insert.sql).toContain('hostname, language, utm_source, utm_medium, utm_campaign, utm_term, utm_content,');
        expect(insert.params.slice(-10, -1)).toEqual(['www.example.com', 'en', 's'.repeat(100), 'email', 'launch', null, 'hero', 'Bavaria', 'Munich']);
        // Which side collected it: the tracker script, unless the caller says otherwise.
        expect(insert.sql).toContain('region, city, collected_by');
        expect(insert.params.at(-1)).toBe(COLLECTED_BY.SCRIPT);
        const [log] = manager.pool.matching('INSERT INTO `_view_log`');
        expect(log.params.at(-1)).toBe('www.example.com');
    });

    test('addEngagement only ever raises the values, and only on a recent live view', async () => {
        const manager = managerWith(() => [{ affectedRows: 1 }]);
        expect(await manager.addEngagement('blog', { viewId: 'v', engagedMs: 1500, scrollDepth: 40 })).toBe(true);
        const [update] = manager.pool.matching('UPDATE `blog`');
        expect(update.sql).toContain('engaged_ms = GREATEST(COALESCE(engaged_ms, 0), ?)');
        expect(update.sql).toMatch(/scroll_depth = CASE WHEN \? IS NULL THEN scroll_depth\s+ELSE GREATEST\(COALESCE\(scroll_depth, 0\), \?\) END/);
        // Every report marks the view as seen now, which "right now" reads.
        expect(update.sql).toContain('last_seen_at = NOW()');
        expect(update.sql).toContain(DatabaseManager.LIVE_ROW);
        expect(update.sql).toContain('timestamp > DATE_SUB(NOW(), INTERVAL ? HOUR)');
        expect(update.params).toEqual([1500, 40, 40, 'v', 24]);
    });

    test('addEngagement with no scroll depth leaves the stored depth alone', async () => {
        const manager = managerWith(() => [{ affectedRows: 1 }]);
        await manager.addEngagement('blog', { viewId: 'v', engagedMs: 1500, scrollDepth: null });
        // NULL selects the CASE branch that keeps the column as it is.
        expect(manager.pool.matching('UPDATE `blog`')[0].params).toEqual([1500, null, null, 'v', 24]);
    });

    test('addEngagement reports when no view matched', async () => {
        const manager = managerWith(() => [{ affectedRows: 0 }]);
        expect(await manager.addEngagement('blog', { viewId: 'v', engagedMs: 1, scrollDepth: 1 })).toBe(false);
    });

    test('registerEvent defaults the view-log source to registerView', async () => {
        const manager = managerWith(() => [{ insertId: 1 }]);
        await manager.registerEvent('blog', { ip: '203.0.113.5', deviceSize: 'large', uniqueWindowHours: 0, visitorSecret: 'a'.repeat(64) });
        expect(manager.pool.matching('INSERT INTO `_view_log`')[0].params[2]).toBe(VIEW_LOG_SOURCE.REGISTER_VIEW);
    });

    test('the duplicate check ignores trashed rows', async () => {
        const manager = managerWith(() => [[]]);
        await manager.registerEvent('blog', { ip: '203.0.113.5', deviceSize: 'large', uniqueWindowHours: 24, visitorSecret: 'a'.repeat(64) });
        expect(manager.pool.matching('SELECT id FROM `blog`')[0].sql).toContain('deleted_at IS NULL');
    });

    test('a failing view-log write does not fail the view', async () => {
        const manager = managerWith((sql) => {
            if (sql.includes('_view_log')) throw new TypeError('log table missing');
            return [{ insertId: 1 }];
        });
        await expect(manager.registerEvent('blog', {
            ip: '203.0.113.5', deviceSize: 'large', uniqueWindowHours: 0, visitorSecret: 'a'.repeat(64),
        })).resolves.toMatchObject({ duplicate: false });
    });

    test.each([
        ['getStats', ['blog']],
        ['getViews', ['blog', 10, 0]],
        ['getTrends', ['blog', 'daily', 7]],
        ['getReferrerStats', ['blog', 10]],
        ['getBrowserStats', ['blog']],
        ['getPageStats', ['blog', 10]],
        ['getSessionDetails', ['blog', 's']],
    ])('%s counts only live rows in every statement', async (method, args) => {
        const manager = managerWith(() => [[{ count: 0, total_views: 0 }]]);
        await manager[method](...args);
        expect(manager.pool.queries.length).toBeGreaterThan(0);
        for (const { sql } of manager.pool.queries) {
            expect(sql).toContain(DatabaseManager.LIVE_ROW);
        }
    });

    test('migrate creates the log tables and migrates each app', async () => {
        const manager = managerWith((sql) => (sql.includes('information_schema.COLUMNS') ? [[]] : undefined));
        await manager.migrate(['blog', 'shop']);
        expect(manager.pool.matching('CREATE TABLE IF NOT EXISTS `_admin_log`')).toHaveLength(1);
        expect(manager.pool.matching('CREATE TABLE IF NOT EXISTS `_view_log`')).toHaveLength(1);
        expect(manager.pool.matching('CREATE TABLE IF NOT EXISTS `_tracking_rejections`')).toHaveLength(1);
        // The view log's own columns, then one read per app.
        expect(manager.pool.matching('information_schema.COLUMNS').map((q) => q.params[0])).toEqual(['_view_log', 'blog', 'shop']);
    });

    test('migrate reports how many existing rows received public IDs', async () => {
        const rows = pendingRows(3);
        const manager = managerWith((sql, params) => {
            if (sql.includes('information_schema.COLUMNS')) return [[{ name: 'id', nullable: 'NO' }]];
            if (sql.includes('information_schema.STATISTICS')) return [[]];
            if (isBackfillSelect(sql)) return rows.select(params);
            if (isBackfillUpdate(sql)) return rows.update(params);
            return undefined;
        });
        await manager.migrate(['blog']);
        expect(lines.join('\n')).toContain("Assigned public IDs to 3 existing row(s) in 'blog'");
    });

    test('migrate requires an initialized database', async () => {
        await expect(new DatabaseManager({}).migrate(['blog'])).rejects.toMatchObject({ code: 'DATABASE_NOT_INITIALIZED' });
    });

    test('registerApp migrates a pre-existing table of an older shape', async () => {
        const manager = managerWith((sql) => (sql.includes('information_schema.COLUMNS') ? [[]] : undefined));
        await manager.registerApp('fresh_app');
        expect(manager.pool.matching('information_schema.COLUMNS')[0].params).toEqual(['fresh_app']);
    });
});

describe('trash retention', () => {
    const DAY = 24 * 60 * 60 * 1000;

    test('erases trash older than the retention and logs a count, not IDs', async () => {
        const now = new Date('2026-09-30T00:00:00Z');
        const repos = createMemoryRepos({
            now: () => now,
            views: {
                blog: [
                    { id: 'old', deletedAt: new Date(now.getTime() - 31 * DAY) },
                    { id: 'recent', deletedAt: new Date(now.getTime() - 2 * DAY) },
                    { id: 'live', deletedAt: null },
                ],
            },
        });

        const erased = await purgeExpiredTrash({ ...repos, appIds: ['blog'], days: 30 });

        expect(erased).toEqual({ blog: 1 });
        expect(repos.tables.get('blog').map((row) => row.id)).toEqual(['recent', 'live']);
        expect(repos.adminLog).toHaveLength(1);
        expect(repos.adminLog[0]).toMatchObject({
            action: ADMIN_ACTION.TRASH_AUTO_PURGED, appId: 'blog', targetCount: 1, targetIds: [], sessionId: null,
        });
    });

    test('a run that erases nothing leaves no log entry', async () => {
        const repos = createMemoryRepos({ views: { blog: [] } });
        await purgeExpiredTrash({ ...repos, appIds: ['blog'], days: 30 });
        expect(repos.adminLog).toHaveLength(0);
    });

    test.each([0, -1, undefined])('retention of %s erases nothing', async (days) => {
        const repos = createMemoryRepos({ views: { blog: [{ id: 'x', deletedAt: new Date(0) }] } });
        expect(await purgeExpiredTrash({ ...repos, appIds: ['blog'], days })).toEqual({});
        expect(repos.tables.get('blog')).toHaveLength(1);
    });

    test('one failing app does not stop the others', async () => {
        const repos = createMemoryRepos({ views: { good: [{ id: 'x', deletedAt: new Date(0) }] } });
        const original = repos.adminRepo.purgeExpired;
        repos.adminRepo.purgeExpired = async (appId, days) => {
            if (appId === 'bad') throw new TypeError('locked');
            return original(appId, days);
        };
        const erased = await purgeExpiredTrash({ ...repos, appIds: ['bad', 'good'], days: 1 });
        expect(erased).toEqual({ good: 1 });
        expect(lines.join('\n')).toContain("Automatic trash purge failed for 'bad': locked");
    });

    test('the schedule runs at once, repeats, re-reads the app list, and stops', async () => {
        jest.useFakeTimers();
        try {
            const calls = [];
            const adminRepo = { purgeExpired: async (appId) => { calls.push(appId); return 0; } };
            let apps = ['a'];
            const stop = startRetention({
                adminRepo, logRepo: { writeAdminLog: async () => true }, getAppIds: () => apps, trashDays: 30, viewLogDays: 0, intervalMs: 1000,
            });
            await Promise.resolve();
            expect(calls).toEqual(['a']);

            apps = ['a', 'b'];
            await jest.advanceTimersByTimeAsync(1000);
            expect(calls).toEqual(['a', 'a', 'b']);

            stop();
            await jest.advanceTimersByTimeAsync(5000);
            expect(calls).toHaveLength(3);
        } finally {
            jest.useRealTimers();
        }
    });

    test('views older than the view retention go to the trash, and the run is logged as a count', async () => {
        const now = new Date('2026-10-18T00:00:00Z');
        const repos = createMemoryRepos({
            now: () => now,
            views: {
                blog: [
                    { id: 'old', timestamp: new Date(now.getTime() - 400 * DAY), deletedAt: null },
                    { id: 'young', timestamp: new Date(now.getTime() - 10 * DAY), deletedAt: null },
                    { id: 'old-trashed', timestamp: new Date(now.getTime() - 500 * DAY), deletedAt: new Date(now.getTime() - DAY) },
                ],
            },
        });
        expect(await expireViews({ ...repos, appIds: ['blog'], days: 396, trashDays: 30 })).toEqual({ blog: 1 });
        const rows = Object.fromEntries(repos.tables.get('blog').map((row) => [row.id, row]));
        expect(rows.old.deletedAt).toEqual(now);
        expect(rows.young.deletedAt).toBeNull();
        // Already in the trash: left to the trash's own clock.
        expect(rows['old-trashed'].deletedAt).toEqual(new Date(now.getTime() - DAY));
        expect(repos.adminLog[0]).toMatchObject({ action: ADMIN_ACTION.VIEWS_EXPIRED, appId: 'blog', targetCount: 1, targetIds: [] });
    });

    test('with the trash kept forever, views past the retention are erased at once, trashed or not', async () => {
        const now = new Date('2026-10-18T00:00:00Z');
        const repos = createMemoryRepos({
            now: () => now,
            views: {
                blog: [
                    { id: 'old', timestamp: new Date(now.getTime() - 400 * DAY), deletedAt: null },
                    { id: 'old-trashed', timestamp: new Date(now.getTime() - 500 * DAY), deletedAt: new Date(now.getTime() - DAY) },
                    { id: 'young', timestamp: new Date(now.getTime() - 10 * DAY), deletedAt: null },
                ],
            },
        });
        expect(await expireViews({ ...repos, appIds: ['blog'], days: 396, trashDays: 0 })).toEqual({ blog: 2 });
        expect(repos.tables.get('blog').map((row) => row.id)).toEqual(['young']);
    });

    test.each([0, -1, undefined])('a view retention of %s retires nothing', async (days) => {
        const repos = createMemoryRepos({ views: { blog: [{ id: 'x', timestamp: new Date(0), deletedAt: null }] } });
        expect(await expireViews({ ...repos, appIds: ['blog'], days, trashDays: 30 })).toEqual({});
        expect(repos.tables.get('blog')[0].deletedAt).toBeNull();
    });

    test('a failing app does not stop the others from retiring old views', async () => {
        const repos = createMemoryRepos({ views: { good: [{ id: 'x', timestamp: new Date(0), deletedAt: null }] } });
        const original = repos.adminRepo.expireOlderThan;
        repos.adminRepo.expireOlderThan = async (appId, ...rest) => {
            if (appId === 'bad') throw new TypeError('locked');
            return original(appId, ...rest);
        };
        expect(await expireViews({ ...repos, appIds: ['bad', 'good'], days: 1, trashDays: 30 })).toEqual({ good: 1 });
        expect(lines.join('\n')).toContain("Automatic retirement of old views failed for 'bad': locked");
    });

    test('the schedule retires old views before it empties the trash, so they wait their trash period', async () => {
        jest.useFakeTimers();
        try {
            const order = [];
            const adminRepo = {
                expireOlderThan: jest.fn(async () => { order.push('expire'); return 0; }),
                purgeExpired: jest.fn(async () => { order.push('purge'); return 0; }),
            };
            const logRepo = { pruneViewLog: jest.fn(async () => 0), writeAdminLog: async () => true };
            const stop = startRetention({ adminRepo, logRepo, getAppIds: () => ['a'], trashDays: 30, viewLogDays: 0, viewDays: 396, intervalMs: 1000 });
            await jest.advanceTimersByTimeAsync(0);
            expect(order).toEqual(['expire', 'purge']);
            expect(adminRepo.expireOlderThan).toHaveBeenCalledWith('a', 396, 30);
            stop();
        } finally {
            jest.useRealTimers();
        }
    });

    test('zero retention for both schedules nothing', () => {
        const adminRepo = { purgeExpired: jest.fn() };
        const logRepo = { pruneViewLog: jest.fn() };
        const stop = startRetention({ adminRepo, logRepo, getAppIds: () => ['a'], trashDays: 0, viewLogDays: 0 });
        expect(adminRepo.purgeExpired).not.toHaveBeenCalled();
        expect(logRepo.pruneViewLog).not.toHaveBeenCalled();
        expect(stop()).toBeUndefined();
    });

    test('each job runs on its own retention: view log only, with trash kept forever', async () => {
        jest.useFakeTimers();
        try {
            const adminRepo = { purgeExpired: jest.fn(async () => 0) };
            const logRepo = { pruneViewLog: jest.fn(async () => 0), writeAdminLog: async () => true };
            const stop = startRetention({ adminRepo, logRepo, getAppIds: () => ['a'], trashDays: 0, viewLogDays: 90, intervalMs: 1000 });
            await jest.advanceTimersByTimeAsync(0);
            expect(logRepo.pruneViewLog).toHaveBeenCalledWith(90);
            await jest.advanceTimersByTimeAsync(1000);
            expect(logRepo.pruneViewLog).toHaveBeenCalledTimes(2);
            expect(adminRepo.purgeExpired).not.toHaveBeenCalled();
            stop();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('pruneViewLog', () => {
    const DAY = 24 * 60 * 60 * 1000;

    test('removes entries older than the retention and records it as the system', async () => {
        let clock = new Date('2026-09-01T00:00:00Z');
        const repos = createMemoryRepos({ now: () => clock });
        await repos.logRepo.writeViewLog({ appId: 'blog', source: VIEW_LOG_SOURCE.REGISTER_VIEW, viewId: 'old', eventType: 'pageview', isUnique: true });
        clock = new Date(clock.getTime() + 91 * DAY);
        await repos.logRepo.writeViewLog({ appId: 'blog', source: VIEW_LOG_SOURCE.REGISTER_VIEW, viewId: 'new', eventType: 'pageview', isUnique: true });

        expect(await pruneViewLog({ logRepo: repos.logRepo, days: 90 })).toBe(1);
        expect(repos.viewLog.map((entry) => entry.viewId)).toEqual(['new']);
        expect(repos.adminLog).toHaveLength(1);
        expect(repos.adminLog[0]).toMatchObject({ action: ADMIN_ACTION.VIEW_LOG_PRUNED, targetCount: 1, sessionId: null, appId: null });
    });

    test('a run that removes nothing leaves no log entry', async () => {
        const repos = createMemoryRepos();
        await repos.logRepo.writeViewLog({ appId: 'blog', source: VIEW_LOG_SOURCE.REGISTER_VIEW, viewId: 'x', eventType: 'pageview', isUnique: true });
        expect(await pruneViewLog({ logRepo: repos.logRepo, days: 90 })).toBe(0);
        expect(repos.adminLog).toHaveLength(0);
    });

    test.each([0, -1, undefined])('retention of %s removes nothing', async (days) => {
        const logRepo = { pruneViewLog: jest.fn() };
        expect(await pruneViewLog({ logRepo, days })).toBe(0);
        expect(logRepo.pruneViewLog).not.toHaveBeenCalled();
    });

    test('a failure is reported, not thrown, so the next run can try again', async () => {
        const logRepo = { pruneViewLog: async () => { throw new TypeError('locked'); } };
        expect(await pruneViewLog({ logRepo, days: 90 })).toBe(0);
        expect(lines.join('\n')).toContain('Automatic view log pruning failed: locked');
    });
});

describe('one page load reported by both sides is one view', () => {
    const VIEW = '22222222-2222-4222-8222-222222222222';
    const MERGE_SELECT = 'SELECT id, public_id, is_unique, visitor_hash FROM `blog`';
    const isMergeSelect = (sql) => sql.trim().startsWith(MERGE_SELECT);
    const CHROME = { browser: 'Chrome', browserVersion: '141.0.0.0', os: 'macOS', osVersion: '15.6', deviceType: 'desktop' };
    const view = (overrides) => ({
        ip: '2a02:8109:b22a:a500:1111:2222:3333:4444', deviceSize: 'medium', pagePath: '/post', pageTitle: 'A post', sessionId: 's-1',
        ...CHROME, uniqueWindowHours: 24, visitorSecret: 'a'.repeat(64), mergeWindowSeconds: TRACKING.MERGE_WINDOW_SECONDS, ...overrides,
    });
    /** The address both reports store for the visitor above: the /64. */
    const MASKED = '2a02:8109:b22a:a500:0:0:0:0';

    /** A manager whose table holds `found` (or nothing) for the merge lookup, and whose claim succeeds `claimed` times. */
    const managerFinding = (found, { claimed = 1, seen = false } = {}) => {
        const manager = new DatabaseManager({ mode: 'connect' });
        let claims = claimed;
        manager.pool = createScriptedPool(withVisitorSalt((sql) => {
            if (isMergeSelect(sql)) return [found ? [found] : []];
            if (/^\s*SELECT id FROM `blog`/.test(sql)) return [seen ? [{ id: 1 }] : []];
            if (/^\s*UPDATE `blog`/.test(sql)) return [{ affectedRows: claims-- > 0 ? 1 : 0 }];
            if (sql.includes('INSERT INTO')) return [{ insertId: 9 }];
            return [[]];
        }));
        return manager;
    };
    const mergeSelect = (manager) => manager.pool.matching(MERGE_SELECT)[0];
    /** The tracker's own visitor hash, as the lookup bound it to prefer it. */
    const trackerHash = (manager) => mergeSelect(manager).params.at(-1);

    test('the same visitor is told by the masked address and the browser, null-safely, not by the hash', async () => {
        const manager = managerFinding(null);
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        const select = mergeSelect(manager);
        expect(select.sql).toMatch(/masked_ip = \? AND browser <=> \? AND browser_version <=> \? AND os <=> \?\s+AND os_version <=> \? AND device_type <=> \?/);
        expect(select.sql).not.toMatch(/WHERE visitor_hash = \?/);
        expect(select.params.slice(0, 9)).toEqual([MASKED, 'Chrome', '141.0.0.0', 'macOS', '15.6', 'desktop', COLLECTED_BY.EDGE, 'pageview', '/post']);
        // A view with the same hash breaks a tie, where there is one.
        expect(select.sql).toMatch(/ASC,\s+visitor_hash = \? DESC, id DESC/);
        expect(trackerHash(manager)).toMatch(/^[0-9a-f]{64}$/);
    });

    test('a browser the user agent does not name compares as NULL to NULL', async () => {
        const manager = managerFinding(null);
        await manager.registerEvent('blog', view({
            collectedBy: COLLECTED_BY.SCRIPT, browser: null, browserVersion: undefined, os: null, osVersion: null, deviceType: null,
        }));
        expect(mergeSelect(manager).params.slice(1, 6)).toEqual([null, null, null, null, null]);
    });

    test('the tracker\'s view completes the edge\'s, takes its hash, and returns its ID so engagement attaches to it', async () => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1, visitor_hash: 'e'.repeat(64) });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        expect(result).toEqual({ duplicate: false, insertId: 5, publicId: VIEW, isUnique: true, merged: true });

        const select = mergeSelect(manager);
        expect(select.sql).toContain(DatabaseManager.LIVE_ROW);
        expect(select.sql).toContain("SUBSTRING_INDEX(page_path, '#', 1) = ?");
        // Around when the page was loaded (now, without an age), the window either side.
        expect(select.sql).toContain('timestamp BETWEEN DATE_SUB(NOW(), INTERVAL ? SECOND) AND DATE_SUB(NOW(), INTERVAL ? SECOND)');
        // Nearest to the page's load first; the same hash only breaks a tie.
        expect(select.sql).toMatch(/ORDER BY ABS\(TIMESTAMPDIFF\(SECOND, timestamp, DATE_SUB\(NOW\(\), INTERVAL \? SECOND\)\)\) ASC,\s+visitor_hash = \? DESC, id DESC/);
        expect(select.params.slice(9)).toEqual([120, -120, 0, trackerHash(manager)]);

        // The hash changed, so uniqueness is decided again, for the new hash and without this view.
        const [seen] = manager.pool.matching('SELECT id FROM `blog`').filter((q) => q.sql.includes('id <> ?'));
        expect(seen.params).toEqual([trackerHash(manager), 'pageview', 24, 5]);

        const [update] = manager.pool.matching('UPDATE `blog`');
        expect(update.sql).toMatch(/SET collected_by = \?, page_path = \?, page_title = \?, devicesize = COALESCE\(\?, devicesize\), session_id = \?,\s+visitor_hash = \?, is_unique = \?/);
        expect(update.sql).toContain('WHERE id = ? AND collected_by = ?');
        expect(update.params).toEqual([COLLECTED_BY.BOTH, '/post', 'A post', 'medium', 's-1', trackerHash(manager), 1, 5, COLLECTED_BY.EDGE]);
        // No second view, and no second entry in the view log: no view was added.
        expect(manager.pool.matching('INSERT INTO')).toHaveLength(0);
    });

    test('a new hash already seen in the window makes the merged view a repeat, as the tracker\'s own view would be', async () => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1, visitor_hash: 'e'.repeat(64) }, { seen: true });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        expect(result).toMatchObject({ merged: true, duplicate: true, isUnique: false });
        expect(manager.pool.matching('UPDATE `blog`')[0].params[6]).toBe(0);
    });

    test('the same hash keeps the view\'s uniqueness as it was, without asking again', async () => {
        const manager = new DatabaseManager({ mode: 'connect' });
        manager.pool = createScriptedPool(withVisitorSalt((sql, params) => {
            if (isMergeSelect(sql)) return [[{ id: 5, public_id: VIEW, is_unique: 0, visitor_hash: params.at(-1) }]];
            if (/^\s*UPDATE `blog`/.test(sql)) return [{ affectedRows: 1 }];
            return [[]];
        }));
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        expect(result).toMatchObject({ merged: true, duplicate: true });
        expect(manager.pool.matching('id <> ?')).toHaveLength(0);
        expect(manager.pool.matching('UPDATE `blog`')[0].params[6]).toBe(0);
    });

    test('the edge\'s report after the tracker\'s only marks the view as seen by both, which keeps the tracker\'s hash', async () => {
        const manager = managerFinding({ id: 7, public_id: VIEW, is_unique: 0, visitor_hash: 's'.repeat(64) });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.EDGE, pageTitle: null, sessionId: null }));
        expect(result).toMatchObject({ merged: true, publicId: VIEW, duplicate: true, isUnique: false });
        const select = mergeSelect(manager);
        // The edge cannot know which view it follows: the newest in the window, its own hash breaking a tie.
        expect(select.sql).toContain('timestamp > DATE_SUB(NOW(), INTERVAL ? SECOND)');
        expect(select.sql).toContain('ORDER BY timestamp DESC, visitor_hash = ? DESC, id DESC');
        expect(select.params.slice(6)).toEqual([COLLECTED_BY.SCRIPT, 'pageview', '/post', 120, expect.stringMatching(/^[0-9a-f]{64}$/)]);
        const [update] = manager.pool.matching('UPDATE `blog`');
        expect(update.sql).toMatch(/SET collected_by = \? WHERE id = \? AND collected_by = \?/);
        expect(update.params).toEqual([COLLECTED_BY.BOTH, 7, COLLECTED_BY.SCRIPT]);
        expect(manager.pool.matching('INSERT INTO')).toHaveLength(0);
    });

    test('with nothing to merge into, the view is stored as the side that saw it', async () => {
        const manager = managerFinding(null);
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.EDGE }));
        expect(result.merged).toBe(false);
        const [insert] = manager.pool.matching('INSERT INTO `blog`');
        expect(insert.params.at(-1)).toBe(COLLECTED_BY.EDGE);
        expect(manager.pool.matching('INSERT INTO `_view_log`')).toHaveLength(1);
    });

    test('a view another report claimed first is not taken twice: this one is stored', async () => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1, visitor_hash: 'e'.repeat(64) }, { claimed: 0 });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        expect(result.merged).toBe(false);
        expect(result.publicId).not.toBe(VIEW);
        expect(manager.pool.matching('INSERT INTO `blog`')).toHaveLength(1);
    });

    test('a hash-routed page matches the edge\'s path without its fragment, and keeps the route', async () => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1, visitor_hash: 'e'.repeat(64) });
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pagePath: '/docs#spec/config' }));
        expect(mergeSelect(manager).params[8]).toBe('/docs');
        expect(manager.pool.matching('UPDATE `blog`')[0].params[1]).toBe('/docs#spec/config');
    });

    test.each([
        ['without a merge window', { mergeWindowSeconds: 0 }],
        ['for a custom event', { eventType: 'signup' }],
        ['without a page', { pagePath: undefined }],
        ['from a side that is neither', { collectedBy: COLLECTED_BY.BOTH }],
    ])('nothing is looked for %s', async (_label, overrides) => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1 });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, ...overrides }));
        expect(manager.pool.matching(MERGE_SELECT)).toHaveLength(0);
        expect(result.merged).toBe(false);
    });

    test('the tracker\'s view looks around when its page was loaded: the window either side of that, nearest first', async () => {
        const manager = managerFinding(null);
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 300 }));
        // From 420 to 180 seconds ago, nearest to 300 seconds ago: a load since then is never a candidate.
        const params = mergeSelect(manager).params;
        expect(params.slice(9, 12)).toEqual([420, 180, 300]);
    });

    test('a page just loaded looks as far forward as back, so a report from a slightly fast clock still counts', async () => {
        const manager = managerFinding(null);
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 2 }));
        const params = mergeSelect(manager).params;
        expect(params.slice(9, 12)).toEqual([122, -118, 2]);
    });

    /**
     * A table of edge views, answering the tracker side's merge lookup as its
     * SQL does: the same masked address and browser (NULL equal to NULL), the
     * same page, unmerged, within the bounds, and for an IPv4 address the same
     * hash; nearest to the page's load first, then the same hash, then
     * newest. Its uniqueness check, its claim, and the tracking log's update
     * work on the same rows.
     */
    function managerWithEdgeViews(views) {
        const rows = views.map((row) => ({ collected_by: COLLECTED_BY.EDGE, page_path: '/post', ...row }));
        const manager = new DatabaseManager({ mode: 'connect' });
        const same = (a, b) => (a ?? null) === (b ?? null);
        manager.pool = createScriptedPool(withVisitorSalt((sql, params) => {
            if (isMergeSelect(sql) && sql.includes('BETWEEN')) {
                const [maskedIp, browser, browserVersion, os, osVersion, deviceType, side, , path] = params;
                const required = sql.includes('AND visitor_hash = ?') ? params[9] : null;
                const [earliest, latest, anchor, hash] = params.slice(-4);
                const found = rows
                    .filter((row) => row.masked_ip === maskedIp && same(row.browser, browser) && same(row.browser_version, browserVersion)
                        && same(row.os, os) && same(row.os_version, osVersion) && same(row.device_type, deviceType)
                        && row.collected_by === side && row.page_path.split('#')[0] === path
                        && (required === null || row.visitor_hash === required)
                        && row.age <= earliest && row.age >= latest)
                    .sort((a, b) => Math.abs(a.age - anchor) - Math.abs(b.age - anchor)
                        || Number(b.visitor_hash === hash) - Number(a.visitor_hash === hash) || b.id - a.id);
                return [found.slice(0, 1)];
            }
            if (/^\s*SELECT id FROM `blog`/.test(sql)) {
                const [hash, , , exceptId] = params;
                return [rows.filter((row) => row.visitor_hash === hash && row.id !== exceptId).slice(0, 1)];
            }
            if (/^\s*UPDATE `blog`/.test(sql)) {
                const [side, path, , , , hash, isUnique, id, counterpart] = params;
                const row = rows.find((candidate) => candidate.id === id && candidate.collected_by === counterpart);
                if (!row) return [{ affectedRows: 0 }];
                Object.assign(row, { collected_by: side, page_path: path, visitor_hash: hash, is_unique: isUnique });
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO `blog`')) {
                rows.push({ id: rows.length + 100, collected_by: params.at(-1), visitor_hash: params[2] });
                return [{ insertId: rows.length + 99 }];
            }
            if (/^\s*UPDATE `_view_log` SET is_unique = \?/.test(sql)) {
                const [isUnique, appId, withinSeconds, viewId] = params;
                logUpdates.push({ isUnique, appId, withinSeconds, viewId });
                return [{ affectedRows: 1 }];
            }
            return [[]];
        }));
        const logUpdates = [];
        return { manager, rows, logUpdates };
    }
    const edgeView = (row) => ({ masked_ip: MASKED, browser: 'Chrome', browser_version: '141.0.0.0', os: 'macOS', os_version: '15.6',
        device_type: 'desktop', is_unique: 1, visitor_hash: 'e'.repeat(64), ...row });

    test('another IPv6 address of the same /64 and the same browser is the same visitor: one view, carrying the tracker\'s hash', async () => {
        const { manager, rows } = managerWithEdgeViews([edgeView({ id: 262, public_id: 'edge-262', age: 5 })]);
        // The page request left from one privacy address, the tracker's from another.
        const result = await manager.registerEvent('blog', view({
            collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 5, ip: '2a02:8109:b22a:a500:aaaa:bbbb:cccc:dddd',
        }));
        expect(result).toMatchObject({ merged: true, publicId: 'edge-262', isUnique: true });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ collected_by: COLLECTED_BY.BOTH, visitor_hash: trackerHash(manager), is_unique: 1 });
    });

    test.each([
        ['another /64', { masked_ip: '2a02:8109:b22a:a501:0:0:0:0' }],
        ['another browser version', { browser_version: '140.0.0.0' }],
        ['another system version', { os_version: '14.7' }],
        ['another device type', { device_type: 'tablet' }],
        ['a browser it does not name', { browser: null }],
        ['another page', { page_path: '/other' }],
        ['a view merged already', { collected_by: COLLECTED_BY.BOTH }],
    ])('%s is another visitor or view: nothing is merged', async (_label, row) => {
        const { manager, rows } = managerWithEdgeViews([edgeView({ id: 1, public_id: 'other', age: 5, ...row })]);
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 5 }));
        expect(result.merged).toBe(false);
        expect(rows).toHaveLength(2);
    });

    test('of two loads equally near, the one with the tracker\'s own hash breaks the tie', async () => {
        const { manager } = managerWithEdgeViews([]);
        // Learn the tracker's hash from a first lookup, then seed the table with it.
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 50, pagePath: '/seed' }));
        const hash = trackerHash(manager);
        const { manager: second } = managerWithEdgeViews([
            edgeView({ id: 1, public_id: 'same-hash', age: 50, visitor_hash: hash }),
            edgeView({ id: 2, public_id: 'newer', age: 50 }),
        ]);
        expect((await second.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 50 }))).publicId).toBe('same-hash');
    });

    test('two tabs of the same page: each tracker view finds its own page load, not the newest', async () => {
        const { manager } = managerWithEdgeViews([
            edgeView({ id: 1, public_id: 'tab-one', age: 200 }),
            edgeView({ id: 2, public_id: 'tab-two', is_unique: 0, age: 10 }),
        ]);
        expect((await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 199 }))).publicId).toBe('tab-one');
        expect((await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 9 }))).publicId).toBe('tab-two');
    });

    test('a view is merged at most once: a second tracker view of the same load is stored as its own', async () => {
        const { manager, rows } = managerWithEdgeViews([edgeView({ id: 1, public_id: 'only', age: 5 })]);
        expect((await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 5 }))).merged).toBe(true);
        expect((await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 5 }))).merged).toBe(false);
        expect(rows).toHaveLength(2);
    });

    test('a page load after the tracker\'s own is never taken for it', async () => {
        const { manager, rows } = managerWithEdgeViews([edgeView({ id: 3, public_id: 'later', age: 0 })]);
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pageAgeSeconds: 300 }));
        expect(result.merged).toBe(false);
        expect(rows).toHaveLength(2);
    });
});

describe('which page load a tracker view takes, and what the tracking log says after', () => {
    const CHROME = { browser: 'Chrome', browserVersion: '141.0.0.0', os: 'macOS', osVersion: '15.6', deviceType: 'desktop' };
    const tracker = (overrides) => ({
        deviceSize: 'medium', pagePath: '/post', pageTitle: 'A post', ...CHROME, collectedBy: COLLECTED_BY.SCRIPT,
        uniqueWindowHours: 24, visitorSecret: 'a'.repeat(64), mergeWindowSeconds: TRACKING.MERGE_WINDOW_SECONDS, ...overrides,
    });
    /** A manager over the given rows, answering as the SQL does, recording the merge lookups and log updates. */
    function managerOver(rows) {
        const manager = new DatabaseManager({ mode: 'connect' });
        const logUpdates = [];
        const same = (a, b) => (a ?? null) === (b ?? null);
        manager.pool = createScriptedPool(withVisitorSalt((sql, params) => {
            if (sql.trim().startsWith('SELECT id, public_id, is_unique, visitor_hash FROM `blog`')) {
                const [maskedIp, browser, browserVersion, os, osVersion, deviceType, side, , path] = params;
                const required = sql.includes('AND visitor_hash = ?') ? params[9] : null;
                const [earliest, latest, anchor, hash] = params.slice(-4);
                return [rows
                    .filter((row) => row.masked_ip === maskedIp && same(row.browser, browser) && same(row.browser_version, browserVersion)
                        && same(row.os, os) && same(row.os_version, osVersion) && same(row.device_type, deviceType)
                        && row.collected_by === side && row.page_path === path
                        && (required === null || row.visitor_hash === required) && row.age <= earliest && row.age >= latest)
                    .sort((a, b) => Math.abs(a.age - anchor) - Math.abs(b.age - anchor)
                        || Number(b.visitor_hash === hash) - Number(a.visitor_hash === hash) || b.id - a.id)
                    .slice(0, 1)];
            }
            if (/^\s*SELECT id FROM `blog`/.test(sql)) {
                const [hash, , , exceptId] = params;
                return [rows.filter((row) => row.visitor_hash === hash && row.id !== exceptId).slice(0, 1)];
            }
            if (/^\s*UPDATE `blog`/.test(sql)) {
                const [side, , , , , hash, isUnique, id, counterpart] = params;
                const row = rows.find((candidate) => candidate.id === id && candidate.collected_by === counterpart);
                if (!row) return [{ affectedRows: 0 }];
                Object.assign(row, { collected_by: side, visitor_hash: hash, is_unique: isUnique });
                return [{ affectedRows: 1 }];
            }
            if (/^\s*UPDATE `_view_log` SET is_unique = \?/.test(sql)) {
                logUpdates.push(params);
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO `blog`')) {
                rows.push({ id: 1000 + rows.length, collected_by: params.at(-1), visitor_hash: params[2], masked_ip: params[1] });
                return [{ insertId: 1000 + rows.length }];
            }
            return [[]];
        }));
        return { manager, logUpdates };
    }
    const edgeRow = (row) => ({ browser: 'Chrome', browser_version: '141.0.0.0', os: 'macOS', os_version: '15.6', device_type: 'desktop',
        collected_by: COLLECTED_BY.EDGE, page_path: '/post', is_unique: 1, ...row });
    /** The hash the tracker's view at `ip` carries, read from a lookup that finds nothing. */
    async function hashOf(ip) {
        const { manager } = managerOver([]);
        await manager.registerEvent('blog', tracker({ ip }));
        return manager.pool.matching('SELECT id, public_id, is_unique, visitor_hash FROM `blog`')[0].params.at(-1);
    }

    test('an IPv4 /24 is never one visitor: another address in it, with the same browser, is not merged', async () => {
        const rows = [edgeRow({ id: 1, public_id: 'neighbour', masked_ip: '203.0.113.0', visitor_hash: 'n'.repeat(64), age: 3 })];
        const { manager } = managerOver(rows);
        const result = await manager.registerEvent('blog', tracker({ ip: '203.0.113.77', pageAgeSeconds: 3 }));
        expect(result.merged).toBe(false);
        expect(rows[0].collected_by).toBe(COLLECTED_BY.EDGE);
        const select = manager.pool.matching('SELECT id, public_id, is_unique, visitor_hash FROM `blog`')[0];
        expect(select.sql).toContain("SUBSTRING_INDEX(page_path, '#', 1) = ? AND visitor_hash = ?");
    });

    test('an IPv4 view with the same hash merges as before', async () => {
        const hash = await hashOf('203.0.113.77');
        const rows = [edgeRow({ id: 1, public_id: 'same', masked_ip: '203.0.113.0', visitor_hash: hash, age: 3 })];
        const { manager } = managerOver(rows);
        expect((await manager.registerEvent('blog', tracker({ ip: '203.0.113.77', pageAgeSeconds: 3 }))).publicId).toBe('same');
    });

    test('an IPv4-mapped address is IPv4 too, and a /64 without a network is no network', () => {
        expect(DatabaseManager.isIPv6Network('203.0.113.0')).toBe(false);
        expect(DatabaseManager.isIPv6Network('::ffff:203.0.113.0')).toBe(false);
        expect(DatabaseManager.isIPv6Network('2a02:8109:b22a:a500:0:0:0:0')).toBe(true);
        expect(DatabaseManager.isIPv6Network(null)).toBe(false);
        // The unspecified /64 (from ::, ::1, ::1.2.3.4) and link-local ones (fe80::/10).
        expect(DatabaseManager.isIPv6Network('0:0:0:0:0:0:0:0')).toBe(false);
        expect(DatabaseManager.isIPv6Network('fe80:0:0:0:0:0:0:0')).toBe(false);
        expect(DatabaseManager.isIPv6Network('febf:0:0:0:0:0:0:0')).toBe(false);
        expect(DatabaseManager.isIPv6Network('fec0:0:0:0:0:0:0:0')).toBe(true);
    });

    test.each([['::1'], ['::'], ['::1.2.3.4'], ['fe80::1234:5678']])(
        'from %s, whose masked address carries no network, the hash must match', async (ip) => {
            const { manager } = managerOver([]);
            await manager.registerEvent('blog', tracker({ ip }));
            expect(manager.pool.matching('SELECT id, public_id, is_unique, visitor_hash FROM `blog`')[0].sql)
                .toContain("SUBSTRING_INDEX(page_path, '#', 1) = ? AND visitor_hash = ?");
        });

    test.each([
        ['a negative age', -50, [120, -120, 0]],
        ['an age beyond a day', 1e9, [86400 + 120, 86400 - 120, 86400]],
        ['an age that is no number', 'soon', [120, -120, 0]],
    ])('%s is bounded to 0 to a day, so the lookup never reaches ahead or far back', async (_label, pageAgeSeconds, bounds) => {
        const { manager } = managerOver([]);
        await manager.registerEvent('blog', tracker({ ip: '2a02:8109:b22a:a500:1:2:3:4', pageAgeSeconds }));
        expect(manager.pool.matching('SELECT id, public_id, is_unique, visitor_hash FROM `blog`')[0].params.slice(9, 12)).toEqual(bounds);
    });

    test('two tabs, where the other tab\'s load shares the tracker\'s hash: the nearest load still wins', async () => {
        const ip = '2a02:8109:b22a:a500:1:2:3:4';
        const hash = await hashOf(ip);
        const masked = '2a02:8109:b22a:a500:0:0:0:0';
        const rows = [
            edgeRow({ id: 1, public_id: 'tab-one', masked_ip: masked, visitor_hash: 'o'.repeat(64), age: 200 }),
            edgeRow({ id: 2, public_id: 'tab-two', masked_ip: masked, visitor_hash: hash, age: 10 }),
        ];
        const { manager } = managerOver(rows);
        expect((await manager.registerEvent('blog', tracker({ ip, pageAgeSeconds: 199 }))).publicId).toBe('tab-one');
        expect((await manager.registerEvent('blog', tracker({ ip, pageAgeSeconds: 9 }))).publicId).toBe('tab-two');
        expect(rows).toHaveLength(2);
    });

    test('a merge that turns a first view into a repeat says so in the tracking log', async () => {
        const ip = '2a02:8109:b22a:a500:1:2:3:4';
        const hash = await hashOf(ip);
        const masked = '2a02:8109:b22a:a500:0:0:0:0';
        // The tracker's hash already viewed a page today, so the edge's first view becomes a repeat.
        const rows = [
            edgeRow({ id: 1, public_id: 'edge-view', masked_ip: masked, visitor_hash: 'p'.repeat(64), age: 4 }),
            { id: 2, public_id: 'earlier', visitor_hash: hash, collected_by: COLLECTED_BY.BOTH, page_path: '/', masked_ip: masked, age: 3000 },
        ];
        const { manager, logUpdates } = managerOver(rows);
        const result = await manager.registerEvent('blog', tracker({ ip, pageAgeSeconds: 4 }));
        expect(result).toMatchObject({ merged: true, publicId: 'edge-view', isUnique: false });
        expect(logUpdates).toEqual([[0, 'blog', 4 + TRACKING.MERGE_WINDOW_SECONDS + 60, 'edge-view']]);
    });

    test('a merge that leaves the view as it was writes nothing to the log', async () => {
        const ip = '2a02:8109:b22a:a500:1:2:3:4';
        const rows = [edgeRow({ id: 1, public_id: 'edge-view', masked_ip: '2a02:8109:b22a:a500:0:0:0:0', visitor_hash: 'p'.repeat(64), age: 4 })];
        const { manager, logUpdates } = managerOver(rows);
        expect((await manager.registerEvent('blog', tracker({ ip, pageAgeSeconds: 4 }))).isUnique).toBe(true);
        expect(logUpdates).toEqual([]);
    });
});
