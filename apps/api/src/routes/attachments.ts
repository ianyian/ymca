import type { FastifyInstance } from 'fastify';
import { createWriteStream, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { resolvePageAccess } from '../lib/page-access.js';
import { canEdit, canView } from '../domain/permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads');

// Allowlist of accepted upload MIME types + a hard per-file size cap.
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
]);
const MAX_ATTACHMENT_BYTES = 1024 * 1024 * 1024; // 1 GB

function ensurePageDir(pageId: string): string {
  const dir = join(UPLOADS_DIR, pageId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export async function registerAttachmentRoutes(app: FastifyInstance) {
  // POST /pages/:id/attachments — upload a file as base64 JSON
  app.post(
    '/pages/:id/attachments',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            mimetype: { type: 'string' },
            content: { type: 'string' }, // base64
          },
          required: ['filename', 'mimetype', 'content'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id: pageId } = request.params as { id: string };
      const { filename, mimetype, content } = request.body as {
        filename: string; mimetype: string; content: string;
      };

      const access = await resolvePageAccess(user.id, pageId);
      if (!access.ok) {
        return reply.status(access.status).send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canEdit(access.pageRole)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'You do not have edit access to this page', traceId: request.id });
      }

      if (!ALLOWED_MIME.has(mimetype)) {
        return reply.status(400).send({ code: 'UNSUPPORTED_TYPE', message: 'File type not allowed', traceId: request.id });
      }

      // Decode base64 and write to disk
      const buffer = Buffer.from(content, 'base64');
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        return reply.status(413).send({ code: 'FILE_TOO_LARGE', message: 'File exceeds the 1 GB limit', traceId: request.id });
      }
      const attachId = randomUUID();
      const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
      const storedName = `${attachId}${ext}`;
      const pageDir = ensurePageDir(pageId);
      const filePath = join(pageDir, storedName);

      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(filePath);
        ws.on('error', reject);
        ws.end(buffer, resolve);
      });

      const attachment = await prisma.pageAttachment.create({
        data: {
          id: attachId,
          pageId,
          filename: storedName,
          originalName: filename,
          mimetype,
          size: buffer.length,
          filePath,
        },
      });

      // `url` is the capability URL callers embed as an inline image/file src.
      return reply
        .status(201)
        .send({ attachment, url: `/attachments/${attachment.id}/inline` });
    },
  );

  // GET /pages/:id/attachments — list attachments
  app.get(
    '/pages/:id/attachments',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id: pageId } = request.params as { id: string };

      const access = await resolvePageAccess(user.id, pageId);
      if (!access.ok) {
        return reply.status(access.status).send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canView(access.pageRole)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'No access to page', traceId: request.id });
      }

      const attachments = await prisma.pageAttachment.findMany({
        where: { pageId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, originalName: true, mimetype: true, size: true, createdAt: true },
      });

      return reply.status(200).send({ attachments });
    },
  );

  // GET /attachments/:attachId/inline — serve a file inline by capability URL.
  // Used as the `src` for inline images in the editor and on published pages,
  // where a request cannot carry a session/CSRF header. Access is gated by the
  // unguessable attachment UUID (capability pattern). Images are served inline;
  // any other type is forced to download to avoid inline-content sniffing.
  app.get(
    '/attachments/:attachId/inline',
    {
      schema: {
        params: {
          type: 'object',
          properties: { attachId: { type: 'string', format: 'uuid' } },
          required: ['attachId'],
        },
      },
    },
    async (request, reply) => {
      const { attachId } = request.params as { attachId: string };

      const attachment = await prisma.pageAttachment.findUnique({ where: { id: attachId } });
      if (!attachment) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Attachment not found', traceId: request.id });
      }
      if (!existsSync(attachment.filePath)) {
        return reply.status(404).send({ code: 'FILE_MISSING', message: 'File not found on disk', traceId: request.id });
      }

      const isImage = attachment.mimetype.startsWith('image/');
      reply
        .header('content-type', attachment.mimetype)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header(
          'content-disposition',
          isImage
            ? 'inline'
            : `attachment; filename="${encodeURIComponent(attachment.originalName)}"`,
        )
        .header('content-length', attachment.size);

      return reply.send(createReadStream(attachment.filePath));
    },
  );

  // GET /pages/:id/attachments/:attachId/download — serve file
  app.get(
    '/pages/:id/attachments/:attachId/download',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            attachId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'attachId'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id: pageId, attachId } = request.params as { id: string; attachId: string };

      const access = await resolvePageAccess(user.id, pageId);
      if (!access.ok) {
        return reply.status(access.status).send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canView(access.pageRole)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'No access to page', traceId: request.id });
      }

      const attachment = await prisma.pageAttachment.findUnique({ where: { id: attachId } });
      if (!attachment || attachment.pageId !== pageId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Attachment not found', traceId: request.id });
      }

      if (!existsSync(attachment.filePath)) {
        return reply.status(404).send({ code: 'FILE_MISSING', message: 'File not found on disk', traceId: request.id });
      }

      reply
        .header('content-type', attachment.mimetype)
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', `attachment; filename="${encodeURIComponent(attachment.originalName)}"`)
        .header('content-length', attachment.size);

      const stream = createReadStream(attachment.filePath);
      return reply.send(stream);
    },
  );

  // DELETE /pages/:id/attachments/:attachId
  app.delete(
    '/pages/:id/attachments/:attachId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            attachId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'attachId'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id: pageId, attachId } = request.params as { id: string; attachId: string };

      const access = await resolvePageAccess(user.id, pageId);
      if (!access.ok) {
        return reply.status(access.status).send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canEdit(access.pageRole)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'You do not have edit access to this page', traceId: request.id });
      }

      const attachment = await prisma.pageAttachment.findUnique({ where: { id: attachId } });
      if (!attachment || attachment.pageId !== pageId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Attachment not found', traceId: request.id });
      }

      // Delete from disk (ignore errors if already gone)
      try { await unlink(attachment.filePath); } catch { }

      await prisma.pageAttachment.delete({ where: { id: attachId } });

      return reply.status(204).send();
    },
  );
}
