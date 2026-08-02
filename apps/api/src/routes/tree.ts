import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { buildPageTree } from '../domain/tree.js';

// Load one workspace's page tree (with the user's stars merged in). The two
// queries are independent, so they run in parallel instead of sequentially.
async function loadWorkspaceTree(userId: string, workspaceId: string) {
  const [pages, stars] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId },
      select: {
        id: true,
        parentPageId: true,
        title: true,
        icon: true,
        version: true,
        deletedAt: true,
        tags: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.pageStar.findMany({
      where: { userId, page: { workspaceId } },
      select: { pageId: true },
    }),
  ]);

  const starredIds = new Set(stars.map((s) => s.pageId));
  const serialized = pages.map((p) => ({
    ...p,
    isStarred: starredIds.has(p.id),
    updatedAt: p.updatedAt.toISOString(),
  }));
  return buildPageTree(serialized);
}

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

      const tree = await loadWorkspaceTree(user.id, workspaceId);
      return reply.send({ tree });
    },
  );

  // Everything the app needs to paint its first screen after sign-in, in ONE
  // round trip: the user's workspaces plus the first workspace's page tree.
  // Replaces the old login → /workspaces → /pages/tree waterfall (three
  // sequential round trips before the UI could render).
  app.get('/me/bootstrap', async (request, reply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      include: { workspace: true },
    });
    const workspaces = memberships.map((member) => ({
      id: member.workspace.id,
      name: member.workspace.name,
      slug: member.workspace.slug,
      role: member.role,
      createdAt: member.workspace.createdAt,
      updatedAt: member.workspace.updatedAt,
    }));

    const first = workspaces[0];
    if (!first) {
      return reply.send({ workspaces, activeWorkspaceId: null, tree: [] });
    }

    const tree = await loadWorkspaceTree(user.id, first.id);
    return reply.send({ workspaces, activeWorkspaceId: first.id, tree });
  });
}
