import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { startNeonProxy } from "./lib/neon-proxy.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { resolveAuthFromRequest } from "./auth/session.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerPageRoutes } from "./routes/pages.js";
import { registerTreeRoutes } from "./routes/tree.js";
import { registerTrashRoutes } from "./routes/trash.js";
import { registerMoveRoutes } from "./routes/move.js";
import { registerShareRoutes } from "./routes/share.js";
import { registerInviteRoutes } from "./routes/invite.js";
import { registerPublishRoutes } from "./routes/publish.js";
import { registerPublicPageRoutes } from "./routes/public-page.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerRevisionRoutes } from "./routes/revisions.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";

type ErrorEnvelope = {
  code: string;
  message: string;
  traceId: string;
};

export function createServer() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
    },
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024 * 1024, // 1 GB — large pages with many images/docs
  });

  // CORS: if CORS_ORIGINS is set, restrict to that allowlist; otherwise reflect
  // the request origin (convenient for local/LAN dev). Set CORS_ORIGINS in
  // production to lock cross-origin access down to your web app's origin(s).
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // Rate limiting: tight on auth endpoints (brute-force protection), looser
  // elsewhere. Disabled under test so the suite isn't throttled.
  if (process.env.NODE_ENV !== "test") {
    app.register(rateLimit, {
      global: true,
      max: (request) => (request.url.startsWith("/auth/") ? 10 : 200),
      timeWindow: "1 minute",
    });
  }

  app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-trace-id", request.id);

    const authPayload = await resolveAuthFromRequest(request);
    if (!authPayload) {
      return;
    }

    request.authUser = authPayload.user;
    request.authSessionId = authPayload.sessionId;
    request.csrfToken = authPayload.csrfToken;
    request.authViaBearer = authPayload.viaBearer;
  });

  app.addHook("preHandler", async (request, reply) => {
    const isMutatingMethod =
      request.method === "POST" ||
      request.method === "PUT" ||
      request.method === "PATCH" ||
      request.method === "DELETE";
    if (!isMutatingMethod || !request.authSessionId) {
      return;
    }

    if (request.url === "/auth/register" || request.url === "/auth/login") {
      return;
    }

    // Bearer-authenticated requests aren't subject to CSRF: the token is only
    // ever sent explicitly by our own code, never auto-attached by the browser.
    if (request.authViaBearer) {
      return;
    }

    const csrfHeader = request.headers["x-csrf-token"];
    if (!csrfHeader || csrfHeader !== request.csrfToken) {
      return reply.status(403).send({
        code: "CSRF_MISMATCH",
        message: "Invalid CSRF token",
        traceId: request.id,
      });
    }
  });

  app.register(registerAuthRoutes);
  app.register(registerWorkspaceRoutes);
  app.register(registerPageRoutes);
  app.register(registerTreeRoutes);
  app.register(registerTrashRoutes);
  app.register(registerMoveRoutes);
  app.register(registerShareRoutes);
  app.register(registerInviteRoutes);
  app.register(registerPublishRoutes);
  app.register(registerPublicPageRoutes);
  app.register(registerSearchRoutes);
  app.register(registerRevisionRoutes);
  app.register(registerAttachmentRoutes);

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              traceId: { type: "string" },
            },
            required: ["status", "traceId"],
          },
        },
      },
    },
    async (request) => {
      return {
        status: "ok",
        traceId: request.id,
      };
    },
  );

  app.setNotFoundHandler(async (request, reply) => {
    const body: ErrorEnvelope = {
      code: "NOT_FOUND",
      message: "Route not found",
      traceId: request.id,
    };
    return reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = error as {
      statusCode?: unknown;
      message?: unknown;
    };
    const statusCode =
      typeof normalizedError.statusCode === "number"
        ? normalizedError.statusCode
        : 500;
    const body: ErrorEnvelope = {
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
      message:
        statusCode >= 500
          ? "Internal server error"
          : typeof normalizedError.message === "string"
            ? normalizedError.message
            : "Request error",
      traceId: request.id,
    };

    request.log.error(
      {
        err: error,
        traceId: request.id,
      },
      "request failed",
    );

    return reply.status(statusCode).send(body);
  });

  return app;
}
