// Demo seed: an admin, an instructor with a course, an enrolled student and a non-enrolled student.
// Idempotent — safe to run on every boot.
import { fileURLToPath } from 'node:url';
import { query, pool } from './db.js';
import { hashPassword } from './auth.js';
import { migrate } from './migrate.js';
import { logger } from './logger.js';

export async function seedDemo() {
  const password = process.env.SEED_PASSWORD || 'password1234';
  const hash = await hashPassword(password);

  async function user(email, name, role) {
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role RETURNING id`,
      [email, name, hash, role],
    );
    return rows[0].id;
  }

  await user('admin@example.com', 'Admin', 'admin');
  const instructor = await user('instructor@example.com', 'Ivy Instructor', 'instructor');
  const student = await user('student@example.com', 'Sam Student', 'student');
  await user('outsider@example.com', 'Oscar Outsider', 'student');

  let { rows } = await query('SELECT id FROM courses WHERE owner_id = $1 AND title = $2', [instructor, 'Intro Course']);
  if (!rows[0]) ({ rows } = await query(`INSERT INTO courses (owner_id, title) VALUES ($1, 'Intro Course') RETURNING id`, [instructor]));
  await query('INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [student, rows[0].id]);

  logger.info(`demo users seeded (password: ${password}): admin@, instructor@, student@ (enrolled), outsider@ @example.com`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await migrate();
  await seedDemo();
  await pool.end();
}
