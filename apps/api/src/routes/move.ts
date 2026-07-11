import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import { resolvePageAccess } from '../lib/page-access.js';
import { canEdit } from '../domain/permissions.js';

const moveBodySchema = {
  type: 'object',
  properties: {
    parentPageId: { type: ['string', 'null'] },
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
      };

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
      const page = access.page;

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

      const moved = await prisma.page.update({
        where: { id },
        data: { parentPageId: newParentId },
      });

      return reply.send({ page: moved });
    },
  );
}
