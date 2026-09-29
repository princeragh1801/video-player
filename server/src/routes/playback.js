// Secure playback.
//
// 1. POST /api/playback            (access token)  -> checks authorization + concurrent-stream limit,
//                                                     opens a playback session, returns a short-lived
//                                                     playback token bound to that session.
// 2. GET  /api/playback/:sid/...   (playback token) -> master/variant playlists and segments, streamed
//                                                     from the private bucket. The token travels in the
//                                                     Authorization header, never in the URL, so a copied
//                                                     URL is useless on its own; and the token itself
//                                                     expires in ~2 minutes unless the player heartbeats.
// 3. POST /api/playback/:sid/heartbeat              -> re-checks authorization, rotates the token.
//
// Playlists use relative URIs, so everything resolves under /api/playback/:sid/ and no R2 URL
// (permanent or presigned) ever reaches the browser.
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { parse, notFound, unauthorized, conflict, forbidden } from '../errors.js';
import { requireAuth, signPlaybackToken, verifyPlaybackToken } from '../auth.js';
import { canWatch } from '../access.js';
import { limits } from '../rateLimit.js';
import { config } from '../config.js';
import * as storage from '../storage.js';
import { logger } from '../logger.js';

export const playbackRouter = Router();
const { playback } = config;

const RENDITION_RE = /^[0-9]{3,4}p$/;
const SEGMENT_RE = /^seg_[0-9]{5}\.ts$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicSession(s) {
  return {
    id: s.id, videoId: s.video_id, videoTitle: s.title ?? null, deviceId: s.device_id,
    userAgent: s.user_agent, startedAt: s.created_at, lastSeenAt: s.last_heartbeat_at,
  };
}

// ---------------------------------------------------------------- session lifecycle (access token)

const startSchema = z.object({ videoId: z.uuid(), deviceId: z.string().min(8).max(100) });

playbackRouter.post('/', requireAuth, limits.playbackStart, async (req, res) => {
  const { videoId, deviceId } = parse(startSchema, req.body);
  const { rows: vrows } = await query('SELECT status FROM videos WHERE id = $1', [videoId]);
  if (!vrows[0] || !(await canWatch(req.user, videoId))) throw notFound('Video not found');
  if (vrows[0].status !== 'READY') throw conflict('Video is not ready for playback', 'NOT_READY');

  const session = await withTransaction(async (db) => {
    // Serialize session creation per user so two tabs can't race past the limit.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.user.id]);
    await db.query(
      `UPDATE playback_sessions SET status = 'ENDED', ended_at = now(), end_reason = 'stale'
       WHERE user_id = $1 AND status = 'ACTIVE' AND last_heartbeat_at < now() - make_interval(secs => $2)`,
      [req.user.id, playback.sessionStaleSeconds],
    );
    // One stream per device: reopening the player on the same device replaces its old session.
    await db.query(
      `UPDATE playback_sessions SET status = 'ENDED', ended_at = now(), end_reason = 'replaced'
       WHERE user_id = $1 AND device_id = $2 AND status = 'ACTIVE'`,
      [req.user.id, deviceId],
    );
    const active = await db.query(
      `SELECT ps.*, v.title FROM playback_sessions ps JOIN videos v ON v.id = ps.video_id
       WHERE ps.user_id = $1 AND ps.status = 'ACTIVE' ORDER BY ps.created_at`,
      [req.user.id],
    );
    if (req.user.role !== 'admin' && active.rows.length >= playback.maxConcurrentSessions) {
      const err = conflict(`You are already watching on ${active.rows.length} device(s). Stop one to continue.`, 'CONCURRENT_LIMIT');
      err.details = { sessions: active.rows.map(publicSession), limit: playback.maxConcurrentSessions };
      throw err;
    }
    const { rows } = await db.query(
      `INSERT INTO playback_sessions (user_id, video_id, device_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, videoId, deviceId, req.ip, req.get('user-agent')?.slice(0, 500)],
    );
    return rows[0];
  });

  const { rows: urows } = await query('SELECT email FROM users WHERE id = $1', [req.user.id]);
  const token = await signPlaybackToken({ sessionId: session.id, userId: req.user.id, videoId });
  logger.info({ userId: req.user.id, videoId, sessionId: session.id }, 'playback session started');

  res.set('Cache-Control', 'no-store').status(201).json({
    sessionId: session.id,
    token,
    expiresIn: playback.tokenTtlSeconds,
    heartbeatInterval: playback.heartbeatIntervalSeconds,
    manifestUrl: `/api/playback/${session.id}/master.m3u8`,
    // Server-issued so the watermark always names the account that actually opened the session.
    watermark: `${urows[0].email} · ${session.id.slice(0, 8)}`,
  });
});

playbackRouter.get('/sessions', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT ps.*, v.title FROM playback_sessions ps JOIN videos v ON v.id = ps.video_id
     WHERE ps.user_id = $1 AND ps.status = 'ACTIVE' AND ps.last_heartbeat_at > now() - make_interval(secs => $2)
     ORDER BY ps.created_at`,
    [req.user.id, playback.sessionStaleSeconds],
  );
  res.json({ sessions: rows.map(publicSession), limit: playback.maxConcurrentSessions });
});

// Lets a user free a slot by stopping playback on another device.
playbackRouter.delete('/sessions/:id', requireAuth, async (req, res) => {
  const { id } = parse(z.object({ id: z.uuid() }), req.params);
  await query(
    `UPDATE playback_sessions SET status = 'REVOKED', ended_at = now(), end_reason = 'revoked_by_user'
     WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [id, req.user.id],
  );
  sessionCache.delete(id);
  res.status(204).end();
});

// ---------------------------------------------------------------- media delivery (playback token)

// Tiny TTL cache: segment requests arrive every few seconds per viewer; this keeps the DB off the
// hot path while still honoring revocation within a few seconds.
const SESSION_CACHE_MS = 5_000;
const sessionCache = new Map();

async function loadSession(sessionId) {
  const hit = sessionCache.get(sessionId);
  if (hit && hit.at > Date.now() - SESSION_CACHE_MS) return hit.value;
  const { rows } = await query(
    `SELECT ps.id, ps.user_id, ps.video_id, ps.status, ps.last_heartbeat_at, v.hls_prefix, v.renditions, v.status AS video_status
     FROM playback_sessions ps JOIN videos v ON v.id = ps.video_id WHERE ps.id = $1`,
    [sessionId],
  );
  const value = rows[0] ?? null;
  if (sessionCache.size > 10_000) sessionCache.clear();
  sessionCache.set(sessionId, { at: Date.now(), value });
  return value;
}

// Validates token ↔ URL ↔ session ↔ user ↔ video all agree, and that the session is alive.
async function authorizeMedia(req, { allowStale = false } = {}) {
  const claims = await verifyPlaybackToken(req);
  const { sessionId } = req.params;
  if (!UUID_RE.test(sessionId) || claims.sessionId !== sessionId) throw unauthorized('Token does not match session', 'SESSION_MISMATCH');
  const s = await loadSession(sessionId);
  if (!s || s.user_id !== claims.userId || s.video_id !== claims.videoId) throw unauthorized('Unknown session', 'SESSION_ENDED');
  const stale = Date.now() - new Date(s.last_heartbeat_at).getTime() > playback.sessionStaleSeconds * 1000;
  if (s.status !== 'ACTIVE' || (stale && !allowStale)) throw unauthorized('Playback session has ended', 'SESSION_ENDED');
  if (s.video_status !== 'READY') throw notFound();
  return { claims, session: s };
}

// Playlists are immutable once a video is READY, so cache their text in memory.
const playlistCache = new Map();
async function readPlaylist(key) {
  if (playlistCache.has(key)) return playlistCache.get(key);
  let text;
  try {
    const obj = await storage.getObject(key);
    text = await obj.Body.transformToString();
  } catch (err) {
    if (err.name === 'NoSuchKey') throw notFound();
    throw err;
  }
  if (playlistCache.size > 2_000) playlistCache.clear();
  playlistCache.set(key, text);
  return text;
}

const NO_STORE = 'private, no-store, max-age=0';

function sendPlaylist(res, text) {
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': NO_STORE }).send(text);
}

playbackRouter.get('/:sessionId/master.m3u8', limits.media, async (req, res) => {
  const { session } = await authorizeMedia(req);
  sendPlaylist(res, await readPlaylist(`${session.hls_prefix}/master.m3u8`));
});

function checkRendition(session, rendition) {
  if (!RENDITION_RE.test(rendition) || !session.renditions.some((r) => r.name === rendition)) throw notFound();
}

playbackRouter.get('/:sessionId/:rendition/index.m3u8', limits.media, async (req, res) => {
  const { session } = await authorizeMedia(req);
  checkRendition(session, req.params.rendition);
  sendPlaylist(res, await readPlaylist(`${session.hls_prefix}/${req.params.rendition}/index.m3u8`));
});

playbackRouter.get('/:sessionId/:rendition/:segment', limits.media, async (req, res) => {
  const { session } = await authorizeMedia(req);
  const { rendition, segment } = req.params;
  checkRendition(session, rendition);
  if (!SEGMENT_RE.test(segment)) throw notFound();

  let obj;
  try {
    obj = await storage.getObject(`${session.hls_prefix}/${rendition}/${segment}`);
  } catch (err) {
    if (err.name === 'NoSuchKey') throw notFound();
    throw err;
  }
  res.set({ 'Content-Type': 'video/mp2t', 'Cache-Control': NO_STORE });
  if (obj.ContentLength !== undefined) res.set('Content-Length', String(obj.ContentLength));
  try {
    await pipeline(obj.Body, res);
  } catch (err) {
    // Client navigated away / aborted — normal during seeking and quality switches.
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.warn({ err }, 'segment stream failed');
  }
});

// ---------------------------------------------------------------- heartbeat / end

const heartbeatSchema = z.object({ position: z.number().min(0).max(1e6).default(0) });

playbackRouter.post('/:sessionId/heartbeat', limits.heartbeat, async (req, res) => {
  const { position } = parse(heartbeatSchema, req.body ?? {});
  const { claims } = await authorizeMedia(req);

  // Re-check entitlement: an expired enrollment/subscription stops playback within one heartbeat.
  const { rows: urows } = await query('SELECT id, role FROM users WHERE id = $1', [claims.userId]);
  if (!urows[0] || !(await canWatch(urows[0], claims.videoId))) {
    await query(`UPDATE playback_sessions SET status = 'REVOKED', ended_at = now(), end_reason = 'access_lost' WHERE id = $1`, [claims.sessionId]);
    sessionCache.delete(claims.sessionId);
    throw forbidden('Access to this video has ended', 'ACCESS_LOST');
  }

  const { rowCount } = await query(
    `UPDATE playback_sessions SET last_heartbeat_at = now(), last_position = $2
     WHERE id = $1 AND status = 'ACTIVE' AND last_heartbeat_at > now() - make_interval(secs => $3)`,
    [claims.sessionId, position, playback.sessionStaleSeconds],
  );
  sessionCache.delete(claims.sessionId);
  if (rowCount === 0) throw unauthorized('Playback session has ended', 'SESSION_ENDED');

  const token = await signPlaybackToken(claims);
  res.set('Cache-Control', 'no-store').json({ token, expiresIn: playback.tokenTtlSeconds });
});

playbackRouter.post('/:sessionId/end', limits.heartbeat, async (req, res) => {
  const { claims } = await authorizeMedia(req, { allowStale: true });
  await query(
    `UPDATE playback_sessions SET status = 'ENDED', ended_at = now(), end_reason = 'client_end' WHERE id = $1 AND status = 'ACTIVE'`,
    [claims.sessionId],
  );
  sessionCache.delete(claims.sessionId);
  res.status(204).end();
});
