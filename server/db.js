'use strict';
// Node's built-in SQLite: nothing to compile, works on any Linux glibc. Needs Node >= 22.13.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const config = require('./config');

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

/** Run fn inside a transaction (rolled back if it throws). */
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    picture TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- A device is claimed by exactly one user, identified by its serial (IMEI).
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial TEXT NOT NULL UNIQUE,            -- normalised: digits, no leading zeros
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sim_number TEXT,
    sim_operator TEXT,
    notify_ignition INTEGER NOT NULL DEFAULT 1,
    notify_alarms INTEGER NOT NULL DEFAULT 1,
    notify_recharge INTEGER NOT NULL DEFAULT 1,
    recharge_notify_days TEXT NOT NULL DEFAULT '3,1,0',
    ignition INTEGER,                       -- 1 on, 0 off, NULL unknown
    ignition_changed_at TEXT,
    battery_level INTEGER,                  -- GT06 voltage level 0-6
    gsm_level INTEGER,                      -- GT06 gsm signal 0-4
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

  -- 'imei' column kept from the beta version; it holds the raw id the device logged in with.
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imei TEXT NOT NULL,
    time TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    speed REAL,
    course REAL,
    satellites INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_positions_time ON positions(time);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                     -- ignition_on, ignition_off, alarm, ...
    message TEXT,
    time TEXT NOT NULL,
    latitude REAL,
    longitude REAL
  );
  CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, time);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS recharges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    recharged_on TEXT NOT NULL,             -- YYYY-MM-DD (local date)
    expires_on TEXT NOT NULL,               -- YYYY-MM-DD, last valid day
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recharges_device ON recharges(device_id, expires_on);

  CREATE TABLE IF NOT EXISTS recharge_notifications (
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    expires_on TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (device_id, expires_on, threshold)
  );
`);

// Columns/indexes added after the beta (safe to run on every start).
if (!db.prepare('PRAGMA table_info(positions)').all().some((c) => c.name === 'ignition')) {
  db.exec('ALTER TABLE positions ADD COLUMN ignition INTEGER'); // 1 on, 0 off, NULL unknown
}
// Per-device history lookups.
db.exec('CREATE INDEX IF NOT EXISTS idx_positions_imei_time ON positions(imei, time)');

/** Persistent secrets (session pepper is not needed: tokens are random). */
function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
}
function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { db, transaction, getMeta, setMeta, sha256 };
