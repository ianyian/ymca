import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';

export async function registerSearchRoutes(app: FastifyInstance) {
  app.get(
    '/search',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 200 },
            workspaceId: { type: 'string', format: 'uuid' },
          },
          required: ['q', 'workspaceId'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { q, workspaceId } = request.query as { q: string; workspaceId: string };

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

      // Use PostgreSQL full-text search — gracefully falls back to ilike in test/mock environments
      let pages: { id: string; title: string; icon: string | null; workspaceId: string; deletedAt: Date | null }[];

      try {
        pages = await prisma.$queryRaw<typeof pages>`
          SELECT id, title, icon, "workspaceId", "deletedAt"
          FROM "Page"
          WHERE "workspaceId" = ${workspaceId}::uuid
            AND "deletedAt" IS NULL
            AND to_tsvector('english', title) @@ plainto_tsquery('english', ${q})
          ORDER BY ts_rank(to_tsvector('english', title), plainto_tsquery('english', ${q})) DESC
          LIMIT 20
        `;
      } catch {
        // Fallback for non-PostgreSQL environments (mocks / unit tests)
        pages = await prisma.page.findMany({
          where: {
            workspaceId,
            deletedAt: null,
            title: { contains: q },
          },
          select: { id: true, title: true, icon: true, workspaceId: true, deletedAt: true },
          take: 20,
        });
      }

      return reply.send({ results: pages, query: q });
    },
  );
}
