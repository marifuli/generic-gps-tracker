'use strict';
const { createServer, adapters } = require('gps-tracking');
const config = require('./config');
const { db } = require('./db');
const push = require('./push');
const realtime = require('./realtime');
const devices = require('./devices');
const { normalizeSerial, nextHeading } = require('./util');

/**
 * GT06 variant: many Concox-compatible trackers report position with protocol 0x22,
 * which carries the ACC (ignition) flag. The stock adapter treats it as "other".
 */
class Gt06Plus extends adapters.GT06 {
  parsePacket(frame) {
    const packet = super.parsePacket(frame);
    if (packet.action === 'other' && packet.cmd === '22') {
      const c = Buffer.from(packet.data, 'hex');
      if (c.length >= 18) {
        const course = c.readUInt16BE(16);
        const mins = (o) => c.readUInt32BE(o) / 30000 / 60;
        const lat = mins(7), lon = mins(11);
        const t = new Date(Date.UTC(2000 + c[0], c[1] - 1, c[2], c[3], c[4], c[5]));
        return {
          ...packet,
          action: 'ping',
          position: {
            latitude: course & 1024 ? lat : -lat,
            longitude: course & 2048 ? -lon : lon,
            time: t,
            valid: !!(course & 4096),
            speed: c[15],
            orientation: course & 1023,
            satellites: c[6] & 15,
            extra: c.length >= 27 ? { ignition: c[26] === 1 } : {},
          },
        };
      }
    }
    return packet;
  }
}

const Adapter = config.gpsProtocol === 'GT06' ? Gt06Plus : adapters[config.gpsProtocol];
if (!Adapter) throw new Error(`Unknown GPS_PROTOCOL "${config.gpsProtocol}". Options: ${Object.keys(adapters).join(', ')}`);

const insertPosition = db.prepare(
  'INSERT INTO positions (imei, time, latitude, longitude, speed, course, satellites, ignition) VALUES (?,?,?,?,?,?,?,?)',
);
const newestPosition = db.prepare('SELECT latitude, longitude, course FROM positions WHERE imei = ? ORDER BY time DESC LIMIT 1');
const headings = new Map(); // serial -> { ref, heading } for direction-of-travel detection
const latestTime = db.prepare('SELECT MAX(time) AS t FROM positions WHERE imei = ?');
const touch = db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?');
const insertEvent = db.prepare(
  'INSERT INTO events (device_id, type, message, time, latitude, longitude) VALUES (?,?,?,?,?,?)',
);

const fmtTime = (iso) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone, hour: 'numeric', minute: '2-digit', hour12: true, day: 'numeric', month: 'short',
  }).format(new Date(iso));

const lastPosition = new Map(); // serial -> {latitude, longitude} for event locations

function handleIgnition(serial, on, iso) {
  const row = devices.bySerial.get(serial);
  if (!row || typeof on !== 'boolean') return row;
  const value = on ? 1 : 0;
  const previous = row.ignition;
  if (previous === value) return row;

  db.prepare('UPDATE devices SET ignition = ?, ignition_changed_at = ? WHERE id = ?').run(value, iso, row.id);
  if (previous === null) return row; // first reading: just learn the state

  const pos = lastPosition.get(serial);
  const type = on ? 'ignition_on' : 'ignition_off';
  const message = on ? 'Ignition turned on' : 'Ignition turned off';
  insertEvent.run(row.id, type, message, iso, pos?.latitude ?? null, pos?.longitude ?? null);
  realtime.publish(row.user_id, { type: 'ignition', deviceId: row.id, ignition: on, time: iso });
  if (row.notify_ignition) {
    push.sendToUser(row.user_id, {
      title: on ? `${row.name} started` : `${row.name} turned off`,
      body: `${message} at ${fmtTime(iso)}`,
      url: `/#/live?d=${row.id}`,
      tag: `ignition-${row.id}`,
    }).catch((e) => console.error('[push]', e));
  }
  return row;
}

function setOnline(serial, isOnline) {
  if (isOnline === devices.online.has(serial)) return;
  isOnline ? devices.online.add(serial) : devices.online.delete(serial);
  const row = devices.bySerial.get(serial);
  if (row) realtime.publish(row.user_id, { type: 'presence', deviceId: row.id, online: isOnline });
}

function start() {
  const server = createServer({ host: '0.0.0.0', port: config.gpsPort, adapter: Adapter, logger: false });
  const active = new Map(); // serial -> Device (latest connection wins)

  server.on('error', (e) => console.error('[gps] server error:', e));

  server.on('connection', (device) => {
    let serial = null;
    const warned = { unknown: false };

    const identify = (id) => {
      serial = normalizeSerial(id);
      active.set(serial, device);
      setOnline(serial, true);
    };

    device.on('error', (e) => console.error('[gps] device error:', e.message));
    device.on('parseError', (e) => console.warn('[gps] parse error:', e.message));
    device.on('loginRequest', (id) => {
      // Accept every login so the tracker stays happy; data is only kept for registered serials.
      device.acceptLogin();
      identify(id);
      const row = devices.bySerial.get(serial);
      if (!row) console.log(`[gps] login from unregistered device ${serial} (${device.remoteAddress})`);
      else touch.run(new Date().toISOString(), row.id);
    });
    device.on('identified', (id) => { if (!serial) identify(id); });

    device.on('ping', (p) => {
      if (!serial) return;
      const row = devices.bySerial.get(serial);
      if (!row) {
        if (!warned.unknown) { warned.unknown = true; console.log(`[gps] dropping data from unregistered device ${serial}`); }
        return;
      }
      const now = Date.now();
      const lat = Number(p.latitude), lon = Number(p.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      let t = p.time ? new Date(p.time).getTime() : now;
      if (!Number.isFinite(t) || t > now + 86400000) t = now; // bogus clock

      const iso = new Date(t).toISOString();
      const data = {
        time: iso, latitude: lat, longitude: lon,
        speed: p.speed ?? 0, course: p.orientation ?? 0, satellites: p.satellites ?? null,
      };
      const newest = latestTime.get(serial).t;
      // Devices upload buffered history after reconnecting: only the newest point is "live".
      const isNewest = !newest || iso >= newest;
      // Only a packet stamped within the last few minutes describes the vehicle *now*. Buffered
      // uploads (tracker was offline) must not flip the live ignition state or fire alerts.
      const isLive = isNewest && now - t < 10 * 60000;

      let ign = typeof p.extra?.ignition === 'boolean' ? p.extra.ignition : null;
      if (isNewest) {
        lastPosition.set(serial, { latitude: lat, longitude: lon });
        if (isLive && ign !== null) handleIgnition(serial, ign, new Date(now).toISOString());
      }
      const fresh = devices.bySerial.get(serial) || row;
      const ignValue = ign !== null ? (ign ? 1 : 0) : (isLive ? fresh.ignition : null); // null = unknown

      // Direction of travel: trackers often send no usable course, so derive it from movement.
      let heading = p.orientation ?? 0;
      if (isNewest) {
        let st = headings.get(serial);
        if (!st) {
          const prev = newestPosition.get(serial);
          st = prev ? { ref: { latitude: prev.latitude, longitude: prev.longitude }, heading: Math.round(prev.course || 0) } : {};
          headings.set(serial, st);
        }
        heading = nextHeading(st, lat, lon, data.speed, p.orientation);
      }
      data.course = heading;
      data.ignition = ignValue === null || ignValue === undefined ? null : !!ignValue;

      insertPosition.run(serial, iso, lat, lon, data.speed, heading, data.satellites, ignValue ?? null);
      touch.run(new Date(now).toISOString(), row.id);
      if (isLive) realtime.publish(row.user_id, { type: 'position', deviceId: row.id, data });
    });

    device.on('packet', (packet) => {
      if (!serial || packet.action !== 'heartbeat') return;
      const row = devices.bySerial.get(serial);
      if (!row) return;
      const iso = new Date().toISOString();
      touch.run(iso, row.id);
      // GT06 status packet: terminalInfo(1) voltageLevel(1) gsmLevel(1) alarm/lang(2)
      if (config.gpsProtocol === 'GT06' && packet.data) {
        const b = Buffer.from(packet.data, 'hex');
        if (b.length >= 3) {
          db.prepare('UPDATE devices SET battery_level = ?, gsm_level = ? WHERE id = ?').run(b[1], b[2], row.id);
          handleIgnition(serial, !!(b[0] & 0x02), iso);
        }
        realtime.publish(row.user_id, { type: 'status', deviceId: row.id, batteryLevel: b[1], gsmLevel: b[2], lastSeen: iso });
      } else if (typeof packet.position?.extra?.ignition === 'boolean') {
        handleIgnition(serial, packet.position.extra.ignition, iso);
      }
    });

    device.on('alarm', (alarm, packet) => {
      if (!serial) return;
      const row = devices.bySerial.get(serial);
      if (!row) return;
      const iso = new Date().toISOString();
      const pos = packet.position;
      const extra = pos?.extra;
      if (extra && typeof extra.terminalInfo === 'number') handleIgnition(serial, !!(extra.terminalInfo & 0x02), iso);
      if (typeof extra?.voltage === 'number') {
        db.prepare('UPDATE devices SET battery_level = ?, gsm_level = ? WHERE id = ?').run(extra.voltage, extra.gsmSignal ?? null, row.id);
      }
      insertEvent.run(row.id, `alarm_${alarm.code}`, alarm.message, iso, pos?.latitude ?? null, pos?.longitude ?? null);
      realtime.publish(row.user_id, { type: 'alarm', deviceId: row.id, code: alarm.code, message: alarm.message, time: iso });
      if (row.notify_alarms) {
        push.sendToUser(row.user_id, {
          title: `${row.name}: ${alarm.message}`,
          body: `Alert at ${fmtTime(iso)}`,
          url: `/#/live?d=${row.id}`,
          tag: `alarm-${row.id}-${alarm.code}`,
        }).catch((e) => console.error('[push]', e));
      }
    });

    device.on('disconnect', () => {
      if (serial && active.get(serial) === device) {
        active.delete(serial);
        setOnline(serial, false);
      }
    });
  });

  server.listen().then(() => console.log(`[gps] ${config.gpsProtocol} server listening on 0.0.0.0:${config.gpsPort}`));
  return server;
}

module.exports = { start, Gt06Plus };
