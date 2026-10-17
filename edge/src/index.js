/**
 * viewcounter edge Worker, the Workers entry point (an ES module, as Workers
 * want it). Everything it does is in counting.cjs: read that file for what is
 * counted, what is reported, and why nothing can touch the visitor's response.
 */

import counting from './counting.cjs';

export default {
    /**
     * @param {Request} request
     * @param {{ VIEWCOUNTER_URL?: string, SITES?: string, EDGE_SECRET?: string }} env
     * @param {{ waitUntil: (promise: Promise<unknown>) => void }} ctx
     * @returns {Promise<Response>}
     */
    fetch: (request, env, ctx) => counting.handle(request, env, ctx),
};
