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

      // Case-insensitive substring search so typing partial words works as a
      // type-ahead (e.g. "publ" finds "Publish Theme Test"). Previously this used
      // full-text search, which only matched whole word stems — so partial input
      // returned nothing and the box felt broken. Each whitespace-separated token
      // must appear somewhere in the title (AND), letting multi-word queries match
      // in any order ("test theme" → "Publish Theme Test").
      const tokens = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
      if (tokens.length === 0) {
        return reply.send({ results: [], query: q });
      }

      const pages = await prisma.page.findMany({
        where: {
          workspaceId,
          deletedAt: null,
          AND: tokens.map((tok) => ({
            title: { contains: tok, mode: "insensitive" as const },
          })),
        },
        select: { id: true, title: true, icon: true, workspaceId: true, deletedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 50,
      });

      // Rank titles that *start with* the query ahead of mid-word matches, then
      // prefer shorter (closer) titles. Keeps the most relevant hits on top.
      const needle = q.trim().toLowerCase();
      const ranked = pages
        .map((p) => {
          const title = p.title.toLowerCase();
          const starts = title.startsWith(needle) ? 0 : 1;
          return { p, starts, len: p.title.length };
        })
        .sort((a, b) => a.starts - b.starts || a.len - b.len)
        .slice(0, 20)
        .map((r) => r.p);

      return reply.send({ results: ranked, query: q });
    },
  );
}
