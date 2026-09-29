// Authorization policy: who may watch / manage a video. Single source of truth for the API.
import { query } from './db.js';

// SQL predicate mirroring canWatch(), used for listing. $1 = user id, $2 = user role.
export const WATCHABLE_SQL = `(
  $2 = 'admin'
  OR v.owner_id = $1
  OR (v.status = 'READY' AND (
    (v.access = 'course' AND (
      EXISTS (SELECT 1 FROM courses c WHERE c.id = v.course_id AND c.owner_id = $1)
      OR EXISTS (SELECT 1 FROM enrollments e WHERE e.course_id = v.course_id AND e.user_id = $1
                 AND e.status = 'active' AND (e.expires_at IS NULL OR e.expires_at > now()))
    ))
    OR (v.access = 'subscription' AND EXISTS (
      SELECT 1 FROM subscriptions s WHERE s.user_id = $1 AND s.status = 'active' AND s.current_period_end > now()
    ))
  ))
)`;

export async function canWatch(user, videoId) {
  const { rows } = await query(`SELECT 1 FROM videos v WHERE v.id = $3 AND ${WATCHABLE_SQL}`, [user.id, user.role, videoId]);
  return rows.length > 0;
}

export function canManageVideo(user, video) {
  return user.role === 'admin' || video.owner_id === user.id;
}

export async function canManageCourse(user, courseId) {
  if (user.role === 'admin') return true;
  const { rows } = await query('SELECT 1 FROM courses WHERE id = $1 AND owner_id = $2', [courseId, user.id]);
  return rows.length > 0;
}
