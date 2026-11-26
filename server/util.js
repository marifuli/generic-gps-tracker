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

/** UTC ISO range [start, end) covering the local calendar day `YYYY-MM-DD` in `timeZone`. */
function dayRange(date, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const localToUtc = (yy, mm, dd) => {
    const guess = Date.UTC(yy, mm - 1, dd);
    let t = guess - tzOffsetMs(guess, timeZone);
    t = guess - tzOffsetMs(t, timeZone); // second pass handles DST edges
    return t;
  };
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: new Date(localToUtc(y, m, d)).toISOString(),
    end: new Date(localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())).toISOString(),
  };
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
  normalizeSerial, validSerial, haversineMeters, dayRange, localNow, daysBetween, addDays, isDate,
};
