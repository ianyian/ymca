ALTER TABLE "ActivityEvent"
  ADD COLUMN IF NOT EXISTS "eventType" VARCHAR(24) NOT NULL DEFAULT 'http',
  ADD COLUMN IF NOT EXISTS "target" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "pageId" UUID,
  ADD COLUMN IF NOT EXISTS "x" INTEGER,
  ADD COLUMN IF NOT EXISTS "y" INTEGER;

CREATE INDEX IF NOT EXISTS "ActivityEvent_eventType_createdAt_idx"
  ON "ActivityEvent" ("eventType", "createdAt");

CREATE INDEX IF NOT EXISTS "ActivityEvent_userId_eventType_createdAt_idx"
  ON "ActivityEvent" ("userId", "eventType", "createdAt");
