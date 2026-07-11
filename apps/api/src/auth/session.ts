import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../lib/prisma.js";
import type { AppEnv } from "../config/env.js";
import { generateSecureToken, hashSessionToken } from "./token.js";

export const SESSION_COOKIE_NAME = "ymca_session";
const SESSION_COOKIE_SAME_SITE =
  process.env.NODE_ENV === "production" ? "none" : "lax";

type AuthPayload = {
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
  sessionId: string;
  csrfToken: string;
};

export async function createSessionForUser(params: {
  userId: string;
  env: AppEnv;
  userAgent?: string;
  ipAddress?: string;
}) {
  const rawToken = generateSecureToken();
  const csrfToken = generateSecureToken(24);
  const expiresAt = new Date(
    Date.now() + params.env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const session = await prisma.session.create({
    data: {
      userId: params.userId,
      tokenHash: hashSessionToken(rawToken),
      csrfToken,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
      expiresAt,
    },
  });

  return {
    rawToken,
    csrfToken,
    expiresAt,
    sessionId: session.id,
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: SESSION_COOKIE_SAME_SITE,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: SESSION_COOKIE_SAME_SITE,
  });
}

export async function resolveAuthFromRequest(
  request: FastifyRequest,
): Promise<AuthPayload | null> {
  const rawToken = request.cookies[SESSION_COOKIE_NAME];
  if (!rawToken) {
    return null;
  }

  const session = await prisma.session.findFirst({
    where: {
      tokenHash: hashSessionToken(rawToken),
      invalidatedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
  });

  if (!session) {
    return null;
  }

  // Throttle lastSeenAt writes: only touch the row if it's been stale for a
  // while, so read-heavy request traffic doesn't cause a write on every request.
  const LAST_SEEN_THROTTLE_MS = 60 * 1000;
  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
  }

  return {
    user: session.user,
    sessionId: session.id,
    csrfToken: session.csrfToken,
  };
}

export async function invalidateSessionById(sessionId: string) {
  await prisma.session.update({
    where: { id: sessionId },
    data: {
      invalidatedAt: new Date(),
    },
  });
}
