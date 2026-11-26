'use strict';

/** Digits only, no leading zeros: the form in which we compare serials/IMEIs. */
function normalizeSerial(value) {
  return String(value ?? '').replace(/\D/g, '').replace(/^0+/, '');
}

function validSerial(value) {
  const s = String(value ?? '').replace(/\s|-/g, '');
  return /^\d{8,20}$/.test(s);
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** UTC epoch ms of a wall-clock time in `timeZone`. */
function localToUtcMs(y, m, d, hh, mm, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMs(guess, timeZone);
  t = guess - tzOffsetMs(t, timeZone); // second pass handles DST edges
  return t;
}

/** UTC ISO range [start, end) covering the local calendar day `YYYY-MM-DD` in `timeZone`. */
function dayRange(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: new Date(localToUtcMs(y, m, d, 0, 0, timeZone)).toISOString(),
    end: new Date(localToUtcMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone)).toISOString(),
  };
}

/** `YYYY-MM-DDTHH:mm` (wall-clock in `timeZone`) -> UTC ISO string, or null if invalid. */
function localDateTimeToIso(value, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value));
  if (!m) return null;
  const [y, mo, d, hh, mm] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const ms = localToUtcMs(y, mo, d, hh, mm, timeZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Initial compass bearing (0-360, north = 0) from point a to point b. */
function bearing(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude), lat2 = toRad(b.latitude);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Direction of travel derived from successive positions, for trackers that report no (or a
 * constant) course. `st` is mutable per-device state: { ref, heading }.
 * The reference point only advances once the vehicle has really moved, so GPS jitter while
 * parked never spins the arrow and slow movement still accumulates into a direction.
 */
function nextHeading(st, latitude, longitude, speed, deviceCourse) {
  const cur = { latitude, longitude };
  if (!st.ref) {
    st.ref = cur;
    st.heading = Number.isFinite(deviceCourse) ? Math.round(deviceCourse) : 0;
    return st.heading;
  }
  const needed = (speed || 0) >= 2 ? 8 : 25; // metres
  if (haversineMeters(st.ref, cur) >= needed) {
    st.heading = Math.round(bearing(st.ref, cur));
    st.ref = cur;
  }
  return st.heading;
}

/** Today's date (YYYY-MM-DD) and hour in `timeZone`. */
function localNow(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

/** Whole calendar days from date a to date b (both YYYY-MM-DD). */
function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

module.exports = {
  normalizeSerial, validSerial, haversineMeters, dayRange, localDateTimeToIso, bearing, nextHeading,
  localNow, daysBetween, addDays, isDate,
};
