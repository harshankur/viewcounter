/**
 * AdminRepository and LogRepository, asserted at the SQL level.
 *
 * These check the statements and bound parameters the repositories issue.
 * Whether MySQL accepts them is checked against real engines in tests/e2e.
 */

const AdminRepository = require('../db/AdminRepository');
const LogRepository = require('../db/LogRepository');
const { ADMIN_ACTION, ADMIN_LOG_TABLE, VIEW_LOG_TABLE, VIEW_LOG_SOURCE } = require('../constants');
const logger = require('../utils/logger');
const { createScriptedPool, dbWith } = require('./support/scriptedPool');

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('AdminRepository', () => {
    describe('listViews', () => {
        const run = async (query, rows = []) => {
            const pool = createScriptedPool((sql) => (sql.includes('COUNT(*)') ? [[{ count: 7 }]] : [rows]));
            const repo = new AdminRepository(dbWith(pool));
            const result = await repo.listViews('blog', {
                status: 'active', modified: 'any', search: '', sort: 'timestamp', order: 'desc', page: 1, pageSize: 25,
                ...query,
            });
            return { pool, result, select: pool.queries[0], count: pool.queries[1] };
        };

        test.each([
            ['active', 'deleted_at IS NULL'],
            ['deleted', 'deleted_at IS NOT NULL'],
            ['all', '1 = 1'],
        ])('status %s filters with %s', async (status, condition) => {
            const { select, count } = await run({ status });
            expect(select.sql).toContain(`WHERE ${condition}`);
            expect(count.sql).toContain(`WHERE ${condition}`);
        });

        test('an unknown status falls back to active rows', async () => {
            const { select } = await run({ status: 'bogus' });
            expect(select.sql).toContain('WHERE deleted_at IS NULL');
        });

        test.each([
            ['modified', 'admin_modified_at IS NOT NULL'],
            ['unmodified', 'admin_modified_at IS NULL'],
        ])('modified filter %s adds %s', async (modified, condition) => {
            const { select } = await run({ modified });
            expect(select.sql).toContain(condition);
        });

        test('searching binds an escaped LIKE pattern, never interpolates it', async () => {
            const { select, count } = await run({ search: "50%_off'" });
            expect(select.sql).not.toContain('50%');
            expect(select.params).toContain('%50\\%\\_off\'%');
            expect(select.params[0]).toBe('blog');
            expect(select.params[1]).toBe("50%_off'");
            expect(count.params).toEqual(select.params.slice(1, -2));
        });

        test('sorts by an allowlisted column and falls back for anything else', async () => {
            expect((await run({ sort: 'page', order: 'asc' })).select.sql).toContain('ORDER BY page_path ASC');
            expect((await run({ sort: 'visitor_hash; DROP TABLE x' })).select.sql).toContain('ORDER BY timestamp DESC');
        });

        test('pages with bound LIMIT and OFFSET', async () => {
            const { select } = await run({ page: 3, pageSize: 50 });
            expect(select.params.slice(-2)).toEqual([50, 100]);
        });

        test('never selects the visitor hash or the internal row number', async () => {
            const { select } = await run({});
            const columns = select.sql.slice(select.sql.indexOf('SELECT') + 6, select.sql.indexOf('FROM'));
            expect(columns).not.toContain('visitor_hash');
            expect(columns.split(',').map((c) => c.trim())).not.toContain('id');
        });

        test('maps rows to the API shape', async () => {
            const { result } = await run({}, [{
                public_id: ID_A, timestamp: 't', masked_ip: '1.2.3.0', country: 'DE', devicesize: 'large',
                page_path: '/', page_title: 'Home', referrer: null, referrer_domain: null, source_type: 'direct',
                browser: 'Chrome', browser_version: '1', os: 'macOS', os_version: '15', device_type: 'desktop',
                session_id: 's', event_type: 'pageview', event_data: '{"a":1}', is_unique: 1,
                note: 'n', admin_modified_at: null, deleted_at: null,
            }]);
            expect(result.total).toBe(7);
            expect(result.views[0]).toMatchObject({ id: ID_A, deviceSize: 'large', eventData: { a: 1 }, isUnique: true, note: 'n' });
        });

        test('refuses an invalid app id before any query', async () => {
            const pool = createScriptedPool();
            const repo = new AdminRepository(dbWith(pool));
            await expect(repo.listViews('bad`id', {})).rejects.toMatchObject({ code: 'INVALID_APP_ID' });
            expect(pool.queries).toHaveLength(0);
        });
    });

    describe('mutations', () => {
        const withMatches = (matched) => {
            const pool = createScriptedPool((sql) => (sql.startsWith('SELECT public_id')
                ? [matched.map((id) => ({ public_id: id }))]
                : [{ affectedRows: matched.length }]));
            return { pool, repo: new AdminRepository(dbWith(pool)) };
        };

        test('updateContent writes only allowlisted columns and marks rows modified', async () => {
            const { pool, repo } = withMatches([ID_A]);
            const changed = await repo.updateContent('blog', [ID_A, ID_B], { page_title: 'T', devicesize: 'small' });
            expect(changed).toEqual([ID_A]);
            const update = pool.matching('UPDATE')[0];
            expect(update.sql).toContain('`page_title` = ?, `devicesize` = ?, admin_modified_at = NOW()');
            expect(update.sql).toContain('deleted_at IS NULL');
            expect(update.params).toEqual(['T', 'small', [ID_A]]);
            expect(pool.queries[0].sql).toContain('deleted_at IS NULL');
        });

        test.each(['masked_ip', 'visitor_hash', 'timestamp', 'country', 'browser', 'deleted_at', 'admin_modified_at', 'note'])(
            'updateContent refuses to write %s', async (column) => {
                const { pool, repo } = withMatches([ID_A]);
                await expect(repo.updateContent('blog', [ID_A], { [column]: 'x' }))
                    .rejects.toMatchObject({ code: 'FIELD_NOT_WRITABLE' });
                expect(pool.queries).toHaveLength(0);
            });

        test('updateContent issues no UPDATE when nothing matches', async () => {
            const { pool, repo } = withMatches([]);
            expect(await repo.updateContent('blog', [ID_A], { page_title: 'T' })).toEqual([]);
            expect(pool.matching('UPDATE')).toHaveLength(0);
        });

        test('updateContent with no columns changes nothing', async () => {
            const { pool, repo } = withMatches([ID_A]);
            expect(await repo.updateContent('blog', [ID_A], {})).toEqual([]);
            expect(pool.matching('UPDATE')).toHaveLength(0);
        });

        test('setNote does not mark rows modified and applies to trashed rows too', async () => {
            const { pool, repo } = withMatches([ID_A]);
            await repo.setNote('blog', [ID_A], 'hello');
            const update = pool.matching('UPDATE')[0];
            expect(update.sql).toContain('SET note = ?');
            expect(update.sql).not.toContain('admin_modified_at');
            expect(pool.queries[0].sql).toContain('1 = 1');
            expect(update.params).toEqual(['hello', [ID_A]]);
        });

        test.each([
            ['softDelete', 'deleted_at IS NULL', 'SET deleted_at = NOW()'],
            ['restore', 'deleted_at IS NOT NULL', 'SET deleted_at = NULL'],
            ['purge', 'deleted_at IS NOT NULL', 'DELETE FROM'],
        ])('%s requires %s and issues %s', async (operation, state, statement) => {
            const { pool, repo } = withMatches([ID_A]);
            expect(await repo[operation]('blog', [ID_A])).toEqual([ID_A]);
            expect(pool.queries[0].sql).toContain(state);
            expect(pool.queries[1].sql).toContain(statement);
            expect(pool.queries[1].sql).toContain(state);
        });

        test.each(['setNote', 'softDelete', 'restore', 'purge'])('%s issues no write when nothing matches', async (operation) => {
            const { pool, repo } = withMatches([]);
            expect(await repo[operation]('blog', [ID_A], null)).toEqual([]);
            expect(pool.queries).toHaveLength(1);
        });

        test('matchIds issues no query for an empty list', async () => {
            const { pool, repo } = withMatches([]);
            expect(await repo.matchIds('blog', [], 'x')).toEqual([]);
            expect(pool.queries).toHaveLength(0);
        });

        test('purgeExpired erases only trashed rows older than the retention', async () => {
            const pool = createScriptedPool(() => [{ affectedRows: 4 }]);
            const repo = new AdminRepository(dbWith(pool));
            expect(await repo.purgeExpired('blog', 30)).toBe(4);
            expect(pool.queries[0].sql).toContain('deleted_at IS NOT NULL AND deleted_at < DATE_SUB(NOW(), INTERVAL ? DAY)');
            expect(pool.queries[0].params).toEqual([30]);
        });

        test('purgeExpired treats a missing affectedRows as zero', async () => {
            const pool = createScriptedPool(() => [{}]);
            expect(await new AdminRepository(dbWith(pool)).purgeExpired('blog', 30)).toBe(0);
        });
    });

    describe('summarizeApps', () => {
        test('counts active, deleted, and modified rows per app', async () => {
            const pool = createScriptedPool(() => [[{ active: '5', deleted: '2', modified: '1' }]]);
            const repo = new AdminRepository(dbWith(pool));
            expect(await repo.summarizeApps(['blog'])).toEqual([
                { appId: 'blog', active: 5, deleted: 2, modified: 1, available: true },
            ]);
        });

        test('an app whose table is missing is reported as unavailable, not dropped', async () => {
            const pool = createScriptedPool(() => { throw new TypeError("Table 'x' doesn't exist"); });
            const repo = new AdminRepository(dbWith(pool));
            expect(await repo.summarizeApps(['blog'])).toEqual([
                { appId: 'blog', active: 0, deleted: 0, modified: 0, available: false },
            ]);
        });

        test('an empty table sums to zero, not NaN', async () => {
            const pool = createScriptedPool(() => [[{ active: null, deleted: null, modified: null }]]);
            const [summary] = await new AdminRepository(dbWith(pool)).summarizeApps(['blog']);
            expect(summary).toMatchObject({ active: 0, deleted: 0, modified: 0 });
        });
    });

    test('escapeLike escapes backslash, percent, and underscore', () => {
        expect(AdminRepository.escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
    });

    test('the pool getter asserts the database is ready', () => {
        const repo = new AdminRepository({ pool: null, assertReady() { throw new TypeError('not ready'); } });
        expect(() => repo.pool).toThrow('not ready');
    });
});

describe('LogRepository', () => {
    let lines;
    beforeEach(() => {
        lines = [];
        logger.configure({ level: logger.LogLevel.DEBUG, writer: (line) => lines.push(line) });
    });
    afterEach(() => logger.configure({ level: logger.LogLevel.SILENT, writer: () => {} }));

    test('writeAdminLog binds every value, IDs and fields as JSON', async () => {
        const pool = createScriptedPool();
        const repo = new LogRepository(dbWith(pool));
        expect(await repo.writeAdminLog({
            action: ADMIN_ACTION.VIEWS_EDITED, sessionId: 's', maskedIp: '1.2.3.0', appId: 'blog',
            targetIds: [ID_A], fields: ['pageTitle'],
        })).toBe(true);
        const [insert] = pool.queries;
        expect(insert.sql).toContain(`INSERT INTO \`${ADMIN_LOG_TABLE}\``);
        expect(insert.params.slice(1)).toEqual([ADMIN_ACTION.VIEWS_EDITED, 's', '1.2.3.0', 'blog', 1, `["${ID_A}"]`, '["pageTitle"]']);
        expect(insert.params[0]).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('writeAdminLog stores NULL for no targets and accepts an explicit count', async () => {
        const pool = createScriptedPool();
        await new LogRepository(dbWith(pool)).writeAdminLog({ action: ADMIN_ACTION.TRASH_AUTO_PURGED, targetCount: 9 });
        expect(pool.queries[0].params.slice(1)).toEqual([ADMIN_ACTION.TRASH_AUTO_PURGED, null, null, null, 9, null, null]);
    });

    test('a failed admin-log write warns and returns false instead of throwing', async () => {
        const pool = createScriptedPool(() => { throw new TypeError('disk full'); });
        expect(await new LogRepository(dbWith(pool)).writeAdminLog({ action: 'x' })).toBe(false);
        expect(lines.join('\n')).toContain("Could not write the admin operation log entry 'x': disk full");
    });

    test('writeViewLog records source, view, type, and uniqueness only', async () => {
        const pool = createScriptedPool();
        await new LogRepository(dbWith(pool)).writeViewLog({
            appId: 'blog', source: VIEW_LOG_SOURCE.REGISTER_VIEW, viewId: ID_A, eventType: 'pageview', isUnique: false,
        });
        const [insert] = pool.queries;
        expect(insert.sql).toContain(`INSERT INTO \`${VIEW_LOG_TABLE}\``);
        expect(insert.params.slice(1)).toEqual(['blog', VIEW_LOG_SOURCE.REGISTER_VIEW, ID_A, 'pageview', 0]);
    });

    test('a failed view-log write warns and returns false instead of throwing', async () => {
        const pool = createScriptedPool(() => { throw new TypeError('gone'); });
        expect(await new LogRepository(dbWith(pool)).writeViewLog({ appId: 'blog' })).toBe(false);
        expect(lines.join('\n')).toContain("Could not write the view register log entry for 'blog': gone");
    });

    test('listAdminLog filters, pages, and maps rows', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('COUNT(*)') ? [[{ count: 3 }]] : [[{
            id: 'e', created_at: 't', action: 'a', session_id: 's', masked_ip: 'm', app_id: 'blog',
            target_count: 1, target_ids: `["${ID_A}"]`, fields: null,
        }]]));
        const result = await new LogRepository(dbWith(pool)).listAdminLog({ page: 2, pageSize: 25, action: 'a', appId: 'blog' });
        expect(pool.queries[0].sql).toContain('WHERE action = ? AND app_id = ?');
        expect(pool.queries[0].params).toEqual(['a', 'blog', 25, 25]);
        expect(result).toEqual({
            entries: [{ id: 'e', createdAt: 't', action: 'a', sessionId: 's', maskedIp: 'm', appId: 'blog', targetCount: 1, targetIds: [ID_A], fields: [] }],
            total: 3,
        });
    });

    test('listAdminLog without filters has no WHERE clause', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('COUNT(*)') ? [[{ count: 0 }]] : [[]]));
        const result = await new LogRepository(dbWith(pool)).listAdminLog({ page: 1, pageSize: 25 });
        expect(pool.queries[0].sql).not.toContain('WHERE');
        expect(result.total).toBe(0);
    });

    test('listViewLog filters, pages, and maps rows', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('COUNT(*)') ? [[{ count: 1 }]] : [[{
            id: 'v', created_at: 't', app_id: 'blog', source: 'event', view_id: ID_A, event_type: 'click', is_unique: 1,
        }]]));
        const result = await new LogRepository(dbWith(pool)).listViewLog({ page: 1, pageSize: 50, appId: 'blog', source: 'event' });
        expect(pool.queries[0].sql).toContain('WHERE app_id = ? AND source = ?');
        expect(result.entries[0]).toEqual({ id: 'v', createdAt: 't', appId: 'blog', source: 'event', viewId: ID_A, eventType: 'click', isUnique: true });
    });

    test('listViewLog without filters has no WHERE clause', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('COUNT(*)') ? [[{}]] : [[]]));
        const result = await new LogRepository(dbWith(pool)).listViewLog({ page: 1, pageSize: 50 });
        expect(pool.queries[0].sql).not.toContain('WHERE');
        expect(result.total).toBe(0);
    });

    test.each([
        [null, null],
        [undefined, null],
        [{ a: 1 }, { a: 1 }],
        ['[1,2]', [1, 2]],
        ['{broken', null],
    ])('parseJson(%j) is %j', (input, expected) => {
        expect(LogRepository.parseJson(input)).toEqual(expected);
    });
});
