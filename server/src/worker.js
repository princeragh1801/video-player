// Background worker: consumes transcode jobs so FFmpeg never runs inside an API request.
import { Worker } from 'bullmq';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { config } from './config.js';
import { query } from './db.js';
import { logger } from './logger.js';
import { createRedis } from './redis.js';
import { VIDEO_QUEUE } from './queue.js';
import * as storage from './storage.js';
import { probe, planRenditions, transcodeToHls } from './transcode.js';

const CONTENT_TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

async function uploadDir(localDir, prefix, concurrency = 8) {
  const files = await listFiles(localDir);
  let next = 0;
  async function lane() {
    while (next < files.length) {
      const file = files[next++];
      const rel = path.relative(localDir, file).split(path.sep).join('/');
      const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
      await storage.putObject(`${prefix}/${rel}`, await readFile(file), type, 'private, no-store');
    }
  }
  await Promise.all(Array.from({ length: concurrency }, lane));
  return files.length;
}

async function setProgress(jobId, progress) {
  await query('UPDATE video_processing_jobs SET progress = $2 WHERE id = $1', [jobId, progress]);
}

async function processJob(job) {
  const { videoId, jobId } = job.data;
  const log = logger.child({ videoId, jobId, attempt: job.attemptsMade + 1 });
  const { rows } = await query('SELECT * FROM videos WHERE id = $1', [videoId]);
  const video = rows[0];
  if (!video) return log.warn('video deleted, skipping');

  await query(`UPDATE video_processing_jobs SET status = 'RUNNING', attempts = attempts + 1, started_at = now(), error = NULL WHERE id = $1`, [jobId]);
  await query(`UPDATE videos SET status = 'PROCESSING', error = NULL, updated_at = now() WHERE id = $1`, [videoId]);

  const work = await mkdtemp(path.join(config.worker.tmpDir, `vid-${videoId}-`));
  try {
    const input = path.join(work, 'source');
    log.info('downloading source');
    const obj = await storage.getObject(video.source_key);
    await pipeline(obj.Body, createWriteStream(input));

    const meta = await probe(input);
    if (meta.duration > config.worker.maxDurationSeconds) throw new Error(`Video too long (${Math.round(meta.duration)}s)`);
    const renditions = planRenditions(meta);
    log.info({ meta, renditions: renditions.map((r) => r.name) }, 'transcoding');

    const outDir = path.join(work, 'hls');
    await transcodeToHls({
      input, outDir, meta, renditions,
      onProgress: (pct) => {
        job.updateProgress(pct).catch(() => {});
        setProgress(jobId, pct).catch(() => {});
      },
    });

    const prefix = storage.keys.hlsPrefix(videoId);
    const count = await uploadDir(outDir, prefix);
    log.info({ files: count }, 'uploaded HLS output');

    await query(
      `UPDATE videos SET status = 'READY', hls_prefix = $2, duration_seconds = $3, renditions = $4, error = NULL, updated_at = now() WHERE id = $1`,
      [videoId, prefix, meta.duration, JSON.stringify(renditions.map((r) => ({ name: r.name, width: r.width, height: r.height, bitrate: r.vbr })))],
    );
    await query(`UPDATE video_processing_jobs SET status = 'SUCCEEDED', progress = 100, finished_at = now() WHERE id = $1`, [jobId]);
    if (config.worker.deleteSourceAfterProcessing) await storage.deleteObject(video.source_key);
    log.info('video ready');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const worker = new Worker(VIDEO_QUEUE, processJob, {
  connection: createRedis(),
  concurrency: config.worker.concurrency,
  // Long FFmpeg runs: keep the job lock alive and don't treat slow jobs as stalled.
  lockDuration: 5 * 60_000,
});

worker.on('failed', async (job, err) => {
  if (!job) return;
  const { videoId, jobId } = job.data;
  const final = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.error({ err, videoId, jobId, attempt: job.attemptsMade, final }, 'transcode failed');
  const msg = String(err.message).slice(0, 2000);
  await query(`UPDATE video_processing_jobs SET status = $2, error = $3, finished_at = CASE WHEN $4 THEN now() END WHERE id = $1`, [
    jobId, final ? 'FAILED' : 'QUEUED', msg, final,
  ]);
  if (final) await query(`UPDATE videos SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1`, [videoId, msg]);
});

worker.on('ready', () => logger.info({ concurrency: config.worker.concurrency }, 'worker ready'));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    logger.info('worker shutting down');
    await worker.close();
    process.exit(0);
  });
}
