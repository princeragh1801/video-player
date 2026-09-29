// Central config. Fails fast on missing secrets so a misconfigured deploy never boots.
const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function int(name, fallback) {
  const v = env[name];
  return v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
}

const isProd = env.NODE_ENV === 'production';

function secret(name) {
  const v = required(name);
  if (v.length < 32) throw new Error(`${name} must be at least 32 characters`);
  if (isProd && v.startsWith('dev-only')) throw new Error(`${name} is still the local-dev default; set a real secret`);
  return v;
}

export const config = {
  isProd,
  port: int('PORT', 4000),
  // Comma-separated list of browser origins allowed to call the API.
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  // Number of reverse proxies in front of the API (for correct client IPs / HTTPS detection).
  trustProxy: int('TRUST_PROXY', 1),
  forceHttps: env.FORCE_HTTPS === 'true',

  databaseUrl: required('DATABASE_URL'),
  redisUrl: env.REDIS_URL || 'redis://localhost:6379',

  auth: {
    accessSecret: new TextEncoder().encode(secret('JWT_ACCESS_SECRET')),
    accessTtlSeconds: int('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),
    refreshTtlSeconds: int('REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 3600),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  },

  playback: {
    // Separate key: a leaked playback token can never be used as an API access token and vice versa.
    secret: new TextEncoder().encode(secret('PLAYBACK_TOKEN_SECRET')),
    tokenTtlSeconds: int('PLAYBACK_TOKEN_TTL_SECONDS', 120),
    heartbeatIntervalSeconds: int('PLAYBACK_HEARTBEAT_SECONDS', 30),
    // A session with no heartbeat for this long is considered dead and stops counting toward limits.
    sessionStaleSeconds: int('PLAYBACK_SESSION_STALE_SECONDS', 90),
    maxConcurrentSessions: int('MAX_CONCURRENT_STREAMS', 2),
  },

  storage: {
    // Cloudflare R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com ; locally MinIO.
    endpoint: required('S3_ENDPOINT'),
    // Endpoint the *browser* uses for presigned upload URLs. Same as endpoint for R2.
    presignEndpoint: env.S3_PRESIGN_ENDPOINT || required('S3_ENDPOINT'),
    region: env.S3_REGION || 'auto',
    bucket: required('S3_BUCKET'),
    // Optional folder inside the bucket, e.g. "videos/" → videos/sources/..., videos/hls/...
    keyPrefix: (env.S3_KEY_PREFIX || '').replace(/^\/+|\/+$/g, '').replace(/.+/, (p) => `${p}/`),
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  },

  upload: {
    maxBytes: int('MAX_UPLOAD_BYTES', 10 * 1024 ** 3),
    presignTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 15 * 60),
  },

  worker: {
    concurrency: int('WORKER_CONCURRENCY', 1),
    tmpDir: env.WORKER_TMP_DIR || '/tmp',
    maxDurationSeconds: int('MAX_VIDEO_DURATION_SECONDS', 4 * 3600),
    deleteSourceAfterProcessing: env.DELETE_SOURCE_AFTER_PROCESSING === 'true',
  },
};
