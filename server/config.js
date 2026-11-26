'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

const config = {
  root,
  webPort: int(process.env.WEB_PORT, 8080),
  // Listen on loopback by default: nginx is the only public entry point.
  webHost: process.env.WEB_HOST || '127.0.0.1',
  // Which proxies to trust for X-Forwarded-* (client IP, https detection).
  trustProxy: (() => {
    const v = process.env.TRUST_PROXY ?? 'loopback';
    if (v === 'true') return true;
    if (v === 'false') return false;
    return /^\d+$/.test(v) ? parseInt(v, 10) : v;
  })(),
  gpsPort: int(process.env.GPS_PORT, 8090),
  gpsProtocol: (process.env.GPS_PROTOCOL || 'GT06').toUpperCase(),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  mapId: process.env.GOOGLE_MAP_ID || 'DEMO_MAP_ID',
  adminEmails: list(process.env.ADMIN_EMAILS),
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  timezone: process.env.APP_TIMEZONE || 'Asia/Dhaka',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  dbPath: path.resolve(root, process.env.DB_PATH || './gps.db'),
  retentionDays: int(process.env.RETENTION_DAYS, 0),
  // Stop detection: staying put this long counts as a stop / a *long* stop
  minStopMinutes: int(process.env.MIN_STOP_MINUTES, 5),
  longStopMinutes: int(process.env.LONG_STOP_MINUTES, 60),
  sessionDays: 30,
};

try {
  new Intl.DateTimeFormat('en', { timeZone: config.timezone });
} catch {
  throw new Error(`Invalid APP_TIMEZONE: ${config.timezone}`);
}

module.exports = config;
