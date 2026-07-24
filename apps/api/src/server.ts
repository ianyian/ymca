import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { startNeonProxy } from "./lib/neon-proxy.js";
import {
  recordActivity,
  startActivityBuffer,
  stopActivityBuffer,
  startActivityRetention,
  stopActivityRetention,
} from "./lib/activity-buffer.js";
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
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerTodoRoutes } from "./routes/todo.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerRevisionRoutes } from "./routes/revisions.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerAdminRoutes } from "./routes/admin.js";

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

  // Rate limiting: strict only on the *sensitive* auth endpoints (brute-force
  // protection), generous everywhere else. Previously every /auth/* call shared
  // one tight 10/min bucket, so benign traffic — logout, language changes, even
  // repeated login/logout cycles during normal use — tripped the limit. Now only
  // credential-guessing endpoints are throttled, with a clear structured 429.
  // Disabled under test so the suite isn't throttled.
  const SENSITIVE_AUTH_PATHS = new Set([
    "/auth/login",
    "/auth/register",
    "/auth/forgot-password",
    "/auth/reset-password",
  ]);
  if (process.env.NODE_ENV !== "test") {
    app.register(rateLimit, {
      global: true,
      max: (request) =>
        SENSITIVE_AUTH_PATHS.has(request.url.split("?")[0] ?? request.url)
          ? 20
          : 300,
      timeWindow: "1 minute",
      // Structured, machine-readable 429 so the client can localize the message
      // and show a precise "retry in N seconds". The plugin *throws* this value,
      // so it must be an Error carrying `statusCode` (otherwise the global error
      // handler treats it as a 500). `retryAfter` is surfaced in the response
      // body — readable by the browser cross-origin, unlike the Retry-After
      // header. `ttl` is milliseconds remaining in the window.
      errorResponseBuilder: (request, context) => {
        const retryAfter = Math.max(1, Math.ceil(context.ttl / 1000));
        const err = new Error(
          `Too many attempts. Please try again in ${retryAfter} seconds.`,
        ) as Error & {
          statusCode: number;
          code: string;
          retryAfter: number;
        };
        err.statusCode = 429;
        err.code = "RATE_LIMITED";
        err.retryAfter = retryAfter;
        return err;
      },
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
  app.register(registerAnalyticsRoutes);
  app.register(registerTodoRoutes);
  app.register(registerSearchRoutes);
  app.register(registerRevisionRoutes);
  app.register(registerAttachmentRoutes);
  app.register(registerAdminRoutes);

  // ── Activity logging ──────────────────────────────────────────────────────
  // Record every finished request into the batched activity buffer, which powers
  // the CoMa monitoring dashboard (API-call volume, active users). Uses the
  // route *pattern* (e.g. "/pages/:id") to keep cardinality bounded, and never
  // blocks the response. Disabled under test.
  if (process.env.NODE_ENV !== "test") {
    startActivityBuffer();
    startActivityRetention();

    app.addHook("onResponse", async (request, reply) => {
      const method = request.method;
      if (method === "OPTIONS" || method === "HEAD") return;

      const routePattern =
        request.routeOptions?.url ?? request.url.split("?")[0] ?? request.url;

      // Skip noise: health checks and the monitoring endpoints themselves, so
      // the dashboard's own 3s polling doesn't inflate the API-call metric.
      if (
        routePattern === "/health" ||
        routePattern.startsWith("/admin/metrics") ||
        routePattern.startsWith("/analytics") ||
        routePattern.startsWith("/me/activity")
      ) {
        return;
      }

      recordActivity({
        userId: request.authUser?.id ?? null,
        method,
        path: routePattern.slice(0, 256),
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime ?? 0),
        createdAt: new Date(),
      });
    });

    app.addHook("onClose", async () => {
      stopActivityRetention();
      await stopActivityBuffer();
    });
  }

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
      code?: unknown;
      retryAfter?: unknown;
    };

    // Rate-limit rejections carry a structured, localizable payload; pass it
    // through verbatim (including retryAfter in the body) instead of flattening
    // it into the generic error envelope.
    if (normalizedError.code === "RATE_LIMITED") {
      return reply.status(429).send({
        code: "RATE_LIMITED",
        message:
          typeof normalizedError.message === "string"
            ? normalizedError.message
            : "Too many attempts",
        retryAfter:
          typeof normalizedError.retryAfter === "number"
            ? normalizedError.retryAfter
            : undefined,
        traceId: request.id,
      });
    }

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
