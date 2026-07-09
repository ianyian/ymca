-- Phase 3: Publish fields + full-text search index

ALTER TABLE "Page"
  ADD COLUMN "isPublished"  BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN "publishedAt"  TIMESTAMP(3),
  ADD COLUMN "publishToken" TEXT;

-- Unique constraint for publish token
ALTER TABLE "Page"
  ADD CONSTRAINT "Page_publishToken_key" UNIQUE ("publishToken");

-- Index for fast lookup by publish token (public page access)
CREATE INDEX "Page_publishToken_idx" ON "Page"("publishToken");

-- GIN index for PostgreSQL full-text search on title
CREATE INDEX "Page_title_fts_idx" ON "Page" USING GIN (to_tsvector('english', "title"));
