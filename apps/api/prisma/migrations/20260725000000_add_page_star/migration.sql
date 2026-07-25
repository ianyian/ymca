-- CreateTable: per-user starred/favourite pages (Gmail-style star)
CREATE TABLE "PageStar" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "pageId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageStar_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "PageStar_userId_pageId_key" ON "PageStar"("userId", "pageId");
CREATE INDEX "PageStar_userId_idx" ON "PageStar"("userId");
CREATE INDEX "PageStar_pageId_idx" ON "PageStar"("pageId");

-- Foreign keys (cascade so stars vanish when the user or page is deleted)
ALTER TABLE "PageStar" ADD CONSTRAINT "PageStar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PageStar" ADD CONSTRAINT "PageStar_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
