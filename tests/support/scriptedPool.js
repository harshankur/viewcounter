/**
 * A mysql2-shaped pool that records every statement and answers from a script.
 *
 * `respond(sql, params)` returns the value `pool.query` resolves to, or throws
 * to simulate a database error. Returning undefined yields `[[]]`, an empty
 * result set.
 */
function createScriptedPool(respond = () => undefined) {
    const queries = [];
    return {
        queries,
        async query(sql, params = []) {
            queries.push({ sql, params });
            const result = await respond(sql, params);
            return result === undefined ? [[]] : result;
        },
        /** Statements whose SQL contains `fragment`, case-insensitively. */
        matching(fragment) {
            const needle = fragment.toLowerCase();
            return queries.filter((q) => q.sql.toLowerCase().includes(needle));
        },
    };
}

/** A DatabaseManager-shaped holder for a repository under test. */
function dbWith(pool) {
    return { pool, assertReady() {} };
}

module.exports = { createScriptedPool, dbWith };
