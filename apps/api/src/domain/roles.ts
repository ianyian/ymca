export const WORKSPACE_ROLES = [
  "WorkspaceOwner",
  "WorkspaceAdmin",
  "WorkspaceMember",
  "WorkspaceGuest",
] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const PAGE_ROLES = ["Owner", "Editor", "Viewer"] as const;

export type PageRole = (typeof PAGE_ROLES)[number];

export type PagePermissionRecord = {
  userId: string | null;
  workspaceRole: WorkspaceRole | null;
  pageRole: PageRole;
  isExplicitDeny: boolean;
};
