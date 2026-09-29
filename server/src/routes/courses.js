import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { parse, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { canManageCourse } from '../access.js';

export const coursesRouter = Router();
coursesRouter.use(requireAuth);

// Courses the user owns (instructors/admins) or is enrolled in.
coursesRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.title, c.description, c.owner_id,
       (c.owner_id = $1 OR $2 = 'admin') AS can_manage
     FROM courses c
     WHERE $2 = 'admin' OR c.owner_id = $1
        OR EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = c.id AND e.user_id = $1 AND e.status = 'active'
                   AND (e.expires_at IS NULL OR e.expires_at > now()))
     ORDER BY c.created_at DESC`,
    [req.user.id, req.user.role],
  );
  res.json({ courses: rows.map((c) => ({ id: c.id, title: c.title, description: c.description, canManage: c.can_manage })) });
});

const courseSchema = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(5000).default('') });

coursesRouter.post('/', requireRole('instructor', 'admin'), async (req, res) => {
  const { title, description } = parse(courseSchema, req.body);
  const { rows } = await query('INSERT INTO courses (owner_id, title, description) VALUES ($1, $2, $3) RETURNING id, title, description', [
    req.user.id, title, description,
  ]);
  res.status(201).json({ course: { ...rows[0], canManage: true } });
});

async function requireCourseManager(req) {
  const { id } = parse(z.object({ id: z.uuid() }), req.params);
  if (!(await canManageCourse(req.user, id))) throw forbidden('You do not manage this course');
  return id;
}

coursesRouter.get('/:id/enrollments', async (req, res) => {
  const courseId = await requireCourseManager(req);
  const { rows } = await query(
    `SELECT u.id AS user_id, u.email, u.name, e.status, e.expires_at, e.created_at
     FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = $1 ORDER BY e.created_at DESC`,
    [courseId],
  );
  res.json({ enrollments: rows });
});

const enrollSchema = z.object({ email: z.string().transform((s) => s.toLowerCase()), expiresAt: z.iso.datetime().nullable().default(null) });

coursesRouter.post('/:id/enrollments', async (req, res) => {
  const courseId = await requireCourseManager(req);
  const { email, expiresAt } = parse(enrollSchema, req.body);
  const u = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (!u.rows[0]) throw notFound('No user with that email');
  await query(
    `INSERT INTO enrollments (user_id, course_id, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, course_id) DO UPDATE SET status = 'active', expires_at = EXCLUDED.expires_at`,
    [u.rows[0].id, courseId, expiresAt],
  );
  res.status(201).json({ ok: true });
});

// Revoking also kills the user's in-flight playback of this course's videos immediately.
coursesRouter.delete('/:id/enrollments/:userId', async (req, res) => {
  const courseId = await requireCourseManager(req);
  const { userId } = parse(z.object({ userId: z.uuid() }), { userId: req.params.userId });
  await query(`UPDATE enrollments SET status = 'revoked' WHERE course_id = $1 AND user_id = $2`, [courseId, userId]);
  await query(
    `UPDATE playback_sessions ps SET status = 'REVOKED', ended_at = now(), end_reason = 'enrollment_revoked'
     FROM videos v WHERE ps.video_id = v.id AND v.course_id = $1 AND ps.user_id = $2 AND ps.status = 'ACTIVE'`,
    [courseId, userId],
  );
  res.status(204).end();
});
