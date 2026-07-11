import type { PagePermissionRecord, PageRole, WorkspaceRole } from "./roles.js";

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  WorkspaceOwner: 4,
  WorkspaceAdmin: 3,
  WorkspaceMember: 2,
  WorkspaceGuest: 1,
};

const PAGE_ROLE_RANK: Record<PageRole, number> = {
  Owner: 3,
  Editor: 2,
  Viewer: 1,
};

export type PermissionContext = {
  userId: string;
  workspaceRole: WorkspaceRole;
  isPageCreator: boolean;
};

/**
 * Resolve the effective PageRole for a user on a specific page.
 * Rules (highest priority first):
 *   1. Workspace owner/admin always get Owner page role
 *   2. Page creator always gets Owner page role
 *   3. Explicit-deny record for this user → no access (returns null)
 *   4. Explicit user-level permission (highest pageRole wins)
 *   5. Workspace-role-level permission (matching or lower workspace role)
 *   6. Default: WorkspaceMember → Viewer, WorkspaceGuest → null
 */
export function resolveEffectivePageRole(
  ctx: PermissionContext,
  permissions: PagePermissionRecord[],
): PageRole | null {
  if (
    ctx.workspaceRole === "WorkspaceOwner" ||
    ctx.workspaceRole === "WorkspaceAdmin"
  ) {
    return "Owner";
  }

  if (ctx.isPageCreator) {
    return "Owner";
  }

  // Check for explicit deny targeting this user
  const userDeny = permissions.find(
    (p) => p.userId === ctx.userId && p.isExplicitDeny,
  );
  if (userDeny) return null;

  // Highest explicit user-level grant
  let best: PageRole | null = null;
  for (const p of permissions) {
    if (p.userId === ctx.userId && !p.isExplicitDeny) {
      const currentRank = best === null ? -1 : PAGE_ROLE_RANK[best];
      if (PAGE_ROLE_RANK[p.pageRole] > currentRank) {
        best = p.pageRole;
      }
    }
  }
  if (best !== null) return best;

  // Workspace-role-level grants (applies when user's rank >= permission's rank)
  const userRank = WORKSPACE_ROLE_RANK[ctx.workspaceRole];
  for (const p of permissions) {
    if (p.workspaceRole !== null && p.userId === null && !p.isExplicitDeny) {
      const permissionRank = WORKSPACE_ROLE_RANK[p.workspaceRole];
      if (userRank >= permissionRank) {
        const currentRank = best === null ? -1 : PAGE_ROLE_RANK[best];
        if (PAGE_ROLE_RANK[p.pageRole] > currentRank) {
          best = p.pageRole;
        }
      }
    }
  }
  if (best !== null) return best;

  // Defaults
  if (ctx.workspaceRole === "WorkspaceMember") return "Viewer";
  return null;
}

export function canEdit(role: PageRole | null): boolean {
  return role === "Owner" || role === "Editor";
}

export function canView(role: PageRole | null): boolean {
  return role !== null;
}

/** Only page Owners may grant/revoke sharing or publish state. */
export function canManage(role: PageRole | null): boolean {
  return role === "Owner";
}
