'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const config = require('./config');
const { db } = require('./db');
const realtime = require('./realtime');
const gps = require('./gps');
const recharge = require('./recharge');
const api = require('./api');

const app = express();
// nginx terminates https and talks plain http to us on loopback. Trusting only that
// proxy makes req.secure / req.ip reflect the real client and can't be spoofed by others.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups', // required by Google sign-in popup
  });
  next();
});

app.use('/api', express.json({ limit: '20kb' }), (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, api);

const pub = path.join(config.root, 'public');
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(pub, 'sw.js'));
});
// no-cache = always revalidate via ETag, so deploys are picked up immediately
app.use(express.static(pub, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error('[http] error:', err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

const server = http.createServer(app);
realtime.attach(server);

server.listen(config.webPort, config.webHost, () => {
  console.log(`[web] listening on http://${config.webHost}:${config.webPort}${config.publicUrl ? ` (public: ${config.publicUrl})` : ''}`);
  if (!config.googleClientId) console.warn('[web] GOOGLE_CLIENT_ID is not set - sign-in will not work');
  if (!config.mapsApiKey) console.warn('[web] GOOGLE_MAPS_API_KEY is not set - maps will show a developer-mode watermark / fail');
});

const gpsServer = gps.start();
recharge.start();

if (config.retentionDays > 0) {
  const prune = () => {
    const cutoff = new Date(Date.now() - config.retentionDays * 86400000).toISOString();
    const r = db.prepare('DELETE FROM positions WHERE time < ?').run(cutoff);
    if (r.changes) console.log(`[db] pruned ${r.changes} old positions`);
  };
  setTimeout(prune, 60000).unref();
  setInterval(prune, 24 * 3600 * 1000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`[sys] ${sig}, shutting down`); db.close(); process.exit(0); });
}

module.exports = { server, gpsServer };
