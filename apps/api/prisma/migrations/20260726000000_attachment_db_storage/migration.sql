-- Store attachment bytes in the DB so uploads survive redeploys (ephemeral FS).
ALTER TABLE "PageAttachment" ADD COLUMN "data" BYTEA;
