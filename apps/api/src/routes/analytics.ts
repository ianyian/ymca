import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/require-auth.js";
import { getUserActivitySummary, parseAnalyticsWindow } from "../domain/user-analytics.js";
import { recordActivity } from "../lib/activity-buffer.js";

// NOTE: fields that the client may send as `null` MUST allow the "null" type.
// Fastify/ajv has `coerceTypes` on, so a `null` against a bare `type: "string"`
// is coerced to "" — which then fails to insert into the uuid `pageId` column
// and drops the whole batch. Allowing null keeps the value null.
const analyticsEventSchema = {
  type: "object",
  properties: {
    eventType: { type: "string", minLength: 1, maxLength: 24 },
    target: { type: ["string", "null"], maxLength: 128 },
    pageId: { type: ["string", "null"], maxLength: 64 },
    x: { type: ["number", "null"] },
    y: { type: ["number", "null"] },
    durationMs: { type: ["number", "null"] },
  },
  required: ["eventType"],
  additionalProperties: false,
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const analyticsBatchSchema = {
  type: "object",
  properties: {
    events: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: analyticsEventSchema,
    },
  },
  required: ["events"],
  additionalProperties: false,
} as const;

function toActivityRecord(userId: string, body: {
  eventType: string;
  target?: string;
  pageId?: string;
  x?: number;
  y?: number;
  durationMs?: number;
}) {
  return {
    userId,
    eventType: body.eventType,
    method: "CLIENT",
    path: "/analytics/events",
    target: body.target ? body.target : null,
    // pageId is a uuid column — accept only well-formed uuids, else null. An
    // invalid value here would fail the whole createMany batch.
    pageId:
      typeof body.pageId === "string" && UUID_RE.test(body.pageId)
        ? body.pageId
        : null,
    x: Number.isFinite(body.x ?? NaN) ? Math.round(body.x ?? 0) : null,
    y: Number.isFinite(body.y ?? NaN) ? Math.round(body.y ?? 0) : null,
    statusCode: 200,
    durationMs:
      Number.isFinite(body.durationMs ?? NaN) && body.durationMs != null
        ? Math.max(0, Math.round(body.durationMs))
        : null,
    createdAt: new Date(),
  };
}

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.post(
    "/analytics/events",
    { schema: { body: analyticsEventSchema } },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const body = request.body as {
        eventType: string;
        target?: string;
        pageId?: string;
        x?: number;
        y?: number;
        durationMs?: number;
      };

      recordActivity(toActivityRecord(user.id, body));

      return reply.status(204).send();
    },
  );

  app.post(
    "/analytics/events/batch",
    { schema: { body: analyticsBatchSchema } },
    async (request, reply) => {
      const user = requireAuth(request, reply);
      if (!user) return;

      const body = request.body as {
        events: Array<{
          eventType: string;
          target?: string;
          pageId?: string;
          x?: number;
          y?: number;
          durationMs?: number;
        }>;
      };

      for (const event of body.events) {
        recordActivity(toActivityRecord(user.id, event));
      }

      return reply.status(204).send();
    },
  );

  app.get("/me/activity", async (request, reply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    const window = parseAnalyticsWindow((request.query as { window?: string }).window);
    return reply.send(await getUserActivitySummary(user.id, window));
  });
}