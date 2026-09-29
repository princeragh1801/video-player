// Direct-to-R2 multipart upload. The API only brokers presigned part URLs; video bytes never
// pass through it. The source object key is never returned to the client.
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db.js';
import { parse, badRequest, forbidden, notFound, conflict } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { canManageCourse, canManageVideo } from '../access.js';
import { config } from '../config.js';
import { limits } from '../rateLimit.js';
import { enqueueTranscode } from '../queue.js';
import * as storage from '../storage.js';
import { logger } from '../logger.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth, requireRole('instructor', 'admin'), limits.upload);

const MIN_PART = 10 * 1024 * 1024;
const MAX_PARTS = 10_000;

// Grow the part size for huge files so we stay under the 10k-part S3/R2 limit.
function partSizeFor(size) {
  const mib = 1024 * 1024;
  return Math.max(MIN_PART, Math.ceil(size / MAX_PARTS / mib) * mib);
}

const ALLOWED_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo', 'video/mpeg']);

const initSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  courseId: z.uuid().nullable().default(null),
  access: z.enum(['course', 'subscription', 'private']).default('course'),
  fileSize: z.number().int().positive(),
  contentType: z.string(),
});

uploadsRouter.post('/', async (req, res) => {
  const body = parse(initSchema, req.body);
  if (body.fileSize > config.upload.maxBytes) throw badRequest(`File exceeds ${config.upload.maxBytes} bytes`, 'TOO_LARGE');
  if (!ALLOWED_TYPES.has(body.contentType)) throw badRequest('Unsupported video type', 'BAD_TYPE');
  if (body.access === 'course' && !body.courseId) throw badRequest('courseId is required for course videos');
  if (body.courseId && !(await canManageCourse(req.user, body.courseId))) throw forbidden('You do not own this course');

  const { rows } = await query(
    `INSERT INTO videos (owner_id, course_id, title, description, access, source_key, source_size, source_content_type)
     VALUES ($1, $2, $3, $4, $5, '', $6, $7) RETURNING id`,
    [req.user.id, body.courseId, body.title, body.description, body.access, body.fileSize, body.contentType],
  );
  const videoId = rows[0].id;
  const key = storage.keys.source(videoId);
  const uploadId = await storage.createMultipartUpload(key, body.contentType);
  await query('UPDATE videos SET source_key = $2, upload_id = $3 WHERE id = $1', [videoId, key, uploadId]);

  const partSize = partSizeFor(body.fileSize);
  res.status(201).json({ videoId, partSize, partCount: Math.ceil(body.fileSize / partSize) });
});

async function loadUploadingVideo(req) {
  const { rows } = await query('SELECT * FROM videos WHERE id = $1', [req.params.videoId]);
  const video = rows[0];
  if (!video || !canManageVideo(req.user, video)) throw notFound('Upload not found');
  if (video.status !== 'UPLOADING' || !video.upload_id) throw conflict('Upload is not in progress', 'NOT_UPLOADING');
  return video;
}

const partsSchema = z.object({ partNumbers: z.array(z.number().int().min(1).max(MAX_PARTS)).min(1).max(100) });

uploadsRouter.post('/:videoId/parts', async (req, res) => {
  const { partNumbers } = parse(partsSchema, req.body);
  const video = await loadUploadingVideo(req);
  const maxPart = Math.ceil(Number(video.source_size) / partSizeFor(Number(video.source_size)));
  if (partNumbers.some((n) => n > maxPart)) throw badRequest('Part number out of range');
  const urls = await Promise.all(
    partNumbers.map(async (partNumber) => ({ partNumber, url: await storage.presignUploadPart(video.source_key, video.upload_id, partNumber) })),
  );
  res.json({ urls, expiresIn: config.upload.presignTtlSeconds });
});

const completeSchema = z.object({
  parts: z.array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1).max(200) })).min(1).max(MAX_PARTS),
});

uploadsRouter.post('/:videoId/complete', async (req, res) => {
  const { parts } = parse(completeSchema, req.body);
  const video = await loadUploadingVideo(req);
  parts.sort((a, b) => a.partNumber - b.partNumber);

  try {
    await storage.completeMultipartUpload(video.source_key, video.upload_id, parts);
  } catch (err) {
    logger.warn({ err, videoId: video.id }, 'complete multipart failed');
    throw badRequest('Could not complete upload — some parts are missing or invalid', 'COMPLETE_FAILED');
  }

  // Trust the object store, not the client: the stored size must match what was declared.
  const head = await storage.headObject(video.source_key);
  if (Number(head.ContentLength) !== Number(video.source_size)) {
    await storage.deleteObject(video.source_key).catch(() => {});
    await query(`UPDATE videos SET status = 'FAILED', error = 'Uploaded size mismatch', upload_id = NULL, updated_at = now() WHERE id = $1`, [video.id]);
    throw badRequest('Uploaded size does not match declared size', 'SIZE_MISMATCH');
  }

  const jobId = await withTransaction(async (db) => {
    const moved = await db.query(
      `UPDATE videos SET status = 'PROCESSING', upload_id = NULL, updated_at = now() WHERE id = $1 AND status = 'UPLOADING'`,
      [video.id],
    );
    if (moved.rowCount === 0) throw conflict('Upload already completed', 'NOT_UPLOADING');
    const { rows } = await db.query('INSERT INTO video_processing_jobs (video_id) VALUES ($1) RETURNING id', [video.id]);
    return rows[0].id;
  });
  await enqueueTranscode({ videoId: video.id, jobId });
  res.json({ videoId: video.id, status: 'PROCESSING', jobId });
});

uploadsRouter.post('/:videoId/abort', async (req, res) => {
  const video = await loadUploadingVideo(req);
  await storage.abortMultipartUpload(video.source_key, video.upload_id).catch(() => {});
  await query(`UPDATE videos SET status = 'FAILED', error = 'Upload aborted', upload_id = NULL, updated_at = now() WHERE id = $1`, [video.id]);
  res.status(204).end();
});
