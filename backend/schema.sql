-- Schema for the WorkBoard backend. Applied idempotently at startup (see
-- db.go) via CREATE TABLE/SEQUENCE IF NOT EXISTS, so there is no separate
-- migration-runner step at this scale.

CREATE SEQUENCE IF NOT EXISTS user_id_seq START 1;
CREATE SEQUENCE IF NOT EXISTS release_block_id_seq START 100;
CREATE SEQUENCE IF NOT EXISTS booking_id_seq START 100;
CREATE SEQUENCE IF NOT EXISTS notification_id_seq START 1;

CREATE TABLE IF NOT EXISTS users (
    id                 TEXT PRIMARY KEY DEFAULT ('user-' || nextval('user_id_seq')),
    name               TEXT NOT NULL,
    email              TEXT NOT NULL UNIQUE,
    password_hash      TEXT NOT NULL,
    avatar_url         TEXT NOT NULL DEFAULT '',
    role               TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    default_work_types TEXT[] NOT NULL DEFAULT '{}'
);

-- Sessions intentionally store only a pointer to the user, not a snapshot —
-- the account is looked up live on every request so it can never go stale.
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- date_key stays TEXT (not DATE) to preserve the app's existing
-- "YYYY-MM-DD string" semantics everywhere and avoid timezone-conversion
-- surprises between the Go backend and Postgres.
CREATE TABLE IF NOT EXISTS release_blocks (
    id                 TEXT PRIMARY KEY DEFAULT ('rb-' || nextval('release_block_id_seq')),
    date_key           TEXT NOT NULL,
    start_slot         INT NOT NULL DEFAULT 0,
    total_hours        INT NOT NULL,
    block_size         INT NOT NULL,
    shift_name         TEXT NOT NULL DEFAULT '',
    start_time         TEXT NOT NULL,
    end_time           TEXT NOT NULL,
    work_type          TEXT NOT NULL,
    owner_id           TEXT NOT NULL REFERENCES users(id),
    max_hours_per_user INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_release_blocks_date_key ON release_blocks(date_key);

CREATE TABLE IF NOT EXISTS bookings (
    id       TEXT PRIMARY KEY DEFAULT ('b-' || nextval('booking_id_seq')),
    user_id  TEXT NOT NULL REFERENCES users(id),
    date_key TEXT NOT NULL,
    block_id TEXT NOT NULL REFERENCES release_blocks(id),
    hours    INT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_date_block ON bookings(date_key, block_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);

CREATE TABLE IF NOT EXISTS projects (
    id       BIGSERIAL PRIMARY KEY,
    admin_id TEXT NOT NULL REFERENCES users(id),
    name     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_admin ON projects(admin_id);

CREATE TABLE IF NOT EXISTS work_type_access (
    id        BIGSERIAL PRIMARY KEY,
    work_type TEXT NOT NULL,
    email     TEXT NOT NULL,
    UNIQUE (work_type, email)
);

-- One row per user == one active timer per user, the same guarantee the old
-- map[userID]*Timer gave for free.
CREATE TABLE IF NOT EXISTS timers (
    user_id    TEXT PRIMARY KEY REFERENCES users(id),
    start_at   BIGINT NOT NULL,
    task_name  TEXT NOT NULL DEFAULT '',
    booking_id TEXT NOT NULL DEFAULT '',
    block_id   TEXT NOT NULL DEFAULT '',
    date_key   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reported_override (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    hours   DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS booking_banked (
    booking_id TEXT PRIMARY KEY REFERENCES bookings(id),
    hours      DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY DEFAULT ('n-' || nextval('notification_id_seq')),
    user_id    TEXT NOT NULL REFERENCES users(id),
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    read       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
