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
const { purgeExpiredTrash, pruneViewLog, startRetention } = require('../db/retention');
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
    const isMergeSelect = (sql) => /^\s*SELECT id, public_id, is_unique FROM `blog`/.test(sql);
    const view = (overrides) => ({
        ip: '203.0.113.5', deviceSize: 'medium', pagePath: '/post', pageTitle: 'A post', sessionId: 's-1',
        uniqueWindowHours: 24, visitorSecret: 'a'.repeat(64), mergeWindowSeconds: TRACKING.MERGE_WINDOW_SECONDS, ...overrides,
    });
    /** A manager whose table holds `found` (or nothing) for the merge lookup, and whose claim succeeds `claimed` times. */
    const managerFinding = (found, { claimed = 1 } = {}) => {
        const manager = new DatabaseManager({ mode: 'connect' });
        let claims = claimed;
        manager.pool = createScriptedPool(withVisitorSalt((sql) => {
            if (isMergeSelect(sql)) return [found ? [found] : []];
            if (/^\s*UPDATE `blog`/.test(sql)) return [{ affectedRows: claims-- > 0 ? 1 : 0 }];
            if (sql.includes('INSERT INTO')) return [{ insertId: 9 }];
            return [[]];
        }));
        return manager;
    };

    test('the tracker\'s view completes the edge\'s, and returns its ID so engagement attaches to it', async () => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1 });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        expect(result).toEqual({ duplicate: false, insertId: 5, publicId: VIEW, isUnique: true, merged: true });

        const [select] = manager.pool.matching('SELECT id, public_id, is_unique FROM `blog`');
        expect(select.sql).toContain(DatabaseManager.LIVE_ROW);
        expect(select.sql).toContain('timestamp > DATE_SUB(NOW(), INTERVAL ? SECOND)');
        expect(select.sql).toContain("SUBSTRING_INDEX(page_path, '#', 1) = ?");
        expect(select.sql).toContain('ORDER BY id DESC');
        expect(select.params).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), COLLECTED_BY.EDGE, 'pageview', 120, '/post']);

        const [update] = manager.pool.matching('UPDATE `blog`');
        expect(update.sql).toContain('SET collected_by = ?, page_path = ?, page_title = ?, devicesize = COALESCE(?, devicesize), session_id = ?');
        expect(update.sql).toContain('WHERE id = ? AND collected_by = ?');
        expect(update.params).toEqual([COLLECTED_BY.BOTH, '/post', 'A post', 'medium', 's-1', 5, COLLECTED_BY.EDGE]);
        // No second view, and no second entry in the view log: no view was added.
        expect(manager.pool.matching('INSERT INTO')).toHaveLength(0);
    });

    test('the edge\'s report after the tracker\'s only marks the view as seen by both', async () => {
        const manager = managerFinding({ id: 7, public_id: VIEW, is_unique: 0 });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.EDGE, pageTitle: null, sessionId: null }));
        expect(result).toMatchObject({ merged: true, publicId: VIEW, duplicate: true, isUnique: false });
        expect(manager.pool.matching('SELECT id, public_id, is_unique FROM `blog`')[0].params[1]).toBe(COLLECTED_BY.SCRIPT);
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
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1 }, { claimed: 0 });
        const result = await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT }));
        expect(result.merged).toBe(false);
        expect(result.publicId).not.toBe(VIEW);
        expect(manager.pool.matching('INSERT INTO `blog`')).toHaveLength(1);
    });

    test('a hash-routed page matches the edge\'s path without its fragment, and keeps the route', async () => {
        const manager = managerFinding({ id: 5, public_id: VIEW, is_unique: 1 });
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, pagePath: '/docs#spec/config' }));
        expect(manager.pool.matching('SELECT id, public_id, is_unique FROM `blog`')[0].params.at(-1)).toBe('/docs');
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
        expect(manager.pool.matching('SELECT id, public_id, is_unique')).toHaveLength(0);
        expect(result.merged).toBe(false);
    });

    test('the window is the caller\'s: the route widens it by how long the page had been open', async () => {
        const manager = managerFinding(null);
        await manager.registerEvent('blog', view({ collectedBy: COLLECTED_BY.SCRIPT, mergeWindowSeconds: 420 }));
        expect(manager.pool.matching('SELECT id, public_id, is_unique FROM `blog`')[0].params[3]).toBe(420);
    });
});
