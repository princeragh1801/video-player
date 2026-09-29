import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { parse, unauthorized, conflict } from '../errors.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, sha256, signAccessToken,
  issueRefreshToken, clearRefreshCookie, REFRESH_COOKIE, requireAuth,
} from '../auth.js';
import { limits } from '../rateLimit.js';

export const authRouter = Router();

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

async function sessionResponse(req, res, user) {
  await issueRefreshToken(res, user.id, req.get('user-agent'));
  res.json({ user: publicUser(user), accessToken: await signAccessToken(user) });
}

const registerSchema = z.object({
  email: z.email().max(254).transform((s) => s.toLowerCase()),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(10).max(200),
});

// Self-registration always creates a student; roles are granted by an admin.
authRouter.post('/register', limits.register, async (req, res) => {
  const { email, name, password } = parse(registerSchema, req.body);
  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING *`,
    [email, name, passwordHash],
  );
  if (!rows[0]) throw conflict('Email already registered', 'EMAIL_TAKEN');
  res.status(201);
  await sessionResponse(req, res, rows[0]);
});

const loginSchema = z.object({
  email: z.string().max(254).transform((s) => s.toLowerCase()),
  password: z.string().max(200),
});

authRouter.post('/login', limits.login, limits.loginPerEmail, async (req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Invalid email or password', 'BAD_CREDENTIALS');
  await sessionResponse(req, res, user);
});

// Rotating refresh: each refresh token is single-use. Presenting an already-used token means it
// was stolen (or replayed), so every session for that user is revoked.
authRouter.post('/refresh', limits.refresh, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw unauthorized('No refresh token', 'NO_SESSION');

  const user = await withTransaction(async (db) => {
    const { rows } = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(token)]);
    const rt = rows[0];
    if (!rt) return null;
    if (rt.revoked_at) {
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rt.user_id]);
      await db.query(
        `UPDATE playback_sessions SET status = 'REVOKED', ended_at = now(), end_reason = 'refresh_token_reuse'
         WHERE user_id = $1 AND status = 'ACTIVE'`,
        [rt.user_id],
      );
      return null;
    }
    if (rt.expires_at < new Date()) return null;
    await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rt.id]);
    const u = await db.query('SELECT * FROM users WHERE id = $1', [rt.user_id]);
    return u.rows[0] ?? null;
  });

  if (!user) {
    clearRefreshCookie(res);
    throw unauthorized('Session expired', 'NO_SESSION');
  }
  await sessionResponse(req, res, user);
});

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
  clearRefreshCookie(res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) throw unauthorized();
  res.json({ user: publicUser(rows[0]) });
});
