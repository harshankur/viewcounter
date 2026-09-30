/**
 * Test servers listen on 127.0.0.1, the address their requests go to.
 *
 * listen(0) with no address binds the wildcard address. macOS lets a wildcard
 * listener take a port another program already holds on 127.0.0.1 (an
 * editor's helper, say), and a request to 127.0.0.1 then reaches that
 * program instead of the test's server: a stray 400, or a hang until the test
 * times out. A listener on 127.0.0.1 itself is only ever given a port that is
 * free there.
 */

const LOOPBACK = '127.0.0.1';

/**
 * Start a server on a free loopback port.
 * @param {{ listen: Function }} app an Express app or an http.Server
 * @returns {Promise<import('http').Server>} once it is listening
 */
function listenOnLoopback(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, LOOPBACK);
        server.once('listening', () => resolve(server));
        server.once('error', reject);
    });
}

module.exports = { LOOPBACK, listenOnLoopback };
