-- Phase 1: remove the unused fractional-ordering column.
-- The `position` column was never populated (100% NULL) and the ordering code
-- that would maintain it is being removed. Sibling order falls back to createdAt.
ALTER TABLE "Page" DROP COLUMN IF EXISTS "position";
