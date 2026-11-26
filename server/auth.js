'use strict';
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const config = require('./config');
const { db, sha256 } = require('./db');

const googleClient = new OAuth2Client();
const COOKIE = 'sid';
const DAY = 86400000;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isAdminEmail = (email) => config.adminEmails.includes(String(email).toLowerCase());

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture, isAdmin: isAdminEmail(u.email) };
}

async function verifyGoogleCredential(credential) {
  if (!config.googleClientId) throw httpError(500, 'GOOGLE_CLIENT_ID is not configured on the server');
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.googleClientId });
    payload = ticket.getPayload();
  } catch {
    throw httpError(401, 'Invalid Google credential');
  }
  if (!payload?.sub || !payload.email || !payload.email_verified) throw httpError(401, 'Google account email is not verified');
  const email = payload.email.toLowerCase();
  if (config.allowedEmails.length && !config.allowedEmails.includes(email) && !isAdminEmail(email)) {
    throw httpError(403, 'This account is not allowed to use this tracker');
  }
  return { sub: payload.sub, email, name: payload.name || email, picture: payload.picture || null };
}

function upsertUser(g) {
  db.prepare(`
    INSERT INTO users (google_sub, email, name, picture, last_login)
    VALUES (@sub, @email, @name, @picture, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(google_sub) DO UPDATE SET
      email = excluded.email, name = excluded.name, picture = excluded.picture, last_login = excluded.last_login
  `).run(g);
  return db.prepare('SELECT * FROM users WHERE google_sub = ?').get(g.sub);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    sha256(token), userId, new Date(now).toISOString(), new Date(now + config.sessionDays * DAY).toISOString(),
  );
  return token;
}

function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sha256(token));
  if (!row) return null;
  const expires = Date.parse(row.session_expires);
  if (expires < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  // sliding expiry: refresh once less than half the lifetime is left
  if (expires - Date.now() < (config.sessionDays * DAY) / 2) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
      new Date(Date.now() + config.sessionDays * DAY).toISOString(), sha256(token),
    );
  }
  return row;
}

const userFromRequest = (req) => userFromToken(parseCookies(req.headers.cookie)[COOKIE]);

function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: config.sessionDays * DAY, path: '/',
  });
}

function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  req.isAdmin = isAdminEmail(user.email);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Admins only' });
  next();
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Tiny fixed-window limiter keyed by string. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    h.n += 1;
    return h.n <= max;
  };
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString()), 6 * 3600 * 1000).unref();

module.exports = {
  verifyGoogleCredential, upsertUser, createSession, userFromToken, userFromRequest, parseCookies,
  setSessionCookie, clearSession, requireAuth, requireAdmin, publicUser, isAdminEmail, httpError, rateLimiter,
};
