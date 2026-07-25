-- Denormalised plain-text of Page.content for body search + snippets.
ALTER TABLE "Page" ADD COLUMN "contentText" TEXT NOT NULL DEFAULT '';
