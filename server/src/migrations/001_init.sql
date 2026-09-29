CREATE TYPE user_role AS ENUM ('student', 'instructor', 'admin');
CREATE TYPE video_status AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED');
-- course: enrolled users of video.course_id; subscription: any active subscriber; private: owner/admin only
CREATE TYPE video_access AS ENUM ('course', 'subscription', 'private');
CREATE TYPE job_status AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE playback_status AS ENUM ('ACTIVE', 'ENDED', 'REVOKED');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          user_role NOT NULL DEFAULT 'student',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Opaque refresh tokens, stored hashed; rotated on every use.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE courses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE enrollments (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id  uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);
CREATE INDEX enrollments_course_idx ON enrollments (course_id);

CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan               text NOT NULL,
  status             text NOT NULL CHECK (status IN ('active', 'canceled', 'past_due')),
  current_period_end timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);

CREATE TABLE videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  course_id        uuid REFERENCES courses(id) ON DELETE SET NULL,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  access           video_access NOT NULL DEFAULT 'course',
  status           video_status NOT NULL DEFAULT 'UPLOADING',
  source_key       text NOT NULL,
  source_size      bigint NOT NULL,
  source_content_type text NOT NULL,
  upload_id        text,
  hls_prefix       text,
  duration_seconds numeric(10, 3),
  renditions       jsonb NOT NULL DEFAULT '[]',
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (access <> 'course' OR course_id IS NOT NULL)
);
CREATE INDEX videos_course_idx ON videos (course_id);
CREATE INDEX videos_owner_idx ON videos (owner_id);

CREATE TABLE video_processing_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id    uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status      job_status NOT NULL DEFAULT 'QUEUED',
  attempts    int NOT NULL DEFAULT 0,
  progress    int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_jobs_video_idx ON video_processing_jobs (video_id);

CREATE TABLE playback_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id          uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  device_id         text NOT NULL,
  ip                inet,
  user_agent        text,
  status            playback_status NOT NULL DEFAULT 'ACTIVE',
  last_position     numeric(10, 3) NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  end_reason        text
);
CREATE INDEX playback_sessions_active_idx ON playback_sessions (user_id) WHERE status = 'ACTIVE';
CREATE INDEX playback_sessions_video_idx ON playback_sessions (video_id);
