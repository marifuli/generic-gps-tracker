'use strict';
const webpush = require('web-push');
const config = require('./config');
const { db, getMeta, setMeta } = require('./db');

function init() {
  let pub = getMeta('vapid_public');
  let priv = getMeta('vapid_private');
  if (!pub || !priv) {
    ({ publicKey: pub, privateKey: priv } = webpush.generateVAPIDKeys());
    setMeta('vapid_public', pub);
    setMeta('vapid_private', priv);
  }
  webpush.setVapidDetails(config.vapidSubject, pub, priv);
  return pub;
}
const publicKey = init();

function save(userId, sub, userAgent) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid subscription');
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
      auth = excluded.auth, user_agent = excluded.user_agent
  `).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, (userAgent || '').slice(0, 200));
}

function remove(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

function count(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
}

/**
 * Push `{title, body, url, tag}` to every device the user subscribed.
 * Returns the number of successful deliveries.
 */
async function sendToUser(userId, payload, { urgency = 'high', ttl = 86400 } = {}) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  const body = JSON.stringify(payload);
  let ok = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: ttl, urgency },
      );
      ok += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.error('[push] failed:', err.statusCode || '', err.body || err.message);
      }
    }
  }));
  return ok;
}

module.exports = { publicKey, save, remove, count, sendToUser };
