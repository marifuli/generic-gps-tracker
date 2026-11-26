'use strict';
// End-to-end: real HTTP API + WebSocket + GT06 TCP tracker simulator, against a throwaway database.
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpstest-'));
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'), WEB_PORT: '18080', GPS_PORT: '18090', APP_TIMEZONE: 'Asia/Dhaka',
  ADMIN_EMAILS: 'admin@example.com', GOOGLE_CLIENT_ID: 'test-client',
});

const { db, sha256 } = require('../server/db');
const push = require('../server/push');
const pushed = [];
push.sendToUser = async (userId, payload) => { pushed.push({ userId, ...payload }); return 1; };
const { server, gpsServer } = require('../server/index');
const recharge = require('../server/recharge');
const util = require('../server/util');
const { WebSocket } = require('ws');

const BASE = 'http://127.0.0.1:18080';
const SERIAL = '868123456789012';

function makeUser(email) {
  const u = db.prepare('INSERT INTO users (google_sub, email, name) VALUES (?,?,?)').run(`sub-${email}`, email, email);
  const token = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha256(token), u.lastInsertRowid, new Date().toISOString(), new Date(Date.now() + 864e5).toISOString());
  return { id: Number(u.lastInsertRowid), cookie: `sid=${token}` };
}
const call = async (user, method, url, body, extra = {}) => {
  const res = await fetch(BASE + url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { Cookie: user.cookie } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/* ---- GT06 frame builder ---- */
function crc16(buf) {
  let crc = 0xffff;
  for (const b of buf) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1; }
  return ~crc & 0xffff;
}
function frame(proto, content, serial = 1) {
  const body = Buffer.concat([Buffer.from([content.length + 5, proto]), content, Buffer.from([serial >> 8, serial & 255])]);
  const crc = Buffer.alloc(2); crc.writeUInt16BE(crc16(body));
  return Buffer.concat([Buffer.from([0x78, 0x78]), body, crc, Buffer.from([0x0d, 0x0a])]);
}
const login = (imei) => frame(0x01, Buffer.from(imei.padStart(16, '0'), 'hex'));
const heartbeat = (acc) => frame(0x13, Buffer.from([acc ? 0x02 : 0x00, 5, 3, 0, 2]));
function position(lat, lon, speed, course, acc) {
  const c = Buffer.alloc(18);
  const d = new Date();
  c.set([d.getUTCFullYear() - 2000, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], 0);
  c[6] = 0xc8; // gps info, 8 sats
  c.writeUInt32BE(Math.round(lat * 60 * 30000), 7);
  c.writeUInt32BE(Math.round(lon * 60 * 30000), 11);
  c[15] = speed;
  c.writeUInt16BE(0x1400 | course, 16);
  const lbs = Buffer.alloc(8);
  if (acc === undefined) return frame(0x12, Buffer.concat([c, lbs]));
  return frame(0x22, Buffer.concat([c, lbs, Buffer.from([acc ? 1 : 0, 0, 0, 0, 0, 0, 0])]));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(40); }
}

let alice, bob, admin, tracker, deviceId;

before(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  await sleep(200); // gps server bind
  alice = makeUser('alice@example.com'); bob = makeUser('bob@example.com'); admin = makeUser('admin@example.com');
});

after(async () => {
  tracker?.destroy();
  await gpsServer.close();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('unauthenticated requests are rejected', async () => {
  assert.equal((await call(null, 'GET', '/api/devices')).status, 401);
  const cfg = await call(null, 'GET', '/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.user, null);
  assert.ok(cfg.body.vapidPublicKey.length > 40);
  assert.equal((await call(null, 'POST', '/api/auth/google', { credential: 'garbage' })).status, 401);
});

test('cross-origin writes are blocked', async () => {
  const r = await call(alice, 'POST', '/api/devices', { serial: SERIAL }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('register device by serial; serials are exclusive per account', async () => {
  assert.equal((await call(alice, 'POST', '/api/devices', { serial: 'abc' })).status, 400);
  const ok = await call(alice, 'POST', '/api/devices', { serial: ` ${SERIAL.slice(0, 3)}-${SERIAL.slice(3)} `, name: 'Pulsar' });
  assert.equal(ok.status, 201);
  deviceId = ok.body.device.id;
  assert.equal(ok.body.device.serial, SERIAL);
  assert.equal((await call(alice, 'POST', '/api/devices', { serial: SERIAL })).status, 409);
  const other = await call(bob, 'POST', '/api/devices', { serial: `0${SERIAL}` });
  assert.equal(other.status, 409, 'leading zeros must not allow a duplicate claim');
  assert.deepEqual((await call(bob, 'GET', '/api/devices')).body.devices, []);
});

test('other users cannot read or change a device', async () => {
  for (const [m, u, b] of [['GET', '/history'], ['GET', '/events'], ['GET', '/recharges'], ['PATCH', '', { name: 'x' }], ['DELETE', '']]) {
    assert.equal((await call(bob, m, `/api/devices/${deviceId}${u}`, b)).status, 404, `${m} ${u}`);
  }
  assert.equal((await call(bob, 'POST', `/api/devices/${deviceId}/recharges`, { amount: 1, validDays: 1 })).status, 404);
  assert.equal((await call(bob, 'GET', '/api/admin/devices')).status, 403);
});

test('tracker data: position, ignition events, notifications, websocket', async () => {
  const ws = new WebSocket('ws://127.0.0.1:18080/ws', { headers: { Cookie: alice.cookie } });
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));

  // a stranger's socket must be refused
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:18080/ws'); w.on('open', res); w.on('error', rej); }));
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket('ws://127.0.0.1:18080/ws', { headers: { Cookie: alice.cookie, Origin: 'https://evil.example' } }); w.on('open', res); w.on('error', rej); }));

  tracker = net.connect(18090, '127.0.0.1');
  const acks = [];
  tracker.on('data', (d) => acks.push(d));
  tracker.write(login(SERIAL));
  await until(() => acks.length >= 1);
  assert.equal(acks[0][3], 0x01, 'login acknowledged');
  await until(async () => (await call(alice, 'GET', '/api/devices')).body.devices[0].online);

  tracker.write(position(23.8103, 90.4125, 42, 90));
  const dev = await until(async () => { const d = (await call(alice, 'GET', '/api/devices')).body.devices[0]; return d.position && d; });
  assert.ok(Math.abs(dev.position.latitude - 23.8103) < 1e-4);
  assert.equal(dev.position.speed, 42);
  assert.ok(msgs.some((m) => m.type === 'position' && m.deviceId === deviceId));

  // first ignition reading is learnt silently, changes notify
  tracker.write(heartbeat(false));
  await until(async () => (await call(alice, 'GET', '/api/devices')).body.devices[0].ignition === false);
  assert.equal(pushed.length, 0);
  tracker.write(heartbeat(true));
  await until(() => pushed.length === 1);
  assert.match(pushed[0].title, /Pulsar started/);
  tracker.write(position(23.8110, 90.4130, 20, 45, false)); // 0x22 with ACC off
  await until(() => pushed.length === 2);
  assert.match(pushed[1].title, /turned off/);
  tracker.write(heartbeat(false)); // unchanged => no duplicate
  await sleep(200);
  assert.equal(pushed.length, 2);
  assert.ok(msgs.filter((m) => m.type === 'ignition').length === 2);

  const ev = (await call(alice, 'GET', `/api/devices/${deviceId}/events`)).body.events;
  assert.deepEqual(ev.map((e) => e.type).sort(), ['ignition_off', 'ignition_on']);

  const hist = await call(alice, 'GET', `/api/devices/${deviceId}/history`);
  assert.equal(hist.body.stats.pointCount, 2);
  assert.ok(hist.body.stats.distanceKm > 0.05 && hist.body.stats.distanceKm < 0.2);
  assert.equal(hist.body.stats.maxSpeed, 42);

  // alerts can be muted per device
  await call(alice, 'PATCH', `/api/devices/${deviceId}`, { notifyIgnition: false });
  tracker.write(heartbeat(true));
  await until(async () => (await call(alice, 'GET', '/api/devices')).body.devices[0].ignition === true);
  assert.equal(pushed.length, 2);
  await call(alice, 'PATCH', `/api/devices/${deviceId}`, { notifyIgnition: true });
  ws.close();
});

test('data from unregistered devices is not stored', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM positions').get().n;
  const t = net.connect(18090, '127.0.0.1');
  const acks = []; t.on('data', (d) => acks.push(d));
  t.write(login('359999999999999'));
  await until(() => acks.length >= 1);
  t.write(position(23.9, 90.5, 5, 10));
  await sleep(250);
  t.destroy();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM positions').get().n, before);
});

test('recharge tracking: summary, stacking, validation', async () => {
  const today = util.localNow('Asia/Dhaka').date;
  const url = `/api/devices/${deviceId}/recharges`;
  assert.equal((await call(alice, 'GET', url)).body.summary.status, 'none');
  assert.equal((await call(alice, 'POST', url, { amount: -5, validDays: 30 })).status, 400);
  assert.equal((await call(alice, 'POST', url, { amount: 100 })).status, 400);

  const r1 = await call(alice, 'POST', url, { amount: 300, validDays: 30, note: 'monthly' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.summary.expiresOn, util.addDays(today, 29));
  assert.equal(r1.body.summary.daysLeft, 29);

  const r2 = await call(alice, 'POST', url, { amount: 100, validDays: 10 });
  assert.equal(r2.body.summary.expiresOn, util.addDays(today, 39), 'packs stack on top of a running one');
  assert.equal(r2.body.summary.totalSpent, 400);

  const r3 = await call(alice, 'POST', url, { amount: 50, rechargedOn: today, expiresOn: util.addDays(today, 100) });
  assert.equal(r3.body.summary.expiresOn, util.addDays(today, 100));

  const list = (await call(alice, 'GET', url)).body;
  assert.equal(list.recharges.length, 3);
  for (const r of list.recharges.slice(0, 3)) await call(alice, 'DELETE', `${url}/${r.id}`);
  assert.equal((await call(alice, 'GET', url)).body.summary.status, 'none');
});

test('expiry reminders: once per threshold, catch-up, quiet hours, opt-out', async () => {
  const today = util.localNow('Asia/Dhaka').date;
  const noon = new Date(util.dayRange(today, 'Asia/Dhaka').start); noon.setUTCHours(noon.getUTCHours() + 12);
  const night = new Date(util.dayRange(today, 'Asia/Dhaka').start); night.setUTCHours(night.getUTCHours() + 3);
  pushed.length = 0;
  db.prepare('DELETE FROM recharges').run();
  await call(alice, 'POST', `/api/devices/${deviceId}/recharges`, { amount: 10, rechargedOn: util.addDays(today, -28), expiresOn: util.addDays(today, 2) });

  await recharge.checkExpiries(night);
  assert.equal(pushed.length, 0, 'no reminders at night');

  await recharge.checkExpiries(noon); // 2 days left, thresholds 3,1,0 => the "3" reminder
  assert.equal(pushed.length, 1);
  assert.match(pushed[0].body, /expires in 2 days/);
  await recharge.checkExpiries(noon);
  assert.equal(pushed.length, 1, 'not repeated');

  // advance time: tomorrow noon => 1 day left => threshold 1
  const tomorrow = new Date(noon.getTime() + 864e5);
  await recharge.checkExpiries(tomorrow);
  assert.equal(pushed.length, 2);
  assert.match(pushed[1].body, /tomorrow/);
  // 3 days after expiry: still owed the "0" reminder, delivered once as "expired"
  await recharge.checkExpiries(new Date(noon.getTime() + 5 * 864e5));
  assert.equal(pushed.length, 3);
  assert.match(pushed[2].body, /expired 3 days ago/);
  await recharge.checkExpiries(new Date(noon.getTime() + 6 * 864e5));
  assert.equal(pushed.length, 3);

  // opt-out
  db.prepare('DELETE FROM recharge_notifications').run();
  await call(alice, 'PATCH', `/api/devices/${deviceId}`, { notifyRecharge: false });
  pushed.length = 0;
  await recharge.checkExpiries(noon);
  assert.equal(pushed.length, 0);
  assert.equal((await call(alice, 'PATCH', `/api/devices/${deviceId}`, { rechargeNotifyDays: [] })).status, 400);
  assert.equal((await call(alice, 'PATCH', `/api/devices/${deviceId}`, { rechargeNotifyDays: [7, 3, 1, 0] })).body.device.rechargeNotifyDays.join(), '7,3,1,0');
});

test('push subscription endpoints', async () => {
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal((await call(alice, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'x' } })).status, 400);
  assert.equal((await call(alice, 'POST', '/api/push/subscribe', { subscription: sub })).body.count, 1);
  assert.equal((await call(alice, 'POST', '/api/push/unsubscribe', { endpoint: sub.endpoint })).body.count, 0);
});

test('admin can release a device; removing wipes its data', async () => {
  assert.equal((await call(admin, 'GET', '/api/admin/devices')).body.devices.length, 1);
  assert.equal((await call(admin, 'DELETE', `/api/admin/devices/${deviceId}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM positions WHERE imei = ?').get(SERIAL).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  // now bob can claim it and sees none of alice's history
  const claim = await call(bob, 'POST', '/api/devices', { serial: SERIAL });
  assert.equal(claim.status, 201);
  assert.equal((await call(bob, 'GET', `/api/devices/${claim.body.device.id}/history`)).body.stats.pointCount, 0);
});

test('timezone day ranges', () => {
  assert.deepEqual(util.dayRange('2026-09-16', 'Asia/Dhaka'), { start: '2026-09-15T18:00:00.000Z', end: '2026-09-16T18:00:00.000Z' });
  assert.deepEqual(util.dayRange('2026-03-08', 'America/New_York'), { start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z' });
  assert.equal(util.daysBetween('2026-01-30', '2026-02-02'), 3);
});

test('static app is served', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.match(html, /GPS Tracker/);
  const sw = await fetch(BASE + '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(BASE + '/manifest.webmanifest')).status, 200);
});
