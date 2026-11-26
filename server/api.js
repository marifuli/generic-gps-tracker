'use strict';
const express = require('express');
const config = require('./config');
const { db, transaction } = require('./db');
const auth = require('./auth');
const push = require('./push');
const devices = require('./devices');
const recharge = require('./recharge');
const {
  normalizeSerial, validSerial, haversineMeters, dayRange, localDateTimeToIso, nextHeading, localNow, isDate, addDays,
} = require('./util');

const router = express.Router();
const { requireAuth, requireAdmin, httpError } = auth;

const authLimit = auth.rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const claimLimit = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: 20 });

const str = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Reject cross-site state-changing requests (defence in depth on top of SameSite=Lax).
router.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* invalid */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  next();
});

/* ------------------------------------------------------------------ public */

router.get('/config', (req, res) => {
  res.json({
    googleClientId: config.googleClientId,
    mapsApiKey: config.mapsApiKey,
    mapId: config.mapId,
    vapidPublicKey: push.publicKey,
    timezone: config.timezone,
    gpsPort: config.gpsPort,
    user: (() => { const u = auth.userFromRequest(req); return u ? auth.publicUser(u) : null; })(),
  });
});

router.post('/auth/google', async (req, res) => {
  if (!authLimit(req.ip)) throw httpError(429, 'Too many attempts, try again later');
  const g = await auth.verifyGoogleCredential(str(req.body?.credential, 5000));
  const user = auth.upsertUser(g);
  auth.setSessionCookie(req, res, auth.createSession(user.id));
  res.json({ user: auth.publicUser(user) });
});

router.post('/auth/logout', (req, res) => {
  auth.clearSession(req, res);
  res.json({ ok: true });
});

/* ------------------------------------------------------------ authenticated */

router.use(requireAuth);

router.get('/me', (req, res) => {
  res.json({ user: auth.publicUser(req.user), pushSubscriptions: push.count(req.user.id) });
});

/* ------------------------------------------------------------------ devices */

function ownedDevice(req) {
  const d = devices.byIdForUser.get(Number(req.params.id), req.user.id);
  if (!d) throw httpError(404, 'Device not found');
  return d;
}

router.get('/devices', (req, res) => res.json({ devices: devices.listForUser(req.user.id) }));

router.post('/devices', (req, res) => {
  if (!claimLimit(String(req.user.id))) throw httpError(429, 'Too many attempts, try again later');
  const raw = str(req.body?.serial, 40);
  if (!validSerial(raw)) throw httpError(400, 'Enter the serial / IMEI printed on the device (8-20 digits)');
  const serial = normalizeSerial(raw);
  const name = str(req.body?.name, 60) || 'My bike';

  const existing = devices.bySerial.get(serial);
  if (existing) {
    throw httpError(409, existing.user_id === req.user.id
      ? 'You have already added this device'
      : 'This serial is already registered to another account. Contact the administrator if this is a mistake.');
  }
  const info = db.prepare(
    'INSERT INTO devices (serial, user_id, name, sim_number, sim_operator) VALUES (?,?,?,?,?)',
  ).run(serial, req.user.id, name, str(req.body?.simNumber, 30) || null, str(req.body?.simOperator, 40) || null);
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ device: devices.toApi(row) });
});

router.patch('/devices/:id', (req, res) => {
  const d = ownedDevice(req);
  const b = req.body || {};
  const set = {};
  if (b.name !== undefined) { set.name = str(b.name, 60); if (!set.name) throw httpError(400, 'Name is required'); }
  if (b.simNumber !== undefined) set.sim_number = str(b.simNumber, 30) || null;
  if (b.simOperator !== undefined) set.sim_operator = str(b.simOperator, 40) || null;
  for (const [k, col] of [['notifyIgnition', 'notify_ignition'], ['notifyAlarms', 'notify_alarms'], ['notifyRecharge', 'notify_recharge']]) {
    if (b[k] !== undefined) set[col] = b[k] ? 1 : 0;
  }
  if (b.rechargeNotifyDays !== undefined) {
    if (!Array.isArray(b.rechargeNotifyDays)) throw httpError(400, 'rechargeNotifyDays must be a list');
    const days = [...new Set(b.rechargeNotifyDays.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 30).sort((a, c) => c - a);
    if (!days.length) throw httpError(400, 'Choose at least one reminder day (0-30)');
    set.recharge_notify_days = days.join(',');
  }
  const cols = Object.keys(set);
  if (cols.length) {
    db.prepare(`UPDATE devices SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...set, id: d.id });
  }
  res.json({ device: devices.toApi(db.prepare('SELECT * FROM devices WHERE id = ?').get(d.id)) });
});

// Removing a device deletes its stored track so a later owner never inherits it.
function deleteDevice(d) {
  transaction(() => {
    db.prepare('DELETE FROM positions WHERE imei = ?').run(d.serial);
    db.prepare('DELETE FROM devices WHERE id = ?').run(d.id); // cascades events/recharges
  });
}

router.delete('/devices/:id', (req, res) => {
  deleteDevice(ownedDevice(req));
  res.json({ ok: true });
});

const MAX_RANGE_MS = 31 * 86400000;
const trips = require('./trips');

router.get('/devices/:id/history', (req, res) => {
  const d = ownedDevice(req);
  let start, end, from, to;
  if (req.query.from || req.query.to) {
    // custom range: wall-clock times in the app timezone, `to` is inclusive of its minute
    start = localDateTimeToIso(req.query.from, config.timezone);
    const endMin = localDateTimeToIso(req.query.to, config.timezone);
    if (!start || !endMin) throw httpError(400, 'Use from/to as YYYY-MM-DDTHH:mm');
    end = new Date(Date.parse(endMin) + 60000).toISOString();
    if (end <= start) throw httpError(400, 'The end time must be after the start time');
    if (Date.parse(end) - Date.parse(start) > MAX_RANGE_MS) throw httpError(400, 'Choose a range of 31 days or less');
    from = req.query.from; to = req.query.to;
  } else {
    const date = isDate(req.query.date) ? req.query.date : localNow(config.timezone).date;
    ({ start, end } = dayRange(date, config.timezone));
    from = `${date}T00:00`; to = `${date}T23:59`;
  }
  const rows = db.prepare(`
    SELECT time, latitude, longitude, speed, course, satellites, ignition FROM positions
    WHERE imei = ? AND time >= ? AND time < ? ORDER BY time ASC
  `).all(d.serial, start, end);

  let distance = 0, maxSpeed = 0, moving = 0, ignitionOn = 0;
  const hs = {};
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    maxSpeed = Math.max(maxSpeed, r.speed || 0);
    r.course = nextHeading(hs, r.latitude, r.longitude, r.speed, r.course); // direction even when the tracker sends none
    if (i === 0) continue;
    const prev = rows[i - 1];
    const dt = (Date.parse(r.time) - Date.parse(prev.time)) / 1000;
    const dist = haversineMeters(prev, r);
    if (prev.ignition === 1 && dt > 0 && dt <= 300) ignitionOn += dt;
    // ignore GPS jitter while parked, and unreported jumps across a long silence
    if (dt <= trips.DEFAULTS.gapMin * 60 && (dist > 15 || (r.speed || 0) > 3)) {
      distance += dist;
      if (dt > 0 && dt <= 300) moving += dt;
    }
  }
  const { timeline, stops } = trips.analyze(rows, {
    minStopMin: config.minStopMinutes, longStopMin: config.longStopMinutes,
  });
  const MAX_POINTS = 4000;
  let points = rows;
  if (rows.length > MAX_POINTS) {
    const step = rows.length / MAX_POINTS;
    points = Array.from({ length: MAX_POINTS }, (_, i) => rows[Math.floor(i * step)]);
    points[points.length - 1] = rows[rows.length - 1];
  }
  const events = db.prepare(`
    SELECT id, type, message, time, latitude, longitude FROM events
    WHERE device_id = ? AND time >= ? AND time < ? ORDER BY time ASC
  `).all(d.id, start, end);

  res.json({
    from,
    to,
    points,
    events,
    timeline: timeline.map(({ firstIdx, lastIdx, ...t }) => t),
    stats: {
      pointCount: rows.length,
      distanceKm: Math.round(distance / 10) / 100,
      maxSpeed,
      movingMinutes: Math.round(moving / 60),
      ignitionMinutes: Math.round(ignitionOn / 60),
      stopCount: stops.length,
      parkedMinutes: stops.reduce((a, s) => a + s.durationMin, 0),
      longestStopMin: stops.reduce((a, s) => Math.max(a, s.durationMin), 0),
      start: rows[0]?.time ?? null,
      end: rows.at(-1)?.time ?? null,
    },
  });
});

router.get('/devices/:id/events', (req, res) => {
  const d = ownedDevice(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  res.json({
    events: db.prepare(
      'SELECT id, type, message, time, latitude, longitude FROM events WHERE device_id = ? ORDER BY time DESC LIMIT ?',
    ).all(d.id, limit),
  });
});

/* ----------------------------------------------------------------- recharge */

router.get('/devices/:id/recharges', (req, res) => {
  const d = ownedDevice(req);
  res.json({
    summary: recharge.summary(d.id),
    recharges: db.prepare(
      'SELECT id, amount, recharged_on AS rechargedOn, expires_on AS expiresOn, note FROM recharges WHERE device_id = ? ORDER BY recharged_on DESC, id DESC',
    ).all(d.id),
  });
});

router.post('/devices/:id/recharges', (req, res) => {
  const d = ownedDevice(req);
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) throw httpError(400, 'Enter a valid amount');
  const rechargedOn = isDate(b.rechargedOn) ? b.rechargedOn : localNow(config.timezone).date;

  let expiresOn;
  if (isDate(b.expiresOn)) expiresOn = b.expiresOn;
  else if (Number.isInteger(Number(b.validDays)) && Number(b.validDays) > 0 && Number(b.validDays) <= 3650) {
    // a 30-day pack bought today is valid through day 30 -> expires_on = recharge date + 29
    // (use the later of today and any still-running pack so stacked recharges extend, not overlap)
    const current = recharge.summary(d.id).expiresOn;
    const base = current && current >= rechargedOn ? addDays(current, Number(b.validDays)) : addDays(rechargedOn, Number(b.validDays) - 1);
    expiresOn = base;
  } else throw httpError(400, 'Provide validity in days or an expiry date');
  if (expiresOn < rechargedOn) throw httpError(400, 'Expiry cannot be before the recharge date');

  const info = db.prepare(
    'INSERT INTO recharges (device_id, amount, recharged_on, expires_on, note) VALUES (?,?,?,?,?)',
  ).run(d.id, amount, rechargedOn, expiresOn, str(b.note, 200) || null);
  res.status(201).json({
    id: info.lastInsertRowid,
    summary: recharge.summary(d.id),
  });
});

router.delete('/devices/:id/recharges/:rid', (req, res) => {
  const d = ownedDevice(req);
  const r = db.prepare('DELETE FROM recharges WHERE id = ? AND device_id = ?').run(Number(req.params.rid), d.id);
  if (!r.changes) throw httpError(404, 'Recharge not found');
  res.json({ summary: recharge.summary(d.id) });
});

/* --------------------------------------------------------------------- push */

router.post('/push/subscribe', (req, res) => {
  try { push.save(req.user.id, req.body?.subscription, req.headers['user-agent']); }
  catch (e) { throw httpError(400, e.message); }
  res.json({ ok: true, count: push.count(req.user.id) });
});

router.post('/push/unsubscribe', (req, res) => {
  push.remove(req.user.id, str(req.body?.endpoint, 1000));
  res.json({ ok: true, count: push.count(req.user.id) });
});

router.post('/push/test', async (req, res) => {
  const sent = await push.sendToUser(req.user.id, {
    title: 'Notifications are working',
    body: 'You will be alerted when your bike starts or stops, and before your SIM expires.',
    url: '/#/settings',
    tag: 'test',
  }, { urgency: 'normal', ttl: 300 });
  res.json({ sent });
});

/* -------------------------------------------------------------------- admin */

router.get('/admin/devices', requireAdmin, (req, res) => {
  res.json({
    devices: db.prepare(`
      SELECT d.id, d.serial, d.name, d.last_seen AS lastSeen, u.email AS ownerEmail
      FROM devices d JOIN users u ON u.id = d.user_id ORDER BY d.id
    `).all().map((d) => ({ ...d, online: devices.online.has(d.serial) })),
  });
});

router.delete('/admin/devices/:id', requireAdmin, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(req.params.id));
  if (!d) throw httpError(404, 'Device not found');
  deleteDevice(d);
  res.json({ ok: true });
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
