'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../server/trips');
const { nextHeading, bearing } = require('../server/util');

const T0 = Date.parse('2026-11-26T04:00:00Z');
const pt = (min, lat, lon, speed = 0, ignition = null) => ({ time: new Date(T0 + min * 60000).toISOString(), latitude: lat, longitude: lon, speed, ignition });
// ~111 m per 0.001 deg latitude
const drive = (startMin, lat0, n, step = 0.002) => Array.from({ length: n }, (_, i) => pt(startMin + i, lat0 + i * step, 90.4, 30, 1));

test('detects trip, long silent stop, then second trip', () => {
  const a = drive(0, 23.80, 10);                         // minutes 0-9, moving north ~2 km
  const parkLat = 23.80 + 9 * 0.002;
  const park = [pt(10, parkLat, 90.4), pt(11, parkLat, 90.4)]; // tracker goes quiet while parked...
  const b = [pt(190, parkLat + 0.0001, 90.4), ...drive(191, parkLat + 0.002, 8)]; // ...and wakes 3 h later
  const r = analyze([...a.slice(0, 9), ...park, ...b], {});
  const kinds = r.timeline.map((x) => x.type);
  assert.deepEqual(kinds, ['trip', 'stop', 'trip']);
  const stop = r.stops[0];
  assert.ok(stop.durationMin >= 170, `stop lasted ${stop.durationMin} min`);
  assert.equal(stop.long, true);
  assert.equal(stop.idling, false);
  assert.ok(r.trips[0].distanceKm > 1.5);
});

test('short pauses are not stops; idling with ignition on is flagged', () => {
  const rows = [...drive(0, 23.8, 5), pt(5, 23.808, 90.4, 0, 1), pt(7, 23.808, 90.4, 0, 1), ...drive(8, 23.81, 5)];
  assert.equal(analyze(rows).stops.length, 0, '2 minute pause is ignored');
  const idle = [...drive(0, 23.8, 5), ...Array.from({ length: 20 }, (_, i) => pt(5 + i, 23.808, 90.4, 0, 1)), ...drive(26, 23.81, 5)];
  const r = analyze(idle);
  assert.equal(r.stops.length, 1);
  assert.equal(r.stops[0].idling, true);
  assert.equal(r.stops[0].long, false);
});

test('GPS jitter while parked stays one stop and adds no trip', () => {
  const rows = Array.from({ length: 60 }, (_, i) => pt(i, 23.8 + (i % 3) * 0.00015, 90.4 + (i % 2) * 0.0001, 0, 0));
  const r = analyze(rows);
  assert.equal(r.stops.length, 1);
  assert.equal(r.trips.length, 0);
  assert.equal(r.stops[0].durationMin, 59);
});

test('long silence while moving is reported as a signal gap', () => {
  const r = analyze([pt(0, 23.80, 90.4, 30, 1), pt(1, 23.802, 90.4, 30, 1), pt(60, 23.9, 90.4, 30, 1), pt(61, 23.902, 90.4, 30, 1)]);
  assert.equal(r.gaps.length, 1);
  assert.ok(r.gaps[0].durationMin >= 58);
  assert.equal(r.trips.length, 2, 'a gap splits the trip');
  assert.ok(r.trips.every((t) => t.distanceKm < 1), 'the unreported jump is not counted as driving');
});

test('direction of travel is derived from movement when the tracker sends no course', () => {
  const st = {};
  assert.equal(nextHeading(st, 23.8, 90.4, 30, 0), 0);
  const north = nextHeading(st, 23.801, 90.4, 30, 0);
  assert.ok(north < 5 || north > 355, `north was ${north}`);
  const east = nextHeading(st, 23.801, 90.4011, 30, 0);
  assert.ok(Math.abs(east - 90) < 5, `east was ${east}`);
  const jitter = nextHeading(st, 23.801 + 0.00002, 90.4011, 0, 0);
  assert.equal(jitter, east, 'tiny jitter while parked keeps the last heading');
  assert.ok(Math.abs(bearing({ latitude: 0, longitude: 0 }, { latitude: -1, longitude: 0 }) - 180) < 0.01);
});
