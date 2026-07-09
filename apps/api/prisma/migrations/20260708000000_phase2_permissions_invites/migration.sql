-- CreateEnum
CREATE TYPE "PageRole" AS ENUM ('Owner', 'Editor', 'Viewer');

-- CreateTable
CREATE TABLE "PagePermission" (
    "id"             UUID         NOT NULL DEFAULT gen_random_uuid(),
    "pageId"         UUID         NOT NULL,
    "userId"         UUID,
    "workspaceRole"  "WorkspaceRole",
    "pageRole"       "PageRole"   NOT NULL,
    "isExplicitDeny" BOOLEAN      NOT NULL DEFAULT false,
    "grantedById"    UUID,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"      TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "PagePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteToken" (
    "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID            NOT NULL,
    "email"       TEXT,
    "role"        "WorkspaceRole" NOT NULL,
    "token"       TEXT            NOT NULL,
    "expiresAt"   TIMESTAMPTZ     NOT NULL,
    "usedAt"      TIMESTAMPTZ,
    "createdById" UUID            NOT NULL,
    "createdAt"   TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CONSTRAINT "InviteToken_pkey" PRIMARY KEY ("id")
);

-- AlterTable: add User relations (no column changes needed — handled by FK below)

-- CreateIndex
CREATE INDEX "PagePermission_pageId_idx" ON "PagePermission"("pageId");
CREATE INDEX "PagePermission_userId_idx" ON "PagePermission"("userId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "InviteToken_token_key" ON "InviteToken"("token");

-- CreateIndex
CREATE INDEX "InviteToken_workspaceId_idx" ON "InviteToken"("workspaceId");
CREATE INDEX "InviteToken_token_idx" ON "InviteToken"("token");

-- AddForeignKey
ALTER TABLE "PagePermission"
    ADD CONSTRAINT "PagePermission_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PagePermission"
    ADD CONSTRAINT "PagePermission_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InviteToken"
    ADD CONSTRAINT "InviteToken_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InviteToken"
    ADD CONSTRAINT "InviteToken_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
