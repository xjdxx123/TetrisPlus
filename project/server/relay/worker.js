// Cloudflare Workers entrypoint for the relay service.
//
// Routes:
//   POST /matches          → create a match DO + return matchId
//   POST /matches/:id/init → initialize the DO (called by matchmaking
//                             service after pairing)
//   GET  /matches/:id/ws   → WebSocket upgrade — forwarded to the
//                             matching DO's fetch handler
//
// All real protocol work happens inside the MatchRelay DO; this Worker
// is just the URL router + DO ID resolver.

export { MatchRelay } from './match-relay.js';

export default {
  /**
   * @param {Request} request
   * @param {{ MATCH_RELAY: DurableObjectNamespace }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /matches → create a new match DO ID + return it. Real
    // matchmaking service will follow up with /matches/:id/init.
    if (request.method === 'POST' && path === '/matches') {
      const id = env.MATCH_RELAY.newUniqueId();
      return new Response(JSON.stringify({ matchId: id.toString() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // POST /matches/:id/init — forward to the DO.
    const initMatch = path.match(/^\/matches\/([^/]+)\/init$/);
    if (request.method === 'POST' && initMatch) {
      const stub = env.MATCH_RELAY.get(env.MATCH_RELAY.idFromString(initMatch[1]));
      return stub.fetch(request);
    }

    // GET /matches/:id/ws — WS upgrade, forward to the DO.
    const wsMatch = path.match(/^\/matches\/([^/]+)\/ws$/);
    if (request.method === 'GET' && wsMatch) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket upgrade', { status: 400 });
      }
      const stub = env.MATCH_RELAY.get(env.MATCH_RELAY.idFromString(wsMatch[1]));
      return stub.fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
};
