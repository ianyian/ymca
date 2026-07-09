import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../auth/require-auth.js';
import type { WorkspaceRole } from '@prisma/client';

const createInviteBodySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['WorkspaceAdmin', 'WorkspaceMember', 'WorkspaceGuest'] },
  },
  required: ['role'],
  additionalProperties: false,
} as const;

const INVITE_EXPIRY_HOURS = 72;

export async function registerInviteRoutes(app: FastifyInstance) {
  // Create an invite token for a workspace
  app.post(
    '/workspaces/:workspaceId/invites',
    {
      schema: {
        params: {
          type: 'object',
          properties: { workspaceId: { type: 'string', format: 'uuid' } },
          required: ['workspaceId'],
        },
        body: createInviteBodySchema,
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { workspaceId } = request.params as { workspaceId: string };
      const body = request.body as { email?: string; role: WorkspaceRole };

      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: user.id } },
      });
      if (!membership || (membership.role !== 'WorkspaceOwner' && membership.role !== 'WorkspaceAdmin')) {
        return reply.status(403).send({
          code: 'FORBIDDEN',
          message: 'Only workspace admins can create invites',
          traceId: request.id,
        });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 60 * 60 * 1000);

      const invite = await prisma.inviteToken.create({
        data: {
          workspaceId,
          email: body.email ?? null,
          role: body.role,
          token,
          expiresAt,
          createdById: user.id,
        },
      });

      return reply.status(201).send({ invite });
    },
  );

  // Accept an invite token — adds the current user as a workspace member
  app.post(
    '/invites/:token/accept',
    {
      schema: {
        params: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { token } = request.params as { token: string };

      const invite = await prisma.inviteToken.findUnique({ where: { token } });

      if (!invite) {
        return reply.status(404).send({
          code: 'INVITE_NOT_FOUND',
          message: 'Invite not found',
          traceId: request.id,
        });
      }

      if (invite.usedAt !== null || invite.expiresAt < new Date()) {
        return reply.status(410).send({
          code: 'INVITE_EXPIRED',
          message: 'Invite has expired or been used',
          traceId: request.id,
        });
      }

      // Check if already a member
      const existing = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
      });
      if (existing) {
        return reply.status(409).send({
          code: 'ALREADY_MEMBER',
          message: 'You are already a member of this workspace',
          traceId: request.id,
        });
      }

      const [member] = await prisma.$transaction([
        prisma.workspaceMember.create({
          data: {
            workspaceId: invite.workspaceId,
            userId: user.id,
            role: invite.role,
            invitedById: invite.createdById,
          },
        }),
        prisma.inviteToken.update({
          where: { id: invite.id },
          data: { usedAt: new Date() },
        }),
      ]);

      return reply.status(201).send({ member });
    },
  );
}
