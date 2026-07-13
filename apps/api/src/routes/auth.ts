import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { getEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { isPrismaErrorCode } from "../lib/prisma-errors.js";
import { sendPasswordResetEmail } from "../lib/mailer.js";
import {
  clearSessionCookie,
  createSessionForUser,
  invalidateSessionById,
  setSessionCookie,
} from "../auth/session.js";
import { requireAuth } from "../auth/require-auth.js";

const registerBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8, maxLength: 128 },
    displayName: { type: "string", minLength: 1, maxLength: 80 },
  },
  required: ["email", "password"],
  additionalProperties: false,
} as const;

const loginBodySchema = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8, maxLength: 128 },
  },
  required: ["email", "password"],
  additionalProperties: false,
} as const;

function getClientIp(requestIp: string): string | undefined {
  return requestIp.length > 0 ? requestIp : undefined;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post(
    "/auth/register",
    {
      schema: {
        body: registerBodySchema,
      },
    },
    async (request, reply) => {
      const env = getEnv();
      const payload = request.body as {
        email: string;
        password: string;
        displayName?: string;
      };

      const normalizedEmail = payload.email.trim().toLowerCase();
      const passwordHash = await bcrypt.hash(
        payload.password,
        env.BCRYPT_ROUNDS,
      );

      try {
        const user = await prisma.$transaction(
          async (tx: Prisma.TransactionClient) => {
            const createdUser = await tx.user.create({
              data: {
                email: normalizedEmail,
                passwordHash,
                displayName: payload.displayName?.trim(),
              },
              select: {
                id: true,
                email: true,
                displayName: true,
              },
            });

            // Auto-create a default workspace so user lands straight in the app
            const workspace = await tx.workspace.create({
              data: {
                name: "My Workspace",
                slug: `my-workspace-${createdUser.id.slice(0, 8)}`,
                ownerId: createdUser.id,
              },
            });
            await tx.workspaceMember.create({
              data: {
                workspaceId: workspace.id,
                userId: createdUser.id,
                role: "WorkspaceOwner",
              },
            });

            return createdUser;
          },
        );

        const session = await createSessionForUser({
          userId: user.id,
          env,
          userAgent: request.headers["user-agent"],
          ipAddress: getClientIp(request.ip),
        });

        setSessionCookie(reply, session.rawToken, session.expiresAt);
        return reply.status(201).send({
          user: { ...user, language: "en" },
          csrfToken: session.csrfToken,
          // Also returned for cross-origin clients that can't rely on the
          // third-party session cookie; sent back as `Authorization: Bearer`.
          token: session.rawToken,
        });
      } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) {
          return reply.status(409).send({
            code: "EMAIL_TAKEN",
            message: "Email is already registered",
            traceId: request.id,
          });
        }

        throw error;
      }
    },
  );

  app.post(
    "/auth/login",
    {
      schema: {
        body: loginBodySchema,
      },
    },
    async (request, reply) => {
      const env = getEnv();
      const payload = request.body as {
        email: string;
        password: string;
      };
      const normalizedEmail = payload.email.trim().toLowerCase();

      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (!user) {
        return reply.status(401).send({
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password",
          traceId: request.id,
        });
      }

      const isPasswordValid = await bcrypt.compare(
        payload.password,
        user.passwordHash,
      );
      if (!isPasswordValid) {
        return reply.status(401).send({
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password",
          traceId: request.id,
        });
      }

      const session = await createSessionForUser({
        userId: user.id,
        env,
        userAgent: request.headers["user-agent"],
        ipAddress: getClientIp(request.ip),
      });

      setSessionCookie(reply, session.rawToken, session.expiresAt);
      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          language: user.language ?? "en",
        },
        csrfToken: session.csrfToken,
        // Also returned for cross-origin clients that can't rely on the
        // third-party session cookie; sent back as `Authorization: Bearer`.
        token: session.rawToken,
      });
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    if (request.authSessionId) {
      await invalidateSessionById(request.authSessionId);
    }

    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get("/me", async (request, reply) => {
    if (!request.authUser) {
      return reply.status(401).send({
        code: "UNAUTHORIZED",
        message: "Authentication is required",
        traceId: request.id,
      });
    }

    // Fetch full user including language
    const dbUser = await prisma.user.findUnique({
      where: { id: request.authUser.id },
      select: { id: true, email: true, displayName: true, language: true },
    });

    return reply.send({
      user: { ...request.authUser, language: dbUser?.language ?? "en" },
      csrfToken: request.csrfToken,
    });
  });

  // ── Update language preference ──
  app.patch(
    "/auth/language",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            language: { type: "string", minLength: 2, maxLength: 10 },
          },
          required: ["language"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;
      const { language } = request.body as { language: string };
      const validLangs = ["en", "zh", "ms", "ta", "de", "hu", "es"];
      if (!validLangs.includes(language)) {
        return reply
          .status(400)
          .send({
            code: "INVALID_LANGUAGE",
            message: "Unsupported language code",
          });
      }
      await prisma.user.update({ where: { id: user.id }, data: { language } });
      return reply.send({ ok: true });
    },
  );

  // ── Change password (requires login) ──
  app.patch(
    "/auth/change-password",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            currentPassword: { type: "string", minLength: 1 },
            newPassword: { type: "string", minLength: 8, maxLength: 128 },
          },
          required: ["currentPassword", "newPassword"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };

      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!dbUser)
        return reply
          .status(404)
          .send({
            code: "NOT_FOUND",
            message: "User not found",
            traceId: request.id,
          });

      const valid = await bcrypt.compare(currentPassword, dbUser.passwordHash);
      if (!valid) {
        return reply
          .status(400)
          .send({
            code: "WRONG_PASSWORD",
            message: "Current password is incorrect",
            traceId: request.id,
          });
      }

      const env = getEnv();
      const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      return reply.status(200).send({ ok: true });
    },
  );

  // ── Forgot password ──
  app.post(
    "/auth/forgot-password",
    {
      schema: {
        body: {
          type: "object",
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const env = getEnv();
      const { email } = request.body as { email: string };
      const normalizedEmail = email.trim().toLowerCase();

      const dbUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });

      // Always return 200 to prevent email enumeration
      if (!dbUser) return reply.status(200).send({ ok: true });

      // Expire any existing tokens for this user
      await prisma.passwordResetToken.updateMany({
        where: {
          userId: dbUser.id,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { expiresAt: new Date() },
      });

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.passwordResetToken.create({
        data: { id: crypto.randomUUID(), userId: dbUser.id, token, expiresAt },
      });

      // Use the configured web app URL (set APP_URL in production).
      const appUrl = env.APP_URL;
      const resetUrl = `${appUrl}/?token=${token}`;

      const result = await sendPasswordResetEmail({
        to: normalizedEmail,
        resetUrl,
        appUrl,
      });

      // In dev mode (no SMTP), return the link so the UI can show it
      return reply
        .status(200)
        .send({
          ok: true,
          ...(result.devLink ? { devLink: result.devLink } : {}),
        });
    },
  );

  // ── Reset password (token from email) ──
  app.post(
    "/auth/reset-password",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            token: { type: "string", minLength: 1 },
            newPassword: { type: "string", minLength: 8, maxLength: 128 },
          },
          required: ["token", "newPassword"],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { token, newPassword } = request.body as {
        token: string;
        newPassword: string;
      };

      const resetToken = await prisma.passwordResetToken.findUnique({
        where: { token },
      });

      if (
        !resetToken ||
        resetToken.usedAt ||
        resetToken.expiresAt < new Date()
      ) {
        return reply
          .status(400)
          .send({
            code: "INVALID_TOKEN",
            message: "Reset link is invalid or has expired",
            traceId: request.id,
          });
      }

      const env = getEnv();
      const passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);

      await prisma.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash },
      });
      await prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      });

      // Invalidate all sessions for security
      await prisma.session.deleteMany({ where: { userId: resetToken.userId } });

      return reply.status(200).send({ ok: true });
    },
  );
}
