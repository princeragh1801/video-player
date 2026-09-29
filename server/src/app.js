import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { HttpError } from './errors.js';
import { limits } from './rateLimit.js';
import { authRouter } from './routes/auth.js';
import { uploadsRouter } from './routes/uploads.js';
import { videosRouter } from './routes/videos.js';
import { coursesRouter } from './routes/courses.js';
import { playbackRouter } from './routes/playback.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  if (config.forceHttps) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, `https://${req.hostname}${req.originalUrl}`);
      res.status(403).json({ error: 'HTTPS required' });
    });
  }

  app.use(
    helmet({
      // JSON/media API: nothing here should ever be framed or render active content.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // Strict allowlist. Credentials are needed for the refresh cookie.
  app.use(
    cors({
      origin(origin, cb) {
        // No Origin = same-origin navigation or server-to-server; allowed (auth still applies).
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => /\.ts$/.test(req.url) || req.url === '/healthz' } }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Cookie-authenticated endpoints: reject cross-site requests outright (defense in depth over SameSite=Strict).
  app.use('/api/auth', (req, res, next) => {
    const origin = req.get('origin');
    if (req.method === 'POST' && origin && !config.corsOrigins.includes(origin)) return res.status(403).json({ error: 'Bad origin' });
    next();
  });
  app.use('/api/auth', authRouter);
  app.use('/api/playback', playbackRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/videos', limits.api, videosRouter);
  app.use('/api/courses', limits.api, coursesRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    req.log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
