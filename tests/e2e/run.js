#!/usr/bin/env node
/**
 * End-to-end verification against a real database.
 *
 * Boots the actual server as a subprocess, drives it over real HTTP, and then
 * inspects the rows it wrote by querying the database directly. Nothing here
 * uses the test mock — the point is to exercise what the mock cannot: real DDL,
 * real parameter binding, real strict-mode behaviour, real JSON columns.
 *
 * Deliberately NOT part of the Jest run: it needs a live database. Start one
 * with `docker compose -f docker-compose.e2e.yml up -d`, then `npm run test:e2e`.
 *
 * Usage: node tests/e2e/run.js <dbPort> <label> [--mode create|connect]
 *
 * NOTE: this runs the real server from the repo root, so a `dbInfo.json` or
 * `allowed.json` present on disk would take precedence over the environment
 * and hijack the run. The runner refuses to start if either exists.
 */

const { spawn } = require('child_process');
const path = require('path');
const mysql = require('mysql2/promise');

const RUN_DIR = path.join(__dirname, '..', '..');
const DB_PORT = process.argv[2];
const LABEL = process.argv[3] || 'db';
const DB_MODE = process.argv.includes('--mode')
    ? process.argv[process.argv.indexOf('--mode') + 1]
    : 'create';

const HTTP_PORT = 30300 + (Number(DB_PORT) % 100);
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const DB_NAME = `vc_e2e_${DB_MODE}`;

const READ_KEY_GLOBAL = 'g'.repeat(40);  // unscoped
const ADMIN_KEY = 'A'.repeat(40);
const VISITOR_SECRET = 'f'.repeat(64);

const RAW_IP = '203.0.113.77';           // the address we will send
const RAW_UA = 'Mozilla/5.0 (X11; Linux x86_64) DistinctiveFingerprint/1.0 Chrome/120.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
const failures = [];

function check(name, condition, detail = '') {
    if (condition) {
        pass++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } else {
        fail++;
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ''}`);
    }
}

const section = (t) => console.log(`\n\x1b[1m── ${t}\x1b[0m`);

async function req(method, urlPath, { key, body, headers = {} } = {}) {
    const opts = { method, headers: { ...headers } };
    if (key) opts.headers['x-api-key'] = key;
    if (body !== undefined) {
        opts.headers['content-type'] = 'application/json';
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${urlPath}`, opts);
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    return { status: res.status, body: json, headers: res.headers };
}

async function waitForHealth(proc, timeoutMs = 45000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (proc.exitCode !== null) throw new Error(`server exited early (code ${proc.exitCode})`);
        try {
            const res = await fetch(`${BASE}/health`);
            if (res.status === 200) return true;
        } catch { /* not listening yet */ }
        await new Promise(r => setTimeout(r, 400));
    }
    throw new Error('server did not become healthy in time');
}

async function main() {
    console.log(`\n\x1b[1m╔══ E2E: ${LABEL} (db mode: ${DB_MODE}) ══\x1b[0m`);

    // Config files beat environment variables, so a real one on disk would
    // silently point this run at the operator's actual database.
    const fs = require('fs');
    for (const f of ['dbInfo.json', 'allowed.json']) {
        if (fs.existsSync(path.join(RUN_DIR, f))) {
            console.error(`\x1b[31mRefusing to run: ${f} exists and would override the test environment.\x1b[0m`);
            console.error('Move it aside for the duration of the E2E run.');
            process.exit(2);
        }
    }

    // Fresh database each run so schema creation is genuinely exercised.
    const admin = await mysql.createConnection({
        host: '127.0.0.1', port: Number(DB_PORT), user: 'root', password: 'rootpw',
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    if (DB_MODE === 'connect') {
        // connect mode does not create the database, so pre-make it.
        await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
    }
    await admin.end();

    const env = {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(HTTP_PORT),
        LOG_LEVEL: 'warn',
        DB_MODE,
        DB_HOST: '127.0.0.1',
        DB_PORT,
        DB_NAME,
        DB_USER: 'vcuser',
        DB_PASSWORD: 'vcpass',
        ALLOWED_APP_IDS: 'tenant_a,tenant_b',
        CORS_ORIGINS: 'https://a.example,https://b.example',
        READ_API_KEYS: READ_KEY_GLOBAL,
        ADMIN_API_KEYS: ADMIN_KEY,
        VISITOR_SECRET,
        RATE_LIMIT_MAX: '100000',
        APP_RATE_LIMIT_MAX: '0',
        UNIQUE_VISITOR_WINDOW_HOURS: '24',
    };

    const proc = spawn('node', ['index.js'], { cwd: RUN_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const serverLog = [];
    proc.stdout.on('data', d => serverLog.push(d.toString()));
    proc.stderr.on('data', d => serverLog.push(d.toString()));

    let db;
    try {
        await waitForHealth(proc);
        console.log(`  server up on ${BASE}`);

        db = await mysql.createConnection({
            host: '127.0.0.1', port: Number(DB_PORT), user: 'root', password: 'rootpw', database: DB_NAME,
        });

        // In connect mode the app tables are not auto-created, so provision
        // them through the admin API — which is itself the thing under test.
        if (DB_MODE === 'connect') {
            for (const appId of ['tenant_a', 'tenant_b']) {
                await req('POST', '/apps', { key: ADMIN_KEY, body: { appId } });
            }
        }

        await verifySchema(db);
        await verifyWrites(db);
        await verifyPrivacyOnDisk(db);
        await verifyReads();
        await verifyAuthAndTenancy(db);
        await verifyBoundaries();
        await verifyProvisioning(db);
        await verifyStatementTimeout(db);
    } catch (err) {
        fail++;
        failures.push(`harness: ${err.message}`);
        console.log(`\n\x1b[31mHARNESS ERROR: ${err.message}\x1b[0m`);
        console.log(serverLog.join('').slice(-3000));
    } finally {
        if (db) await db.end();
        proc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 600));
        if (proc.exitCode === null) proc.kill('SIGKILL');
    }

    console.log(`\n\x1b[1m${LABEL}: ${pass} passed, ${fail} failed\x1b[0m`);
    if (failures.length) {
        console.log('\x1b[31mFailures:\x1b[0m');
        failures.forEach(f => console.log(`  - ${f}`));
    }
    process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

async function verifySchema(db) {
    section('Schema, as actually created by the server');

    const [cols] = await db.query(
        `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_a'`,
        [DB_NAME]
    );
    const byName = Object.fromEntries(cols.map(c => [c.COLUMN_NAME, c]));

    check('tenant_a table exists', cols.length > 0, `${cols.length} columns`);
    // The original M2 bug: getReferrerStats queried a column that never existed.
    check('source_type column EXISTS (regression: M2)', !!byName.source_type);
    check('source_type is VARCHAR(20)', byName.source_type?.CHARACTER_MAXIMUM_LENGTH === 20);
    check('visitor_hash is VARCHAR(64)', byName.visitor_hash?.CHARACTER_MAXIMUM_LENGTH === 64);
    check('masked_ip is VARCHAR(45)', byName.masked_ip?.CHARACTER_MAXIMUM_LENGTH === 45);
    check('page_path is VARCHAR(500)', byName.page_path?.CHARACTER_MAXIMUM_LENGTH === 500);
    check('browser_version is VARCHAR(20)', byName.browser_version?.CHARACTER_MAXIMUM_LENGTH === 20);
    check('event_data is JSON', ['json', 'longtext'].includes(byName.event_data?.DATA_TYPE));
    check('no raw `ip` column exists', !byName.ip);

    const [idx] = await db.query(
        `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_a'`, [DB_NAME]);
    const names = idx.map(i => i.INDEX_NAME);
    check('idx_source_type index created', names.includes('idx_source_type'));
    check('idx_visitor_timestamp index created', names.includes('idx_visitor_timestamp'));

    // The §8 fix: generated identity, natural key demoted to a constraint.
    const [appCols] = await db.query(
        `SELECT COLUMN_NAME, COLUMN_KEY, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = '_apps'`,
        [DB_NAME]
    );
    const appBy = Object.fromEntries(appCols.map(c => [c.COLUMN_NAME, c]));
    check('_apps registry table exists', appCols.length > 0);
    check('_apps.id is the PRIMARY KEY (§8)', appBy.id?.COLUMN_KEY === 'PRI');
    check('_apps.id is CHAR(36) for a UUID', appBy.id?.CHARACTER_MAXIMUM_LENGTH === 36);
    check('_apps.app_id is UNIQUE, not PRIMARY (§8)', appBy.app_id?.COLUMN_KEY === 'UNI');
}

async function verifyWrites(db) {
    section('Writes reach the database');

    const r1 = await req('GET',
        '/registerView?appId=tenant_a&deviceSize=large&page=/hello&title=Hello&referrer=https://www.google.com/search',
        { headers: { origin: 'https://a.example', 'user-agent': RAW_UA, 'x-forwarded-for': RAW_IP } });
    check('registerView returns 200', r1.status === 200, `got ${r1.status}`);
    check('first view is not a duplicate', r1.body?.duplicate === false);

    const [rows] = await db.query('SELECT * FROM `tenant_a` ORDER BY id DESC LIMIT 1');
    const row = rows[0];
    check('a row was actually inserted', !!row);
    check('page_path persisted', row?.page_path === '/hello');
    check('page_title persisted', row?.page_title === 'Hello');
    // source_type was computed then silently discarded before the fix.
    check('source_type persisted as "search" (regression: M2)', row?.source_type === 'search',
        `got ${JSON.stringify(row?.source_type)}`);
    check('referrer_domain parsed', row?.referrer_domain === 'www.google.com');
    check('browser parsed from UA', row?.browser === 'Chrome');
    check('is_unique set', row?.is_unique === 1);

    // Deduplication is a real round-trip through the visitor-hash index.
    const r2 = await req('GET', '/registerView?appId=tenant_a&deviceSize=large&page=/hello',
        { headers: { origin: 'https://a.example', 'user-agent': RAW_UA, 'x-forwarded-for': RAW_IP } });
    check('repeat view is flagged duplicate', r2.body?.duplicate === true);

    const [dupRows] = await db.query('SELECT is_unique FROM `tenant_a` ORDER BY id DESC LIMIT 1');
    check('duplicate row stored with is_unique = 0', dupRows[0]?.is_unique === 0);

    // JSON column round-trip.
    const ev = await req('POST', '/event', {
        headers: { origin: 'https://a.example', 'user-agent': RAW_UA },
        body: { appId: 'tenant_a', eventType: 'button_click', eventData: { button: 'subscribe', n: 42 }, sessionId: 'sess_e2e' },
    });
    check('POST /event returns 200', ev.status === 200, `got ${ev.status}`);

    const [evRows] = await db.query("SELECT event_type, event_data, session_id FROM `tenant_a` WHERE event_type = 'button_click' LIMIT 1");
    const stored = evRows[0];
    const parsed = typeof stored?.event_data === 'string' ? JSON.parse(stored.event_data) : stored?.event_data;
    check('event_data round-trips through the JSON column', parsed?.button === 'subscribe' && parsed?.n === 42,
        JSON.stringify(parsed));
    check('session_id persisted', stored?.session_id === 'sess_e2e');

    // Over-length derived values under STRICT mode: without truncation this is
    // MySQL error 1406 and a 500 rather than a stored row.
    const longUA = `Mozilla/5.0 ${'Chrome/1.1.1.1 '.repeat(30)}`;
    const longTitle = 'T'.repeat(199);
    const r3 = await req('GET',
        `/registerView?appId=tenant_a&deviceSize=large&page=/long&title=${encodeURIComponent(longTitle)}`,
        { headers: { origin: 'https://a.example', 'user-agent': longUA, 'x-forwarded-for': '198.51.100.9' } });
    check('over-length derived fields do not 500 under STRICT mode (M3)', r3.status === 200, `got ${r3.status}`);

    const [longRows] = await db.query("SELECT browser_version, page_title FROM `tenant_a` WHERE page_path = '/long' LIMIT 1");
    check('browser_version truncated to fit VARCHAR(20)', (longRows[0]?.browser_version || '').length <= 20,
        `len ${(longRows[0]?.browser_version || '').length}`);
}

async function verifyPrivacyOnDisk(db) {
    section('Privacy, verified against what is actually on disk');

    const [rows] = await db.query('SELECT * FROM `tenant_a`');
    const dump = JSON.stringify(rows);

    check('raw IP appears nowhere in the table', !dump.includes(RAW_IP));
    check('raw User-Agent appears nowhere in the table', !dump.includes('DistinctiveFingerprint'));

    const withIp = rows.filter(r => r.masked_ip);
    check('every masked_ip has a zeroed final octet',
        withIp.every(r => r.masked_ip.endsWith('.0') || r.masked_ip.endsWith(':0')),
        withIp.map(r => r.masked_ip).join(','));
    check('every visitor_hash is a 64-char hex digest',
        rows.every(r => /^[0-9a-f]{64}$/.test(r.visitor_hash)));

    // The hash must depend on the secret, not just public inputs.
    const crypto = require('crypto');
    const unkeyed = crypto.createHash('sha256')
        .update(`${RAW_IP}|${RAW_UA}|${new Date().toISOString().split('T')[0]}`).digest('hex');
    check('visitor_hash is NOT the old unkeyed digest (H2)',
        !rows.some(r => r.visitor_hash === unkeyed));

    // Same visitor, same window -> one hash; that is what dedup relies on.
    const sameVisitor = rows.filter(r => r.page_path === '/hello');
    check('same visitor yields a stable hash within the window',
        new Set(sameVisitor.map(r => r.visitor_hash)).size === 1);
}

async function verifyReads() {
    section('Read endpoints against real aggregates');

    const stats = await req('GET', '/stats/tenant_a', { key: READ_KEY_GLOBAL });
    check('GET /stats returns 200', stats.status === 200, `got ${stats.status}`);
    check('totalViews is a real count', typeof stats.body?.stats?.totalViews === 'number' && stats.body.stats.totalViews > 0,
        JSON.stringify(stats.body?.stats?.totalViews));
    check('uniqueVisitors computed', typeof stats.body?.stats?.uniqueVisitors === 'number');
    check('byCountry aggregate returns', Array.isArray(stats.body?.stats?.byCountry));

    // getReferrerStats is the endpoint that was broken on every real deploy.
    const ref = await req('GET', '/referrers/tenant_a', { key: READ_KEY_GLOBAL });
    check('GET /referrers returns 200 (regression: M2 was a hard 500)', ref.status === 200, `got ${ref.status}`);
    check('bySource groups by source_type', Array.isArray(ref.body?.bySource) && ref.body.bySource.length > 0,
        JSON.stringify(ref.body?.bySource));

    // LIMIT ? binding: a string here is a MySQL syntax error.
    for (const lim of [1, 5, 100]) {
        const v = await req('GET', `/views/tenant_a?limit=${lim}&offset=0`, { key: READ_KEY_GLOBAL });
        check(`GET /views?limit=${lim} binds LIMIT correctly`, v.status === 200, `got ${v.status}`);
    }
    const paged = await req('GET', '/views/tenant_a?limit=1&offset=0', { key: READ_KEY_GLOBAL });
    check('limit is actually applied by the database', paged.body?.views?.length === 1,
        `got ${paged.body?.views?.length}`);
    check('views never expose visitor_hash', !JSON.stringify(paged.body || {}).includes('visitor_hash'));

    // INTERVAL ? DAY plus the three DATE_FORMAT group-bys.
    for (const period of ['hourly', 'daily', 'weekly']) {
        const t = await req('GET', `/trends/tenant_a?period=${period}&days=7`, { key: READ_KEY_GLOBAL });
        check(`GET /trends?period=${period} executes`, t.status === 200, `got ${t.status}`);
        check(`  ${period} returns grouped rows`, Array.isArray(t.body?.trends));
    }

    const browsers = await req('GET', '/browsers/tenant_a', { key: READ_KEY_GLOBAL });
    check('GET /browsers returns 200', browsers.status === 200);
    check('byBrowser aggregate populated', browsers.body?.byBrowser?.length > 0);

    const pages = await req('GET', '/pages/tenant_a?limit=10', { key: READ_KEY_GLOBAL });
    check('GET /pages returns 200', pages.status === 200);
    check('page aggregate populated', pages.body?.pages?.length > 0);

    // SESSION_COLUMNS must match the real table or this is a 1054.
    const sess = await req('GET', '/sessions/tenant_a/sess_e2e', { key: READ_KEY_GLOBAL });
    check('GET /sessions returns 200 (column list matches schema)', sess.status === 200, `got ${sess.status}`);
    check('session events returned', sess.body?.events?.length > 0);
    check('sessions never expose visitor_hash (H1)', !JSON.stringify(sess.body || {}).includes('visitor_hash'));
    check('sessions never expose masked_ip (H1)', !JSON.stringify(sess.body || {}).includes('masked_ip'));

    check('read responses are marked no-store (L8)',
        (await req('GET', '/stats/tenant_a', { key: READ_KEY_GLOBAL })).headers.get('cache-control')?.includes('no-store'));
}

async function verifyAuthAndTenancy(db) {
    section('Authentication and cross-tenant isolation');

    for (const p of ['/stats/tenant_a', '/views/tenant_a', '/apps', '/sessions/tenant_a/sess_e2e']) {
        check(`${p} rejects an unauthenticated caller`, (await req('GET', p)).status === 401);
    }
    check('a wrong key is rejected', (await req('GET', '/stats/tenant_a', { key: 'wrong' })).status === 401);

    // Provision a scoped key by writing allowed.json into the running tree is
    // not possible mid-run, so scope is exercised via the unscoped key plus the
    // dedicated multiTenancy unit suite. Here we prove the admin/read split.
    check('an admin key cannot read analytics',
        (await req('GET', '/stats/tenant_a', { key: ADMIN_KEY })).status === 401);
    check('a read key cannot provision',
        (await req('POST', '/apps', { key: READ_KEY_GLOBAL, body: { appId: 'nope' } })).status === 401);

    // Writing to tenant_b must not be visible in tenant_a's table.
    await req('GET', '/registerView?appId=tenant_b&deviceSize=small',
        { headers: { origin: 'https://b.example', 'user-agent': RAW_UA } });
    const [aRows] = await db.query('SELECT COUNT(*) c FROM `tenant_a`');
    const [bRows] = await db.query('SELECT COUNT(*) c FROM `tenant_b`');
    check('tenants write to physically separate tables',
        aRows[0].c > 0 && bRows[0].c === 1, `a=${aRows[0].c} b=${bRows[0].c}`);
}

async function verifyBoundaries() {
    section('Boundary validation against the real server');

    const bad = [
        ['/views/tenant_a?limit=abc', 'limit=abc'],
        ['/views/tenant_a?limit=-1', 'limit=-1'],
        ['/views/tenant_a?limit=999999999999', 'limit=huge'],
        ['/trends/tenant_a?days=abc', 'days=abc'],
        ['/pages/tenant_a?limit=0', 'limit=0'],
    ];
    for (const [p, label] of bad) {
        const r = await req('GET', p, { key: READ_KEY_GLOBAL });
        check(`${label} rejected with 422 (never a 500)`, r.status === 422, `got ${r.status}`);
    }

    for (const appId of ['tenant_a`; DROP TABLE tenant_b; --', '_apps', 'nonexistent']) {
        const r = await req('GET', `/registerView?appId=${encodeURIComponent(appId)}&deviceSize=large`,
            { headers: { origin: 'https://a.example' } });
        check(`injection-shaped appId rejected: ${appId.slice(0, 22)}`, r.status === 422, `got ${r.status}`);
    }

    const over = await req('POST', '/event', {
        headers: { origin: 'https://a.example' },
        body: { appId: 'tenant_a', eventType: 'x', eventData: { blob: 'x'.repeat(5000) } },
    });
    check('oversized eventData rejected with 422', over.status === 422, `got ${over.status}`);

    // The error path must not echo database detail.
    const err = await req('GET', '/stats/tenant_a?limit=1', { key: READ_KEY_GLOBAL });
    check('successful read carries no SQL detail', !JSON.stringify(err.body).match(/SELECT|FROM `/i));
}

async function verifyProvisioning(db) {
    section('Runtime tenant provisioning against real DDL');

    const created = await req('POST', '/apps', {
        key: ADMIN_KEY,
        body: { appId: 'runtime_tenant', origins: ['https://runtime.example'] },
    });
    check('POST /apps returns 200', created.status === 200, `got ${created.status}`);
    check('reports created: true', created.body?.created === true);

    const [tbl] = await db.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'runtime_tenant'`,
        [DB_NAME]);
    check('the table was really created by the DDL', tbl.length === 1);

    const [reg] = await db.query('SELECT id, app_id, origins FROM `_apps` WHERE app_id = ?', ['runtime_tenant']);
    check('registry row written', reg.length === 1);
    check('registry id is a UUID, not the app name (§8)',
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reg[0]?.id || ''), reg[0]?.id);
    check('registry id differs from app_id (§8)', reg[0]?.id !== reg[0]?.app_id);

    // The whole point: usable immediately, no restart.
    const write = await req('GET', '/registerView?appId=runtime_tenant&deviceSize=large',
        { headers: { origin: 'https://runtime.example', 'user-agent': RAW_UA } });
    check('new tenant accepts traffic with no restart', write.status === 200, `got ${write.status}`);

    const [newRows] = await db.query('SELECT COUNT(*) c FROM `runtime_tenant`');
    check('the view landed in the new table', newRows[0].c === 1);

    const wrongOrigin = await req('GET', '/registerView?appId=runtime_tenant&deviceSize=large',
        { headers: { origin: 'https://attacker.example' } });
    check('origin binding applies to the new tenant', wrongOrigin.status === 403, `got ${wrongOrigin.status}`);

    const again = await req('POST', '/apps', { key: ADMIN_KEY, body: { appId: 'runtime_tenant' } });
    check('re-registration is idempotent', again.status === 200 && again.body?.created === false);

    for (const appId of ['_evil', 'bad id', 'x`; DROP TABLE tenant_a; --']) {
        const r = await req('POST', '/apps', { key: ADMIN_KEY, body: { appId } });
        check(`unsafe appId refused: ${appId.slice(0, 20)}`, r.status === 422, `got ${r.status}`);
    }
    const [stillThere] = await db.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tenant_a'`, [DB_NAME]);
    check('tenant_a survived the injection attempts', stillThere.length === 1);
}

async function verifyStatementTimeout(db) {
    section('Statement timeout / engine compatibility');

    // MySQL supports MAX_EXECUTION_TIME; MariaDB does not, and the code is
    // supposed to swallow that rather than fail to start.
    let supported = false;
    try {
        await db.query('SET SESSION MAX_EXECUTION_TIME = 5000');
        supported = true;
    } catch { supported = false; }

    console.log(`  (engine ${supported ? 'supports' : 'does NOT support'} MAX_EXECUTION_TIME)`);
    const health = await req('GET', '/health');
    check('server healthy regardless of timeout support', health.status === 200 && health.body?.status === 'healthy');
}

main().catch(err => {
    console.error('fatal:', err);
    process.exit(1);
});
