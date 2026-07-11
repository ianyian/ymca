/**
 * One-off migration: move inline base64 images out of Page.content into the
 * PageAttachment file store, replacing each data: URI with a capability URL.
 *
 * WHY: base64 images inflate Page.content (and every PageRevision snapshot),
 * dominating storage and slowing saves/loads.
 *
 * SAFETY:
 *   - Runs in DRY_RUN mode by default — set APPLY=1 to actually write.
 *   - Only rewrites the *current* Page.content, not historical revisions
 *     (those age out via revision pruning).
 *   - Writes files to the same uploads/ dir the API serves from, so RUN THIS
 *     IN THE API's RUNTIME ENVIRONMENT (where those files must live).
 *
 * USAGE:
 *   # preview what would change
 *   DATABASE_URL=... API_PUBLIC_URL=https://api.example.com \
 *     node apps/api/scripts/migrate-inline-images.mjs
 *   # apply
 *   APPLY=1 DATABASE_URL=... API_PUBLIC_URL=https://api.example.com \
 *     node apps/api/scripts/migrate-inline-images.mjs
 */
import { PrismaClient } from "@prisma/client";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const APPLY = process.env.APPLY === "1";
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL ?? "").replace(/\/$/, "");
const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, "..", "uploads");

const prisma = new PrismaClient();

const EXT_BY_MIME = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

function ensureDir(pageId) {
  const dir = join(UPLOADS_DIR, pageId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFileBuffer(filePath, buffer) {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(filePath);
    ws.on("error", reject);
    ws.end(buffer, resolve);
  });
}

// Walk the TipTap doc, converting image nodes whose src is a data: URI.
// Returns the number of images converted (mutates `node` in place).
async function convertImages(node, pageId, stats) {
  if (!node || typeof node !== "object") return;
  if (node.type === "image" && typeof node.attrs?.src === "string" && node.attrs.src.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(node.attrs.src);
    if (m) {
      const [, mime, b64] = m;
      const buffer = Buffer.from(b64, "base64");
      const attachId = randomUUID();
      const ext = EXT_BY_MIME[mime] ?? "";
      const storedName = `${attachId}${ext}`;
      const filePath = join(ensureDir(pageId), storedName);
      if (APPLY) {
        await writeFileBuffer(filePath, buffer);
        await prisma.pageAttachment.create({
          data: {
            id: attachId,
            pageId,
            filename: storedName,
            originalName: `migrated-image${ext}`,
            mimetype: mime,
            size: buffer.length,
            filePath,
          },
        });
      }
      node.attrs.src = `${API_PUBLIC_URL}/attachments/${attachId}/inline`;
      stats.images += 1;
      stats.bytes += buffer.length;
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) await convertImages(child, pageId, stats);
  }
}

async function main() {
  if (!API_PUBLIC_URL) {
    console.error("Set API_PUBLIC_URL to the public base URL of the API (e.g. https://api.example.com).");
    process.exit(1);
  }
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN (set APPLY=1 to write)"}`);

  const pages = await prisma.page.findMany({ select: { id: true, title: true, content: true } });
  let totalImages = 0, totalBytes = 0, touchedPages = 0;

  for (const page of pages) {
    const content = page.content;
    const json = typeof content === "string" ? JSON.parse(content) : content;
    const stats = { images: 0, bytes: 0 };
    await convertImages(json, page.id, stats);
    if (stats.images > 0) {
      touchedPages += 1;
      totalImages += stats.images;
      totalBytes += stats.bytes;
      console.log(`  ${page.title} (${page.id}): ${stats.images} image(s), ${(stats.bytes / 1024).toFixed(0)} kB`);
      if (APPLY) {
        await prisma.page.update({ where: { id: page.id }, data: { content: json } });
      }
    }
  }

  console.log(`\n${APPLY ? "Migrated" : "Would migrate"}: ${totalImages} image(s) across ${touchedPages} page(s), ${(totalBytes / 1024 / 1024).toFixed(2)} MB moved out of content.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
