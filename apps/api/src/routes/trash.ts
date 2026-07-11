import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { resolvePageAccess } from '../lib/page-access.js';
import { canEdit } from '../domain/permissions.js';

export async function registerTrashRoutes(app: FastifyInstance) {
  // Soft-delete a page
  app.delete(
    '/pages/:id',
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
      if (!canEdit(access.pageRole)) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'You do not have edit access to this page',
          traceId: request.id,
        });
      }

      const deleted = await prisma.page.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      return reply.send({ page: deleted });
    },
  );

  // Restore a soft-deleted page
  app.post(
    '/pages/:id/restore',
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

      const access = await resolvePageAccess(user.id, id, { allowTrashed: true });
      if (!access.ok) {
        return reply
          .status(access.status)
          .send({ code: access.code, message: access.message, traceId: request.id });
      }
      if (access.page.deletedAt === null) {
        return reply.status(400).send({
          code: 'PAGE_NOT_DELETED',
          message: 'Page is not in trash',
          traceId: request.id,
        });
      }
      if (!canEdit(access.pageRole)) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'You do not have edit access to this page',
          traceId: request.id,
        });
      }

      const restored = await prisma.page.update({
        where: { id },
        data: { deletedAt: null },
      });

      return reply.send({ page: restored });
    },
  );

  // List trash for a workspace
  app.get(
    '/workspaces/:workspaceId/trash',
    {
      schema: {
        params: {
          type: 'object',
          properties: { workspaceId: { type: 'string', format: 'uuid' } },
          required: ['workspaceId'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { workspaceId } = request.params as { workspaceId: string };

      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
      });
      if (!membership) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'No access to workspace',
          traceId: request.id,
        });
      }

      const pages = await prisma.page.findMany({
        where: { workspaceId, deletedAt: { not: null } },
        orderBy: { deletedAt: 'desc' },
      });

      return reply.send({ pages });
    },
  );
}
