import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { notFound, parse } from '../errors.js';
import { requireAuth } from '../auth.js';
import { WATCHABLE_SQL, canManageVideo } from '../access.js';

export const videosRouter = Router();
videosRouter.use(requireAuth);

// Deliberately excludes source_key, hls_prefix and upload_id: storage layout never leaves the server.
const COLUMNS = `v.id, v.title, v.description, v.access, v.status, v.course_id, c.title AS course_title,
  v.duration_seconds, v.owner_id, v.created_at,
  (SELECT coalesce(json_agg(r->>'name'), '[]') FROM jsonb_array_elements(v.renditions) r) AS qualities`;

function toDto(row, user) {
  const manage = canManageVideo(user, row);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    access: row.access,
    status: row.status,
    courseId: row.course_id,
    courseTitle: row.course_title,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    qualities: row.qualities,
    createdAt: row.created_at,
    canManage: manage,
    ...(manage && { error: row.error ?? null, progress: row.progress ?? null }),
  };
}

videosRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT ${COLUMNS}, v.error,
       (SELECT j.progress FROM video_processing_jobs j WHERE j.video_id = v.id ORDER BY j.created_at DESC LIMIT 1) AS progress
     FROM videos v LEFT JOIN courses c ON c.id = v.course_id
     WHERE ${WATCHABLE_SQL}
     ORDER BY v.created_at DESC LIMIT 200`,
    [req.user.id, req.user.role],
  );
  res.json({ videos: rows.map((r) => toDto(r, req.user)) });
});

const idSchema = z.object({ id: z.uuid() });

videosRouter.get('/:id', async (req, res) => {
  const { id } = parse(idSchema, req.params);
  const { rows } = await query(
    `SELECT ${COLUMNS}, v.error,
       (SELECT j.progress FROM video_processing_jobs j WHERE j.video_id = v.id ORDER BY j.created_at DESC LIMIT 1) AS progress
     FROM videos v LEFT JOIN courses c ON c.id = v.course_id
     WHERE v.id = $3 AND ${WATCHABLE_SQL}`,
    [req.user.id, req.user.role, id],
  );
  // 404 (not 403) for videos the user can't see, so IDs can't be probed.
  if (!rows[0]) throw notFound('Video not found');
  res.json({ video: toDto(rows[0], req.user) });
});
