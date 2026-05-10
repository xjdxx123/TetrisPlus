// Local-development WebSocket relay server.
//
// Same protocol as the Cloudflare Workers Durable Object relay
// (`server/relay/match-relay.js`), but runs in plain Node so you
// can spin it up on your laptop without deploying anything:
//
//   pnpm install   # picks up `ws` devDep
//   npm run relay  # starts the server on port 8787
//
// Then open the game in any two browsers (Chrome + Firefox + Edge,
// any combo, any device on the same LAN), pick "Online Versus" mode
// in both, type the same lobby code, press Connect — they'll find
// each other through this server.
//
// Each unique lobby code becomes a separate "room" — the server
// relays messages between the two clients in that room. No
// authentication, no persistence, no ELO; pure relay. When you're
// ready to ship, swap to the Cloudflare Workers DO (which uses the
// same protocol).

import { WebSocketServer } from 'ws';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const PATH_RE = /^\/lobby\/([A-Z0-9]{1,16})$/i;

const wss = new WebSocketServer({ port: PORT, path: undefined });

/** Map<roomCode, Set<WebSocket>> */
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, `http://${req.headers.host}`);
  const m    = url.pathname.match(PATH_RE);
  if (!m) {
    ws.close(1008, 'expected /lobby/<CODE>');
    return;
  }
  const room = m[1].toUpperCase();
  if (!rooms.has(room)) rooms.set(room, new Set());
  const peers = rooms.get(room);

  if (peers.size >= 2) {
    ws.send(JSON.stringify({ t: 'error', code: 'ROOM_FULL', message: 'lobby already has two players' }));
    ws.close(1008, 'room full');
    return;
  }
  peers.add(ws);
  console.log(`[relay] join ${room} (${peers.size}/2)`);

  ws.on('message', (data) => {
    // Relay verbatim to every OTHER socket in the room. We don't
    // parse the protocol here — the relay is dumb, the clients
    // are smart. (Cloudflare DO does light validation; the local
    // dev relay skips it for simplicity.)
    const text = data.toString();
    for (const peer of peers) {
      if (peer === ws) continue;
      if (peer.readyState !== peer.OPEN) continue;
      try { peer.send(text); }
      catch (err) { console.warn('[relay] send threw:', err.message); }
    }
  });

  ws.on('close', () => {
    peers.delete(ws);
    console.log(`[relay] leave ${room} (${peers.size}/2)`);
    if (peers.size === 0) rooms.delete(room);
    else {
      // Tell the survivor their peer dropped.
      for (const peer of peers) {
        try { peer.send(JSON.stringify({ t: 'error', code: 'PEER_DISCONNECTED', message: 'opponent disconnected' })); }
        catch { /* ignore */ }
      }
    }
  });

  ws.on('error', (err) => {
    console.warn('[relay] socket error:', err.message);
  });
});

wss.on('listening', () => {
  console.log(`[relay] listening on ws://localhost:${PORT}`);
  console.log(`        connect via:  ws://localhost:${PORT}/lobby/<CODE>`);
  console.log('        Ctrl-C to stop.');
});

wss.on('error', (err) => {
  console.error('[relay] server error:', err);
  process.exit(1);
});
