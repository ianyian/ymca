-- One personal quick-todo list per user (single row; items = JSON array).
CREATE TABLE "UserTodo" (
  "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"    UUID         NOT NULL,
  "items"     JSONB        NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "UserTodo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserTodo_userId_key" ON "UserTodo" ("userId");
ALTER TABLE "UserTodo"
  ADD CONSTRAINT "UserTodo_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
