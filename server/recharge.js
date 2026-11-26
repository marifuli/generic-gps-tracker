'use strict';
const config = require('./config');
const { db } = require('./db');
const push = require('./push');
const { localNow, daysBetween } = require('./util');

/** Current SIM status for a device: latest expiry, days left, spend. */
function summary(deviceId, now = new Date()) {
  const agg = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total, MAX(expires_on) AS expires_on
    FROM recharges WHERE device_id = ?
  `).get(deviceId);
  const last = db.prepare(
    'SELECT amount, recharged_on FROM recharges WHERE device_id = ? ORDER BY recharged_on DESC, id DESC LIMIT 1',
  ).get(deviceId);
  const today = localNow(config.timezone, now).date;
  const expiresOn = agg.expires_on || null;
  const daysLeft = expiresOn ? daysBetween(today, expiresOn) : null;
  return {
    count: agg.count,
    totalSpent: agg.total,
    expiresOn,
    daysLeft,
    status: daysLeft === null ? 'none' : daysLeft < 0 ? 'expired' : daysLeft <= 3 ? 'expiring' : 'active',
    lastAmount: last?.amount ?? null,
    lastRechargedOn: last?.recharged_on ?? null,
  };
}

function expiryMessage(name, daysLeft, expiresOn) {
  if (daysLeft < 0) return `${name}: SIM recharge expired ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago (${expiresOn}). Recharge to keep tracking.`;
  if (daysLeft === 0) return `${name}: SIM recharge expires today. Recharge now to avoid losing tracking.`;
  if (daysLeft === 1) return `${name}: SIM recharge expires tomorrow (${expiresOn}).`;
  return `${name}: SIM recharge expires in ${daysLeft} days (${expiresOn}).`;
}

/**
 * Send at most one reminder per (device, expiry date, threshold).
 * The applicable threshold is the smallest configured value >= days left, so reminders
 * missed while the server was down are still delivered once.
 */
async function checkExpiries(now = new Date()) {
  const { hour } = localNow(config.timezone, now);
  if (hour < 9 || hour >= 22) return; // don't wake anybody up at night

  const devices = db.prepare('SELECT * FROM devices WHERE notify_recharge = 1').all();
  for (const d of devices) {
    const s = summary(d.id, now);
    if (!s.expiresOn) continue;
    const thresholds = d.recharge_notify_days.split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
    const t = thresholds.find((x) => s.daysLeft <= x);
    if (t === undefined) continue;
    const seen = db.prepare(
      'SELECT 1 FROM recharge_notifications WHERE device_id = ? AND expires_on = ? AND threshold = ?',
    ).get(d.id, s.expiresOn, t);
    if (seen) continue;

    db.prepare('INSERT INTO recharge_notifications (device_id, expires_on, threshold, sent_at) VALUES (?,?,?,?)')
      .run(d.id, s.expiresOn, t, new Date().toISOString());
    await push.sendToUser(d.user_id, {
      title: s.daysLeft < 0 ? 'SIM recharge expired' : 'SIM recharge reminder',
      body: expiryMessage(d.name, s.daysLeft, s.expiresOn),
      url: `/#/recharge?d=${d.id}`,
      tag: `recharge-${d.id}`,
    });
  }
}

function start() {
  const run = () => checkExpiries().catch((e) => console.error('[recharge] check failed:', e));
  setTimeout(run, 15000).unref();
  setInterval(run, 15 * 60 * 1000).unref();
}

module.exports = { summary, checkExpiries, start };
