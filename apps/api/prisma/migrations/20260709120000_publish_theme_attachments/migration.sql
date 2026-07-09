-- Add publishTheme to Page
ALTER TABLE "Page" ADD COLUMN "publishTheme" TEXT NOT NULL DEFAULT 'muji';

-- Create PageAttachment table
CREATE TABLE "PageAttachment" (
  "id"           TEXT         NOT NULL,
  "pageId"       TEXT         NOT NULL,
  "filename"     TEXT         NOT NULL,
  "originalName" TEXT         NOT NULL,
  "mimetype"     TEXT         NOT NULL,
  "size"         INTEGER      NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PageAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PageAttachment_pageId_fkey" FOREIGN KEY ("pageId")
    REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PageAttachment_pageId_idx" ON "PageAttachment"("pageId");
