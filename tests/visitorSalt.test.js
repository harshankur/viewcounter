/**
 * The per-window visitor salt: what makes a hash impossible to recompute once
 * its window is over, even for whoever holds the server secret.
 */

const DatabaseManager = require('../db/DatabaseManager');
const PrivacyUtils = require('../utils/privacyUtils');
const { createVisitorSaltStore } = require('../db/visitorSalt');
const { ensureLogTables } = require('../db/adminSchema');
const { createScriptedPool } = require('./support/scriptedPool');
const { TEST_VISITOR_SECRET } = require('./jestSetup');

const HOUR = 60 * 60 * 1000;
const HEX_64 = /^[0-9a-f]{64}$/;

/** A pool that keeps the salts table as MySQL would. */
function saltPool() {
    const rows = new Map();
    const pool = createScriptedPool((sql, params) => {
        if (!sql.includes('`_visitor_salts`')) return undefined;
        const key = `${params[0]}:${params[1]}`;
        if (sql.includes('INSERT IGNORE')) {
            if (!rows.has(key)) rows.set(key, params[2]);
            return [{ affectedRows: 1 }];
        }
        if (/^\s*SELECT/.test(sql)) return [rows.has(key) ? [{ salt: rows.get(key) }] : []];
        if (/^\s*DELETE/.test(sql)) {
            // Same window length, another window: over. (Other lengths go by age, which MySQL judges.)
            for (const other of [...rows.keys()]) if (other !== key && other.startsWith(`${params[0]}:`)) rows.delete(other);
            return [{ affectedRows: 0 }];
        }
        return undefined;
    });
    return { pool, rows };
}

describe('the visitor salt store', () => {
    test('creates one random salt for the window and keeps serving it without asking again', async () => {
        const { pool, rows } = saltPool();
        const store = createVisitorSaltStore(() => pool);
        const now = Date.UTC(2026, 9, 8, 10);
        const salt = await store.current(24, now);
        expect(salt).toMatch(HEX_64);
        expect([...rows.values()]).toEqual([salt]);
        const asked = pool.queries.length;
        expect(await store.current(24, now + 5 * HOUR)).toBe(salt);
        expect(pool.queries).toHaveLength(asked);
    });

    test('the salt already in the database wins, so a restart or a second instance tells the same visitors apart', async () => {
        const { pool } = saltPool();
        const now = Date.UTC(2026, 9, 8, 10);
        const first = await createVisitorSaltStore(() => pool).current(24, now);
        const afterRestart = await createVisitorSaltStore(() => pool).current(24, now + HOUR);
        expect(afterRestart).toBe(first);
    });

    test('a new window gets a new salt, and the old one is deleted for good', async () => {
        const { pool, rows } = saltPool();
        const store = createVisitorSaltStore(() => pool);
        const monday = Date.UTC(2026, 9, 5, 10);
        const first = await store.current(24, monday);
        const second = await store.current(24, monday + 24 * HOUR);
        expect(second).toMatch(HEX_64);
        expect(second).not.toBe(first);
        expect([...rows.values()]).toEqual([second]);
        const [, , deletion] = pool.matching('`_visitor_salts`').slice(-3);
        expect(deletion.sql).toMatch(/^DELETE FROM `_visitor_salts`\s+WHERE \(rotation_hours = \? AND window_id <> \?\)/);
        // A row of another window length is only removed once its own window has run out.
        expect(deletion.sql).toContain('(rotation_hours <> ? AND created_at < DATE_SUB(NOW(), INTERVAL rotation_hours HOUR))');
        expect(deletion.params).toEqual([24, PrivacyUtils.currentWindowId(24, monday + 24 * HOUR), 24]);
    });

    test('simultaneous first requests of a window share one read', async () => {
        const { pool } = saltPool();
        const store = createVisitorSaltStore(() => pool);
        const now = Date.UTC(2026, 9, 8, 10);
        const salts = await Promise.all([store.current(24, now), store.current(24, now), store.current(24, now)]);
        expect(new Set(salts).size).toBe(1);
        expect(pool.matching('INSERT IGNORE')).toHaveLength(1);
    });

    test('the window follows the unique-visitor setting, and is never shorter than an hour', async () => {
        const { pool } = saltPool();
        const store = createVisitorSaltStore(() => pool);
        const now = Date.UTC(2026, 9, 8, 10, 30);
        await store.current(0, now);
        expect(pool.matching('INSERT IGNORE')[0].params.slice(0, 2)).toEqual([1, PrivacyUtils.currentWindowId(1, now)]);
        await store.current(72, now);
        expect(pool.matching('INSERT IGNORE')[1].params.slice(0, 2)).toEqual([72, PrivacyUtils.currentWindowId(72, now)]);
    });

    test.each([
        ['no row comes back', () => [[]]],
        ['the stored value is not a salt', () => [[{ salt: 'short' }]]],
        ['the driver answers with something else', () => [{ insertId: 1 }]],
    ])('fails closed when %s, and tries again next time', async (_, select) => {
        let broken = true;
        const { pool } = saltPool();
        const query = pool.query.bind(pool);
        pool.query = async (sql, params) => (broken && /^\s*SELECT salt/.test(sql) ? select() : query(sql, params));
        const store = createVisitorSaltStore(() => pool);
        await expect(store.current(24)).rejects.toThrow();
        broken = false;
        await expect(store.current(24)).resolves.toMatch(HEX_64);
    });
});

describe('PrivacyUtils.generateVisitorHash with a salt', () => {
    const now = Date.UTC(2026, 9, 8, 10);
    const hash = (salt) => PrivacyUtils.generateVisitorHash('203.0.113.5', 'Mozilla/5.0', TEST_VISITOR_SECRET, 24, now, salt);

    test('the salt is part of the hash: without yesterday\'s salt, yesterday\'s hash cannot be made again', () => {
        expect(hash('1'.repeat(64))).toMatch(HEX_64);
        expect(hash('1'.repeat(64))).toBe(hash('1'.repeat(64)));
        expect(hash('1'.repeat(64))).not.toBe(hash('2'.repeat(64)));
        expect(hash('1'.repeat(64))).not.toBe(hash(''));
    });

    test('without a salt it is the hash it always was', () => {
        expect(hash()).toBe(PrivacyUtils.generateVisitorHash('203.0.113.5', 'Mozilla/5.0', TEST_VISITOR_SECRET, 24, now));
    });
});

describe('DatabaseManager.registerEvent', () => {
    function manager() {
        const { pool, rows } = saltPool();
        const db = new DatabaseManager({ mode: 'connect' });
        const answer = pool.query.bind(pool);
        pool.query = async (sql, params) => (sql.includes('`_visitor_salts`') ? answer(sql, params) : (pool.queries.push({ sql, params }), [{ insertId: 1 }]));
        db.pool = pool;
        return { db, pool, rows };
    }
    const view = { ip: '203.0.113.5', userAgent: 'Mozilla/5.0', deviceSize: 'large', uniqueWindowHours: 0, visitorSecret: TEST_VISITOR_SECRET };

    test('stores the salted hash, never the one the secret alone would give', async () => {
        const { db, pool, rows } = manager();
        await db.registerEvent('blog', view);
        const [salt] = [...rows.values()];
        const [insert] = pool.matching('INSERT INTO `blog`');
        const now = Date.now();
        const salted = PrivacyUtils.generateVisitorHash(view.ip, view.userAgent, TEST_VISITOR_SECRET, 0, now, salt);
        const unsalted = PrivacyUtils.generateVisitorHash(view.ip, view.userAgent, TEST_VISITOR_SECRET, 0, now);
        expect(insert.params).toContain(salted);
        expect(insert.params).not.toContain(unsalted);
        // The salt itself goes nowhere but its own table.
        for (const query of pool.queries.filter((q) => !q.sql.includes('`_visitor_salts`'))) expect(query.params).not.toContain(salt);
    });

    test('the same visitor gets the same hash for the whole window', async () => {
        const { db, pool } = manager();
        await db.registerEvent('blog', view);
        await db.registerEvent('blog', view);
        const [a, b] = pool.matching('INSERT INTO `blog`').map((q) => q.params.find((p) => HEX_64.test(String(p))));
        expect(a).toBe(b);
    });

    test('without a server secret nothing is asked of the database at all', async () => {
        const { db, pool } = manager();
        await expect(db.registerEvent('blog', { ...view, visitorSecret: '' })).rejects.toThrow();
        expect(pool.queries).toHaveLength(0);
    });
});

describe('the schema', () => {
    test('the salts table is created with the other service tables', async () => {
        const pool = createScriptedPool((sql) => (sql.includes('information_schema') ? [[]] : undefined));
        await ensureLogTables(pool);
        const [ddl] = pool.matching('CREATE TABLE IF NOT EXISTS `_visitor_salts`');
        expect(ddl.sql).toContain('PRIMARY KEY (`rotation_hours`, `window_id`)');
        expect(ddl.sql).toContain('`salt` CHAR(64) NOT NULL');
    });
});
