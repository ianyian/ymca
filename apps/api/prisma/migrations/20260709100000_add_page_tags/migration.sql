-- Add tags column to Page table
ALTER TABLE "Page" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
