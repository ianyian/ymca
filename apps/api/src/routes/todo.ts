import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../auth/require-auth.js";

// A single personal todo list per user. Items are a small JSON array; we cap the
// count and text length so one request can't store an unbounded blob.
const MAX_ITEMS = 500;
const putTodoSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      maxItems: MAX_ITEMS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          text: { type: "string", maxLength: 2000 },
          done: { type: "boolean" },
          createdAt: { type: ["string", "null"], maxLength: 40 },
        },
        required: ["id", "text", "done"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  createdAt?: string | null;
};

export async function registerTodoRoutes(app: FastifyInstance) {
  // Fetch the current user's todo list (empty array if they have none yet).
  app.get("/me/todo", async (request, reply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    const row = await prisma.userTodo.findUnique({
      where: { userId: user.id },
      select: { items: true, updatedAt: true },
    });
    return reply.send({
      items: (row?.items as TodoItem[] | undefined) ?? [],
      updatedAt: row?.updatedAt ?? null,
    });
  });

  // Replace the whole list (the client owns ordering/ids and autosaves).
  app.put("/me/todo", { schema: { body: putTodoSchema } }, async (request, reply) => {
    const user = requireAuth(request, reply);
    if (!user) return;

    const { items } = request.body as { items: TodoItem[] };
    const value = items as unknown as Prisma.InputJsonValue;

    const saved = await prisma.userTodo.upsert({
      where: { userId: user.id },
      create: { userId: user.id, items: value },
      update: { items: value },
      select: { items: true, updatedAt: true },
    });
    return reply.send({
      items: (saved.items as TodoItem[]) ?? [],
      updatedAt: saved.updatedAt,
    });
  });
}
