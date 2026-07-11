import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { resolvePageAccess } from '../lib/page-access.js';
import { canManage } from '../domain/permissions.js';

export async function registerPublishRoutes(app: FastifyInstance) {
  // Publish a page — generates a unique share token
  app.post(
    '/pages/:id/publish',
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

      const { id } = request.params as { id: string };

      const access = await resolvePageAccess(user.id, id);
      if (!access.ok) {
        return reply
          .status(access.status)
          .send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canManage(access.pageRole)) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'Only the page owner can publish this page',
          traceId: request.id,
        });
      }

      const body = (request.body ?? {}) as { publishTheme?: string };
      const publishTheme = body.publishTheme ?? access.page.publishTheme ?? 'muji';

      // Preserve an existing token so re-publishing (e.g. to change the theme)
      // never invalidates links already shared. Only mint a token the first time.
      const publishToken =
        access.page.publishToken ?? crypto.randomBytes(24).toString('hex');
      const published = await prisma.page.update({
        where: { id },
        data: {
          isPublished: true,
          publishedAt: access.page.publishedAt ?? new Date(),
          publishToken,
          publishTheme,
        },
      });

      return reply.status(200).send({ page: published, publishToken });
    },
  );

  // Unpublish a page — clears the token
  app.post(
    '/pages/:id/unpublish',
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

      const { id } = request.params as { id: string };

      const access = await resolvePageAccess(user.id, id);
      if (!access.ok) {
        return reply
          .status(access.status)
          .send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (!canManage(access.pageRole)) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'Only the page owner can unpublish this page',
          traceId: request.id,
        });
      }

      const unpublished = await prisma.page.update({
        where: { id },
        data: {
          isPublished: false,
          publishedAt: null,
          publishToken: null,
        },
      });

      return reply.status(200).send({ page: unpublished });
    },
  );
}
