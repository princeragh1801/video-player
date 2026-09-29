import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from './redis.js';

// Redis-backed so limits hold across every API replica.
function limiter(prefix, { windowMs, limit, key }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: key ?? ((req) => ipKeyGenerator(req.ip)),
    store: new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (cmd, ...args) => redis.call(cmd, ...args) }),
    message: { error: 'Too many requests, slow down.', code: 'RATE_LIMITED' },
  });
}

const byUser = (req) => req.user?.id ?? ipKeyGenerator(req.ip);

export const limits = {
  // Brute-force protection: per IP, and per target email.
  login: limiter('login', { windowMs: 15 * 60_000, limit: 20 }),
  loginPerEmail: limiter('login-email', {
    windowMs: 15 * 60_000,
    limit: 10,
    key: (req) => `e:${String(req.body?.email ?? '').toLowerCase()}`,
  }),
  register: limiter('register', { windowMs: 60 * 60_000, limit: 10 }),
  refresh: limiter('refresh', { windowMs: 60_000, limit: 30 }),
  api: limiter('api', { windowMs: 60_000, limit: 300, key: byUser }),
  upload: limiter('upload', { windowMs: 60_000, limit: 120, key: byUser }),
  // Starting playback mints tokens and sessions — keep it tight.
  playbackStart: limiter('pb-start', { windowMs: 60_000, limit: 15, key: byUser }),
  heartbeat: limiter('pb-hb', { windowMs: 60_000, limit: 10, key: (req) => `s:${req.params.sessionId}` }),
  // Playlists + segments: ~6s segments means ~10/min normal; generous for seeking & ABR switches,
  // but low enough to make bulk ripping through one session slow and noisy.
  media: limiter('pb-media', { windowMs: 60_000, limit: 240, key: (req) => `s:${req.params.sessionId}` }),
};
