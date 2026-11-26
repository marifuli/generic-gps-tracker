#!/usr/bin/env node
'use strict';
/**
 * Fake GT06 tracker for demos/testing. No dependencies.
 *
 *   node scripts/simulate-tracker.js --serial 865784053274570 --host track.example.com --port 8090
 *   node scripts/simulate-tracker.js --serial 865784053274570 --backfill 3      # fill 3 past days first
 *
 * Register the serial in the app first (Settings -> Add a device), otherwise the server
 * accepts the login but discards the data.
 *
 * Options
 *   --serial <digits>      required (IMEI)
 *   --host / --port        server (default 127.0.0.1 : 8090)
 *   --interval <seconds>   seconds between live positions (3)
 *   --ignition on|off|toggle   on: engine OFF->ON signal then drive (default); off: parked;
 *                              toggle: flips every 10 positions
 *   --backfill <days>      first upload N past days of history: trips, a long parked stop,
 *                          an idling stop and a gap, with timestamps in the past
 *   --send-course          send the heading in each packet (default: send none, like trackers
 *                          without course data, so the server derives direction itself)
 *   --lat/--lon            start point (Dhaka)
 *
 * Like a real tracker, it sends an ignition (ACC) signal: OFF -> ON when it starts,
 * ON/OFF on every change, and OFF when you press Ctrl+C.
 */
const net = require('net');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const serial = arg('serial');
if (!serial || !/^\d{8,20}$/.test(serial)) { console.error('Usage: --serial <IMEI digits> [--host H] [--port P] [--backfill DAYS]'); process.exit(1); }
const host = arg('host', '127.0.0.1');
const port = Number(arg('port', 8090));
const every = Number(arg('interval', 3)) * 1000;
const ignitionMode = arg('ignition', 'on');
const backfillDays = Number(arg('backfill', 0));
const sendCourse = flag('send-course');
let lat = Number(arg('lat', 23.8103)), lon = Number(arg('lon', 90.4125));
let heading = 45;

function crc16(buf) { // CRC-ITU (X.25)
  let crc = 0xffff;
  for (const b of buf) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1; }
  return ~crc & 0xffff;
}
let seq = 0;
function frame(proto, content) {
  seq = (seq + 1) & 0xffff;
  const body = Buffer.concat([Buffer.from([content.length + 5, proto]), content, Buffer.from([seq >> 8, seq & 255])]);
  const crc = Buffer.alloc(2); crc.writeUInt16BE(crc16(body));
  return Buffer.concat([Buffer.from([0x78, 0x78]), body, crc, Buffer.from([0x0d, 0x0a])]);
}
const loginPacket = () => frame(0x01, Buffer.from(serial.padStart(16, '0'), 'hex'));
const heartbeat = (acc) => frame(0x13, Buffer.from([acc ? 0x02 : 0x00, 5, 3, 0, 2])); // terminal info(ACC bit), battery, gsm, lang
function positionPacket(when, speed, acc) {
  const c = Buffer.alloc(18), d = new Date(when);
  c.set([d.getUTCFullYear() - 2000, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()], 0);
  c[6] = 0xc8; // 8 satellites
  c.writeUInt32BE(Math.round(Math.abs(lat) * 60 * 30000), 7);
  c.writeUInt32BE(Math.round(Math.abs(lon) * 60 * 30000), 11);
  c[15] = speed;
  c.writeUInt16BE(0x1000 | (lat >= 0 ? 0x400 : 0) | (lon < 0 ? 0x800 : 0) | (sendCourse ? Math.round(heading) % 360 : 0), 16);
  // protocol 0x22 = position + LBS + ACC (ignition) flag
  return frame(0x22, Buffer.concat([c, Buffer.alloc(8), Buffer.from([acc ? 1 : 0, 0, 0, 0, 0, 0, 0])]));
}

/** Move `meters` along the current heading (with a little wander). */
function advance(meters, wander = 10) {
  heading = (heading + (Math.random() * 2 - 1) * wander + 360) % 360;
  lat += (meters * Math.cos((heading * Math.PI) / 180)) / 111320;
  lon += (meters * Math.sin((heading * Math.PI) / 180)) / (111320 * Math.cos((lat * Math.PI) / 180));
}

/** Upload past days: each day = trip, long parked stop, trip, idling stop, trip, plus a tracker gap. */
function backfill(sock, days) {
  let sent = 0;
  const out = (t, speed, acc) => { sock.write(positionPacket(t, speed, acc)); sent += 1; };
  const drive = (t0, minutes, kmh, turn) => {
    heading = (heading + turn + 360) % 360;
    for (let m = 0; m < minutes * 3; m++) { advance((kmh / 3.6) * 20, 6); out(t0 + m * 20000, kmh + Math.round(Math.random() * 8 - 4), true); }
    return t0 + minutes * 60000;
  };
  const stay = (t0, minutes, stepMin, acc) => {
    for (let m = 0; m <= minutes; m += stepMin) { advance(1, 0); out(t0 + m * 60000, 0, acc); }
    return t0 + minutes * 60000;
  };
  const startOfToday = new Date(); startOfToday.setUTCHours(0, 0, 0, 0);
  for (let d = days; d >= 1; d--) {
    let t = startOfToday.getTime() - d * 86400000 + 3 * 3600000; // ~09:00 Dhaka
    lat = Number(arg('lat', 23.8103)); lon = Number(arg('lon', 90.4125)); // every day starts at home
    t = drive(t, 25, 32, 20);                 // trip to work
    t = stay(t, 150, 15, false) + 60000;       // parked 2.5 h (reports every 15 min)
    t = drive(t, 12, 28, 70);                 // trip to lunch
    t = stay(t, 22, 2, true) + 60000;          // idling 22 min, engine on
    t = drive(t, 40, 35, -40);                // trip, then ...
    advance(9000, 0); t += 70 * 60000;         // ... tracker loses signal for 70 min (moved 9 km unreported)
    t = drive(t, 15, 30, 10);
    stay(t, 40, 20, false);                    // parked at the end of the day
  }
  console.log(`backfilled ${sent} positions over ${days} day(s)`);
  lat = Number(arg('lat', 23.8103)); lon = Number(arg('lon', 90.4125));
}

const sock = net.connect(port, host, () => {
  console.log(`connected to ${host}:${port}, logging in as ${serial}`);
  sock.write(loginPacket());
});
sock.on('data', (d) => { if (process.env.VERBOSE) console.log(`<- ack 0x${d[3].toString(16).padStart(2, '0')}`); });
sock.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
sock.on('close', () => { console.log('connection closed'); process.exit(0); });

let tick = 0, acc = ignitionMode !== 'off';
setTimeout(async () => {
  if (backfillDays > 0) { backfill(sock, backfillDays); await new Promise((r) => setTimeout(r, 1500)); }

  // Ignition signal: engine off first, then (for "on") switched on - this is what fires the "bike started" push
  sock.write(heartbeat(false));
  console.log('ignition signal: OFF');
  if (acc) { await new Promise((r) => setTimeout(r, 1500)); sock.write(heartbeat(true)); console.log('ignition signal: ON'); }

  const timer = setInterval(() => {
    tick += 1;
    if (ignitionMode === 'toggle' && tick % 10 === 0) {
      acc = !acc; sock.write(heartbeat(acc)); console.log(`ignition signal: ${acc ? 'ON' : 'OFF'}`);
    }
    const speed = acc ? 25 + Math.round(15 * Math.sin(tick / 4)) : 0;
    if (acc) advance((speed / 3.6) * (every / 1000));
    sock.write(positionPacket(Date.now(), speed, acc));
    if (tick % 5 === 0) sock.write(heartbeat(acc));
    console.log(`-> ${lat.toFixed(5)}, ${lon.toFixed(5)}  ${speed} km/h  ignition ${acc ? 'ON' : 'OFF'}`);
  }, every);

  process.on('SIGINT', () => {
    clearInterval(timer);
    if (acc) { sock.write(heartbeat(false)); console.log('ignition signal: OFF'); }
    setTimeout(() => sock.end(), 300);
  });
}, 500);
