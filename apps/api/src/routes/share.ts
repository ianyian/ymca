import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import type { PageRole } from '@prisma/client';

const shareBodySchema = {
  type: 'object',
  properties: {
    userId: { type: 'string', format: 'uuid' },
    pageRole: { type: 'string', enum: ['Owner', 'Editor', 'Viewer'] },
  },
  required: ['pageRole'],
  additionalProperties: false,
} as const;

export async function registerShareRoutes(app: FastifyInstance) {
  // Grant page permission to a user
  app.post(
    '/pages/:id/share',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
          required: ['id'],
        },
        body: shareBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id } = request.params as { id: string };
      const body = request.body as { userId?: string; pageRole: PageRole };

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

      // If userId provided, verify they are a workspace member
      if (body.userId) {
        const targetMembership = await prisma.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId: page.workspaceId, userId: body.userId } },
        });
        if (!targetMembership) {
          return reply.status(400).send({
            code: 'USER_NOT_IN_WORKSPACE',
            message: 'Target user is not a member of this workspace',
            traceId: request.id,
          });
        }
      }

      const permission = await prisma.pagePermission.create({
        data: {
          pageId: id,
          userId: body.userId ?? null,
          pageRole: body.pageRole,
          grantedById: user.id,
        },
      });

      return reply.status(201).send({ permission });
    },
  );

  // Revoke page permission
  app.delete(
    '/pages/:id/share/:permissionId',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            permissionId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'permissionId'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { id, permissionId } = request.params as { id: string; permissionId: string };

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

      const permission = await prisma.pagePermission.findUnique({
        where: { id: permissionId },
      });
      if (!permission || permission.pageId !== id) {
        return reply.status(404).send({
          code: 'PERMISSION_NOT_FOUND',
          message: 'Permission not found',
          traceId: request.id,
        });
      }

      await prisma.pagePermission.delete({ where: { id: permissionId } });
      return reply.status(204).send();
    },
  );
}
