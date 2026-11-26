'use strict';
const { WebSocketServer, WebSocket } = require('ws');
const { userFromRequest } = require('./auth');

const clients = new Map(); // userId -> Set<ws>

function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();

    // Block cross-site WebSocket hijacking: browser Origin must be our own host.
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* ignore */ }
      if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    }
    const user = userFromRequest(req);
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.userId = user.id;
      if (!clients.has(user.id)) clients.set(user.id, new Set());
      clients.get(user.id).add(ws);
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', () => {}); // client is receive-only
      ws.on('close', () => {
        clients.get(user.id)?.delete(ws);
        if (!clients.get(user.id)?.size) clients.delete(user.id);
      });
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'hello' }));
    });
  });

  setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30000).unref();
}

function publish(userId, message) {
  const set = clients.get(userId);
  if (!set) return;
  const data = JSON.stringify(message);
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

module.exports = { attach, publish };
