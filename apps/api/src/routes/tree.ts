import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { buildPageTree } from '../domain/tree.js';

export async function registerTreeRoutes(app: FastifyInstance) {
  app.get(
    '/workspaces/:workspaceId/pages/tree',
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
        where: { workspaceId },
        select: {
          id: true,
          parentPageId: true,
          title: true,
          icon: true,
          position: true,
          version: true,
          deletedAt: true,
          tags: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      const serialized = pages.map((p) => ({
        ...p,
        position: p.position !== null ? p.position.toString() : null,
        updatedAt: p.updatedAt.toISOString(),
      }));

      const tree = buildPageTree(serialized);
      return reply.send({ tree });
    },
  );
}
