import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { query } from './db.js';
import { unauthorized, forbidden } from './errors.js';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

// Compared against when the email doesn't exist, so login timing doesn't reveal registered emails.
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function signAccessToken(user) {
  return new SignJWT({ role: user.role, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${config.auth.accessTtlSeconds}s`)
    .setAudience('api')
    .sign(config.auth.accessSecret);
}

export const REFRESH_COOKIE = 'rt';

export async function issueRefreshToken(res, userId, userAgent) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.auth.refreshTtlSeconds * 1000);
  await query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)', [
    userId,
    sha256(token),
    expiresAt,
    userAgent?.slice(0, 500),
  ]);
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: '/api/auth',
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: config.auth.cookieSecure, sameSite: 'strict', path: '/api/auth' });
}

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function requireAuth(req, _res, next) {
  const token = bearer(req);
  if (!token) throw unauthorized('Missing access token');
  try {
    const { payload } = await jwtVerify(token, config.auth.accessSecret, { audience: 'api', algorithms: ['HS256'] });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    req.user = { id: payload.sub, role: payload.role };
  } catch {
    throw unauthorized('Invalid or expired access token', 'TOKEN_EXPIRED');
  }
  next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) throw forbidden('Insufficient role');
  next();
};

// --- Playback tokens: short-lived, bound to one playback session, user and video. ---

export function signPlaybackToken({ sessionId, userId, videoId }) {
  return new SignJWT({ sid: sessionId, vid: videoId, typ: 'playback' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${config.playback.tokenTtlSeconds}s`)
    .setAudience('playback')
    .sign(config.playback.secret);
}

export async function verifyPlaybackToken(req) {
  const token = bearer(req);
  if (!token) throw unauthorized('Missing playback token');
  try {
    const { payload } = await jwtVerify(token, config.playback.secret, { audience: 'playback', algorithms: ['HS256'] });
    if (payload.typ !== 'playback') throw new Error('wrong token type');
    return { sessionId: payload.sid, userId: payload.sub, videoId: payload.vid };
  } catch {
    throw unauthorized('Invalid or expired playback token', 'PLAYBACK_TOKEN_EXPIRED');
  }
}
