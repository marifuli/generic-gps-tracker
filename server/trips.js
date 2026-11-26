'use strict';
const { haversineMeters } = require('./util');

/**
 * Splits a time-ordered list of positions into stops (the vehicle stayed in one place) and the
 * trips between them. Trackers usually go quiet while parked, so a long silence followed by a
 * position at the same place still counts as one continuous stop.
 *
 * rows: [{ time(ISO), latitude, longitude, speed, ignition }]
 */
const DEFAULTS = {
  stopRadiusM: 50,        // staying within this distance of where it stopped = same stop
  minStopMin: 5,          // shorter stays (traffic lights, junctions) are ignored
  longStopMin: 60,        // flagged as a "long stop"
  gapMin: 15,             // no data for this long while moving = "no signal"
  minTripM: 100,          // ignore moves shorter than this
};

const ms = (iso) => Date.parse(iso);
const minutes = (a, b) => Math.round((ms(b) - ms(a)) / 60000);

function analyze(rows, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = rows.length;
  if (n < 2) return { timeline: [], stops: [], trips: [], gaps: [] };

  // ---- 1. stops: clusters of points within stopRadius of the first point of the cluster
  const clusters = [];
  let anchor = null;
  const close = () => {
    if (anchor && (ms(rows[anchor.last].time) - ms(rows[anchor.first].time)) / 60000 >= o.minStopMin) clusters.push(anchor);
  };
  for (let i = 0; i < n; i++) {
    const p = rows[i];
    if (anchor && haversineMeters(rows[anchor.first], p) <= o.stopRadiusM) anchor.last = i;
    else { close(); anchor = { first: i, last: i }; }
  }
  close();

  const stops = clusters.map((c) => {
    let lat = 0, lon = 0, on = 0;
    const count = c.last - c.first + 1;
    for (let i = c.first; i <= c.last; i++) {
      lat += rows[i].latitude; lon += rows[i].longitude;
      if (rows[i].ignition === 1) on += 1;
    }
    const start = rows[c.first].time, end = rows[c.last].time;
    const duration = minutes(start, end);
    return {
      type: 'stop', start, end, durationMin: duration, latitude: lat / count, longitude: lon / count,
      idling: on * 2 > count, // ignition on while standing still
      long: duration >= o.longStopMin,
      firstIdx: c.first, lastIdx: c.last,
    };
  });

  // ---- 2. trips: the movement between consecutive stops (and before the first / after the last)
  const trips = [];
  const gaps = [];
  const bounds = [{ lastIdx: 0, firstIdx: 0, virtual: true }, ...stops, { firstIdx: n - 1, lastIdx: n - 1, virtual: true }];
  for (let k = 0; k < bounds.length - 1; k++) {
    const from = bounds[k].virtual ? (k === 0 ? 0 : bounds[k].lastIdx) : bounds[k].lastIdx;
    const to = bounds[k + 1].firstIdx;
    if (to <= from) continue;
    // Walk the stretch between two stops. A silent gap ends the current trip (the vehicle's path
    // during it is unknown), so a straight-line jump across a gap is never counted as driving.
    let segStart = from, dist = 0, top = 0;
    const flush = (endIdx) => {
      if (endIdx > segStart && dist >= o.minTripM) {
        trips.push({
          type: 'trip', start: rows[segStart].time, end: rows[endIdx].time, durationMin: minutes(rows[segStart].time, rows[endIdx].time),
          distanceKm: Math.round(dist / 10) / 100, maxSpeed: top,
          from: { latitude: rows[segStart].latitude, longitude: rows[segStart].longitude },
          to: { latitude: rows[endIdx].latitude, longitude: rows[endIdx].longitude },
        });
      }
    };
    for (let i = from + 1; i <= to; i++) {
      const d = haversineMeters(rows[i - 1], rows[i]);
      const dt = (ms(rows[i].time) - ms(rows[i - 1].time)) / 60000;
      if (dt > o.gapMin) {
        if (d > 300) gaps.push({ type: 'gap', start: rows[i - 1].time, end: rows[i].time, durationMin: Math.round(dt), distanceKm: Math.round(d / 10) / 100 });
        flush(i - 1);
        segStart = i; dist = 0; top = 0;
        continue;
      }
      top = Math.max(top, rows[i].speed || 0);
      if (d > 15 || (rows[i].speed || 0) > 3) dist += d; // skip parked-GPS jitter
    }
    flush(to);
  }

  const timeline = [...stops, ...trips, ...gaps].sort((a, b) => ms(a.start) - ms(b.start) || (a.type === 'stop' ? -1 : 1));
  return { timeline, stops, trips, gaps };
}

module.exports = { analyze, DEFAULTS };
