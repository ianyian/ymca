-- CoMa (Configuration Manager): global app-role lookup table, per-user role,
-- and an append-only activity log for the monitoring dashboard.
--
-- Ordering matters: the AppRole seed rows must exist before User.appRoleId is
-- backfilled and before the foreign key is added.

-- 1) Lookup table for global application roles. Not an enum, so future roles
--    (viewer, debugger, superUser, ...) are just new rows — no migration needed.
CREATE TABLE "AppRole" (
    "id" SMALLSERIAL NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "isAssignable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AppRole_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppRole_key_key" ON "AppRole"("key");

-- 2) Seed the two roles that exist today with STABLE ids (admin = 1, user = 2).
INSERT INTO "AppRole" ("id", "key", "label", "description", "rank", "isAssignable", "updatedAt")
VALUES
    (1, 'admin', 'Administrator', 'Full access, including the Configuration Manager.', 100, true, now()),
    (2, 'user',  'Normal User',   'Standard access to their own workspaces and pages.', 10,  true, now());

-- Advance the sequence past the manually-inserted ids so future auto-inserts don't collide.
SELECT setval(pg_get_serial_sequence('"AppRole"', 'id'), 2, true);

-- 3) Add the per-user role column. DB default is 2 ("user") so NEW users become
--    normal users automatically.
ALTER TABLE "User" ADD COLUMN "appRoleId" SMALLINT NOT NULL DEFAULT 2;

-- 4) Backfill: every EXISTING user becomes an administrator.
UPDATE "User" SET "appRoleId" = 1;

-- 5) Append-only activity log powering CoMa monitoring (API-call volume, active users).
--    `path` holds the normalized route pattern to keep cardinality bounded.
CREATE TABLE "ActivityEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID,
    "method" VARCHAR(8) NOT NULL,
    "path" VARCHAR(256) NOT NULL,
    "statusCode" SMALLINT NOT NULL,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityEvent_createdAt_idx" ON "ActivityEvent"("createdAt");
CREATE INDEX "ActivityEvent_userId_createdAt_idx" ON "ActivityEvent"("userId", "createdAt");

-- 6) Indexes + foreign key for the new user column.
CREATE INDEX "User_appRoleId_idx" ON "User"("appRoleId");

ALTER TABLE "User" ADD CONSTRAINT "User_appRoleId_fkey"
    FOREIGN KEY ("appRoleId") REFERENCES "AppRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
