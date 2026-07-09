-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('WorkspaceOwner', 'WorkspaceAdmin', 'WorkspaceMember', 'WorkspaceGuest');

-- CreateTable
CREATE TABLE "User" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "email"        TEXT         NOT NULL,
    "passwordHash" TEXT         NOT NULL,
    "displayName"  TEXT,
    "createdAt"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"    TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "userId"        UUID         NOT NULL,
    "tokenHash"     TEXT         NOT NULL,
    "csrfToken"     TEXT         NOT NULL,
    "userAgent"     TEXT,
    "ipAddress"     TEXT,
    "expiresAt"     TIMESTAMPTZ  NOT NULL,
    "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "lastSeenAt"    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "invalidatedAt" TIMESTAMPTZ,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
    "name"      TEXT         NOT NULL,
    "slug"      TEXT         NOT NULL,
    "ownerId"   UUID         NOT NULL,
    "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id"          UUID            NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId" UUID            NOT NULL,
    "userId"      UUID            NOT NULL,
    "role"        "WorkspaceRole" NOT NULL,
    "invitedById" UUID,
    "createdAt"   TIMESTAMPTZ     NOT NULL DEFAULT now(),
    "updatedAt"   TIMESTAMPTZ     NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Page" (
    "id"            UUID         NOT NULL DEFAULT gen_random_uuid(),
    "workspaceId"   UUID         NOT NULL,
    "parentPageId"  UUID,
    "creatorId"     UUID         NOT NULL,
    "title"         TEXT         NOT NULL DEFAULT 'Untitled',
    "icon"          TEXT,
    "coverImageUrl" TEXT,
    "content"       JSONB        NOT NULL DEFAULT '{}',
    "position"      DECIMAL(65,30),
    "version"       INTEGER      NOT NULL DEFAULT 1,
    "deletedAt"     TIMESTAMPTZ,
    "createdAt"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageRevision" (
    "id"        UUID         NOT NULL DEFAULT gen_random_uuid(),
    "pageId"    UUID         NOT NULL,
    "version"   INTEGER      NOT NULL,
    "snapshot"  JSONB        NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT "PageRevision_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_workspaceId_idx" ON "WorkspaceMember"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE INDEX "Page_workspaceId_idx" ON "Page"("workspaceId");

-- CreateIndex
CREATE INDEX "Page_parentPageId_idx" ON "Page"("parentPageId");

-- CreateIndex
CREATE INDEX "Page_workspaceId_deletedAt_idx" ON "Page"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "PageRevision_pageId_createdAt_idx" ON "PageRevision"("pageId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session"
    ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace"
    ADD CONSTRAINT "Workspace_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember"
    ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember"
    ADD CONSTRAINT "WorkspaceMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page"
    ADD CONSTRAINT "Page_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page"
    ADD CONSTRAINT "Page_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Page"
    ADD CONSTRAINT "Page_parentPageId_fkey"
    FOREIGN KEY ("parentPageId") REFERENCES "Page"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageRevision"
    ADD CONSTRAINT "PageRevision_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;
