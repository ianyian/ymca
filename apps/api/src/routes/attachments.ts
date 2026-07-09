import type { FastifyInstance } from 'fastify';
import { createWriteStream, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = join(__dirname, '..', '..', 'uploads');

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

      const page = await prisma.page.findUnique({ where: { id: pageId } });
      if (!page || page.deletedAt !== null) {
        return reply.status(404).send({ code: 'PAGE_NOT_FOUND', message: 'Page not found', traceId: request.id });
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: page.workspaceId, userId: user.id } },
      });
      if (!membership) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'No access', traceId: request.id });
      }

      // Decode base64 and write to disk
      const buffer = Buffer.from(content, 'base64');
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

      return reply.status(201).send({ attachment });
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

      const page = await prisma.page.findUnique({ where: { id: pageId } });
      if (!page || page.deletedAt !== null) {
        return reply.status(404).send({ code: 'PAGE_NOT_FOUND', message: 'Page not found', traceId: request.id });
      }

      const attachments = await prisma.pageAttachment.findMany({
        where: { pageId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, originalName: true, mimetype: true, size: true, createdAt: true },
      });

      return reply.status(200).send({ attachments });
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
      const { id: pageId, attachId } = request.params as { id: string; attachId: string };

      const attachment = await prisma.pageAttachment.findUnique({ where: { id: attachId } });
      if (!attachment || attachment.pageId !== pageId) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Attachment not found', traceId: request.id });
      }

      if (!existsSync(attachment.filePath)) {
        return reply.status(404).send({ code: 'FILE_MISSING', message: 'File not found on disk', traceId: request.id });
      }

      reply
        .header('content-type', attachment.mimetype)
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
