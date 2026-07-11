-- Phase 1: schema cleanup — redundant indexes, timestamptz, tags GIN

-- Drop redundant single-column indexes. Each is already covered by a UNIQUE
-- constraint on the same column (which creates its own index), so these are
-- pure write-overhead duplicates.
DROP INDEX IF EXISTS "Page_publishToken_idx";
DROP INDEX IF EXISTS "InviteToken_token_idx";
DROP INDEX IF EXISTS "PasswordResetToken_token_idx";

-- Redundant with the composite index ("workspaceId", "deletedAt"): Postgres can
-- serve workspaceId-only lookups from the leftmost prefix of that index.
DROP INDEX IF EXISTS "Page_workspaceId_idx";

-- Normalize publishedAt to timestamptz to match every other timestamp column.
-- Existing values (all NULL today) are interpreted as UTC.
ALTER TABLE "Page"
  ALTER COLUMN "publishedAt" TYPE TIMESTAMPTZ USING "publishedAt" AT TIME ZONE 'UTC';

-- GIN index to support tag filtering on the text[] column.
CREATE INDEX "Page_tags_idx" ON "Page" USING GIN ("tags");
