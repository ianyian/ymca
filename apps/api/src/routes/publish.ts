import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';

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

      const page = await prisma.page.findUnique({ where: { id } });
      if (!page || page.deletedAt !== null) {
        return reply.status(404).send({
          code: 'PAGE_NOT_FOUND',
          message: 'Page not found',
          traceId: request.id,
        });
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: page.workspaceId, userId: user.id } },
      });
      if (!membership) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'No access to page',
          traceId: request.id,
        });
      }

      const body = (request.body ?? {}) as { publishTheme?: string };
      const publishTheme = body.publishTheme ?? 'muji';

      const publishToken = crypto.randomBytes(24).toString('hex');
      const published = await prisma.page.update({
        where: { id },
        data: {
          isPublished: true,
          publishedAt: new Date(),
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

      const page = await prisma.page.findUnique({ where: { id } });
      if (!page || page.deletedAt !== null) {
        return reply.status(404).send({
          code: 'PAGE_NOT_FOUND',
          message: 'Page not found',
          traceId: request.id,
        });
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: page.workspaceId, userId: user.id } },
      });
      if (!membership) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'No access to page',
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
