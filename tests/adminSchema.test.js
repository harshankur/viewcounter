/**
 * Admin schema migration, trash retention, and the DatabaseManager changes
 * that came with them, asserted at the SQL level.
 */

const {
    ADMIN_LOG_DDL,
    VIEW_LOG_DDL,
    ADMIN_INDEXES,
    backfillPublicIds,
    ensureLogTables,
    migrateAppTable,
} = require('../db/adminSchema');
const DatabaseManager = require('../db/DatabaseManager');
const { purgeExpiredTrash, pruneViewLog, startRetention } = require('../db/retention');
const { ADMIN_ACTION, DATABASE, VIEW_LOG_SOURCE } = require('../constants');
const logger = require('../utils/logger');
const { createScriptedPool } = require('./support/scriptedPool');
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

    test('an already migrated table is read and left alone', async () => {
        const pool = legacyTablePool({
            columns: ['id', 'public_id', 'note', 'admin_modified_at', 'deleted_at'],
            indexes: ['PRIMARY', ...Object.keys(ADMIN_INDEXES)],
        });
        expect(await migrateAppTable(pool, 'blog')).toEqual({ migrated: true, backfilled: 0 });
        expect(pool.matching('ALTER TABLE')).toHaveLength(0);
        expect(pool.matching('UPDATE')).toHaveLength(0);
    });

    test('a nullable public_id left by an interrupted migration is tightened', async () => {
        const pool = legacyTablePool({
            columns: ['id', 'public_id', 'note', 'admin_modified_at', 'deleted_at'],
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

    test('backfillPublicIds returns zero when every row already has an ID', async () => {
        const pool = legacyTablePool({ pending: 0 });
        expect(await backfillPublicIds(pool, 'blog')).toBe(0);
    });
});

describe('log table DDL', () => {
    test('ensureLogTables creates both tables', async () => {
        const pool = createScriptedPool();
        await ensureLogTables(pool);
        expect(pool.queries.map((q) => q.sql)).toEqual([ADMIN_LOG_DDL, VIEW_LOG_DDL]);
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
        manager.pool = createScriptedPool(respond);
        return manager;
    };

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
        expect(log.params.slice(1)).toEqual(['blog', VIEW_LOG_SOURCE.EVENT, result.publicId, 'click', 1]);
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
        expect(manager.pool.matching('information_schema.COLUMNS')).toHaveLength(2);
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
