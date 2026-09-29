# Secure Video Streaming MVP

React + HLS.js player → Node/Express API → private Cloudflare R2 → BullMQ queue → FFmpeg worker → HLS ladder.

```
Browser ──(1) presigned multipart PUTs──────────────▶ R2 (private)  sources/<id>/original
   │                                                   ▲      │
   │(2) POST /uploads/:id/complete                     │      │ download
   ▼                                                   │      ▼
 API ──enqueue──▶ Redis/BullMQ ──▶ Worker (FFmpeg) ──upload──▶ hls/<id>/{240p..1080p}/seg_*.ts + master.m3u8
   ▲
   │(3) POST /playback  → auth + entitlement + device limit → session + 2-min playback token
   │(4) GET /playback/:sid/*.m3u8|*.ts  (Authorization: Bearer <playback token>) → streamed from R2
   └(5) POST /playback/:sid/heartbeat every 30s → re-checks access, rotates token
```

## Run it (fully local)

```bash
docker compose up -d --build
```

Open http://localhost:8080. Everything runs locally: Postgres, Redis, **SeaweedFS** (a private S3-compatible bucket, the same API as R2), the API, the FFmpeg worker and the web app. On boot the API creates the bucket, sets its CORS policy and seeds these demo users, all with the password `password1234`:
`instructor@example.com` (owns "Intro Course", can upload), `student@example.com` (enrolled), `outsider@example.com` (not enrolled), `admin@example.com`.

**Switching to Cloudflare R2 later:** in `.env`, set `S3_ENDPOINT` and `S3_PRESIGN_ENDPOINT` to `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, plus `S3_BUCKET` (and `S3_KEY_PREFIX` if you use a folder), the keys, `S3_FORCE_PATH_STYLE=false` and `STORAGE_AUTO_SETUP=false`. Then add this CORS policy in the R2 dashboard (bucket → Settings):
```json
[{ "AllowedOrigins": ["http://localhost:8080", "http://localhost:5173"],
   "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"],
   "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

**Frontend dev with hot reload:** `cd web && npm run dev` (http://localhost:5173, proxies `/api` to :4000).

**End-to-end check** (upload → transcode → 20 security assertions):
`cd server && node scripts/e2e.mjs path/to/video.mp4 http://localhost:8080`

## Security model

| Goal | How |
|---|---|
| Original MP4 never reaches clients | It lives at `sources/<id>/original` in a private bucket. The API never returns storage keys or URLs, and the only thing it presigns is **upload-part PUTs**. You can set `DELETE_SOURCE_AFTER_PROCESSING=true` to delete it after transcoding. |
| No permanent or direct R2 URLs | Playlists use relative URIs that resolve to `/api/playback/<session>/…`. The API streams each object from R2, so no R2 URL (permanent or presigned) is ever sent to the browser. |
| Copied URLs don't work | Every media request needs `Authorization: Bearer <playback token>` (a header, never the URL). The token is HS256, expires after **120s**, is bound to session + user + video, and uses a different key from API tokens. A copied URL returns 401 on its own, and even with the token it stops working within about 2 minutes. |
| Authorization before playback | `access.js` is the single policy: admin, video owner, course owner, active and unexpired enrollment (`access=course`), or active subscription (`access=subscription`). It's checked when a session starts **and on every heartbeat**. Revoking an enrollment also revokes the user's live sessions. |
| Session and device limits | A `playback_sessions` row per stream, with a heartbeat every 30s. Silent for 90s means stale. `MAX_CONCURRENT_STREAMS` (default 2) is enforced under a per-user advisory lock, and the player offers "stop the other one". Reopening on the same device replaces that device's old session. |
| Rate limiting (Redis, shared by all replicas) | Per-IP and per-email limits on login, per-user limits on starting playback (15/min), per-session limits on media (240/min) and heartbeat. |
| Auth | scrypt password hashes. The 15-minute access JWT is kept only in memory. The refresh token is an httpOnly `SameSite=Strict` cookie scoped to `/api/auth`, rotated on every use; reusing an old one revokes every session for that user. |
| Transport and browser | Helmet with HSTS in production, `FORCE_HTTPS`, strict CORS allowlist, CSP in nginx, `Cache-Control: no-store` on media. |
| Deterrents (not security) | Moving watermark with the account email and session ID. `controlsList="nodownload"`, PiP and remote playback disabled, context menu suppressed. |

**Limits, stated plainly:** anyone who is authorized can still screen-record, or write a script that uses their own live session to save the segments they're allowed to watch. Rate limits, session limits and the watermark make that slow and traceable, but they don't stop it. Stopping it needs the next steps below.

**Production notes:** put TLS in front (Caddy, nginx or Cloudflare), set `COOKIE_SECURE=true` and `NODE_ENV=production`, set `CORS_ORIGINS` to your real domain, and list that domain in the R2 CORS policy. Browsers without MSE (iOS before 17.1) are unsupported, because native HLS can't send the auth header.

## Where to extend

- **Encrypted HLS (AES-128)**: add `-hls_key_info_file` in [transcode.js](server/src/transcode.js), store keys per video, and serve them from `/api/playback/:sid/key` behind `authorizeMedia`. HLS.js sends key requests through the same `xhrSetup`.
- **CDN delivery at scale**: swap the proxying segment route in [playback.js](server/src/routes/playback.js) for a Cloudflare Worker bound to R2 that checks the same HMAC playback token at the edge. Playlists can stay on the API.
- **DRM (Widevine, FairPlay, PlayReady)**: package CMAF with CENC/CBCS (for example Shaka Packager) in the worker, and add a license proxy endpoint that uses the existing session check.
- **Forensic watermarking**: A/B segment variants chosen per session when the playlist is served.

## Layout

```
server/src/  config · db · auth · access (policy) · rateLimit · storage (R2) · queue
             routes/{auth,uploads,videos,courses,playback}.js · worker.js · transcode.js
             migrations/001_init.sql  (users, courses, enrollments, subscriptions, videos,
                                        video_processing_jobs, playback_sessions, refresh_tokens)
web/src/     player/{VideoPlayer,SeekBar,usePlaybackSession,Watermark} · components/ui (shadcn) · lib/* · pages/*
```
