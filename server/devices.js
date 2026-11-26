'use strict';
const { db } = require('./db');
const recharge = require('./recharge');

const byIdForUser = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?');
const bySerial = db.prepare('SELECT * FROM devices WHERE serial = ?');
const latestPosition = db.prepare(`
  SELECT time, latitude, longitude, speed, course, satellites FROM positions
  WHERE imei = ? ORDER BY time DESC LIMIT 1
`);

const online = new Set(); // serials with an open TCP connection (maintained by gps.js)

function toApi(d) {
  return {
    id: d.id,
    serial: d.serial,
    name: d.name,
    simNumber: d.sim_number,
    simOperator: d.sim_operator,
    notifyIgnition: !!d.notify_ignition,
    notifyAlarms: !!d.notify_alarms,
    notifyRecharge: !!d.notify_recharge,
    rechargeNotifyDays: d.recharge_notify_days.split(',').filter(Boolean).map(Number),
    ignition: d.ignition === null ? null : !!d.ignition,
    ignitionChangedAt: d.ignition_changed_at,
    batteryLevel: d.battery_level,
    gsmLevel: d.gsm_level,
    lastSeen: d.last_seen,
    online: online.has(d.serial),
    position: latestPosition.get(d.serial) || null,
    recharge: recharge.summary(d.id),
  };
}

const listForUser = (userId) =>
  db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY id').all(userId).map(toApi);

module.exports = { byIdForUser, bySerial, toApi, listForUser, online };
