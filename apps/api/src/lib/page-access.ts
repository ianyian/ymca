import type { Page } from "@prisma/client";
import { prisma } from "./prisma.js";
import { resolveEffectivePageRole } from "../domain/permissions.js";
import type { PageRole, WorkspaceRole } from "../domain/roles.js";

export type PageAccessResult =
  | {
      ok: true;
      page: Page;
      workspaceRole: WorkspaceRole;
      pageRole: PageRole;
    }
  | { ok: false; status: 404 | 403; code: string; message: string };

/**
 * Resolve a user's effective access to a page in one place.
 *
 * Loads the page (must exist and not be trashed), verifies the user belongs to
 * the workspace, then computes the effective PageRole via the permission engine
 * (workspace-role defaults, page creator = Owner, explicit grants/denies).
 *
 * Returns `ok: false` with a 404 (missing/trashed) or 403 (no membership or
 * effective role resolves to null) so callers can early-return uniformly.
 * On success, `page` excludes the loaded permission relation.
 */
export async function resolvePageAccess(
  userId: string,
  pageId: string,
  opts: { allowTrashed?: boolean } = {},
): Promise<PageAccessResult> {
  const loaded = await prisma.page.findUnique({
    where: { id: pageId },
    include: { permissions: true },
  });

  if (!loaded || (loaded.deletedAt !== null && !opts.allowTrashed)) {
    return {
      ok: false,
      status: 404,
      code: "PAGE_NOT_FOUND",
      message: "Page not found",
    };
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: loaded.workspaceId, userId },
    },
  });
  if (!membership) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "No access to page",
    };
  }

  const pageRole = resolveEffectivePageRole(
    {
      userId,
      workspaceRole: membership.role,
      isPageCreator: loaded.creatorId === userId,
    },
    (loaded.permissions ?? []).map((p) => ({
      userId: p.userId,
      workspaceRole: p.workspaceRole,
      pageRole: p.pageRole,
      isExplicitDeny: p.isExplicitDeny,
    })),
  );

  if (pageRole === null) {
    return {
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "No access to page",
    };
  }

  const { permissions: _permissions, ...page } = loaded;
  return { ok: true, page, workspaceRole: membership.role, pageRole };
}
