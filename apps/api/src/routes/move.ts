import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { appendPosition } from '../domain/ordering.js';

const moveBodySchema = {
  type: 'object',
  properties: {
    parentPageId: { type: ['string', 'null'] },
    afterPageId: { type: ['string', 'null'] },
  },
  additionalProperties: false,
} as const;

export async function registerMoveRoutes(app: FastifyInstance) {
  app.post(
    '/pages/:id/move',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: moveBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id } = request.params as { id: string };
      const body = request.body as {
        parentPageId?: string | null;
        afterPageId?: string | null;
      };

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

      // Validate new parent is in same workspace
      const newParentId = Object.hasOwn(body, 'parentPageId')
        ? (body.parentPageId ?? null)
        : page.parentPageId;

      if (newParentId !== null) {
        const parent = await prisma.page.findUnique({ where: { id: newParentId } });
        if (!parent || parent.workspaceId !== page.workspaceId || parent.deletedAt !== null) {
          return reply.status(400).send({
            code: 'INVALID_PARENT_PAGE',
            message: 'Parent page is not valid',
            traceId: request.id,
          });
        }
        // Prevent cycles: new parent cannot be a descendant of the moved page
        if (newParentId === id) {
          return reply.status(400).send({
            code: 'CIRCULAR_REFERENCE',
            message: 'A page cannot be its own parent',
            traceId: request.id,
          });
        }
      }

      // Compute new position: place after `afterPageId` sibling
      let newPosition: string;
      if (body.afterPageId) {
        const sibling = await prisma.page.findUnique({ where: { id: body.afterPageId } });
        const afterPos = sibling?.position !== null ? sibling?.position?.toString() ?? null : null;
        newPosition = appendPosition(afterPos);
      } else {
        newPosition = '0.5'; // prepend to list
      }

      const moved = await prisma.page.update({
        where: { id },
        data: { parentPageId: newParentId, position: newPosition },
      });

      return reply.send({ page: moved });
    },
  );
}
