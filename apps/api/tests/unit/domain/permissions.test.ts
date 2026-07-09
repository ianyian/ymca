import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffectivePageRole,
  canEdit,
  canView,
  type PermissionContext,
} from '../../../src/domain/permissions.ts';
import type { PagePermission } from '@prisma/client';

type P = Pick<PagePermission, 'userId' | 'workspaceRole' | 'pageRole' | 'isExplicitDeny'>;

const noPerms: P[] = [];

function ctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    userId: 'user-1',
    workspaceRole: 'WorkspaceMember',
    isPageCreator: false,
    ...overrides,
  };
}

describe('resolveEffectivePageRole', () => {
  it('WorkspaceOwner always gets Owner', () => {
    assert.equal(
      resolveEffectivePageRole(ctx({ workspaceRole: 'WorkspaceOwner' }), noPerms),
      'Owner',
    );
  });

  it('WorkspaceAdmin always gets Owner', () => {
    assert.equal(
      resolveEffectivePageRole(ctx({ workspaceRole: 'WorkspaceAdmin' }), noPerms),
      'Owner',
    );
  });

  it('page creator gets Owner regardless of workspace role', () => {
    assert.equal(
      resolveEffectivePageRole(ctx({ isPageCreator: true, workspaceRole: 'WorkspaceGuest' }), noPerms),
      'Owner',
    );
  });

  it('explicit deny for user returns null', () => {
    const perms: P[] = [
      { userId: 'user-1', workspaceRole: null, pageRole: 'Viewer', isExplicitDeny: true },
    ];
    assert.equal(resolveEffectivePageRole(ctx(), perms), null);
  });

  it('explicit user grant returns that role', () => {
    const perms: P[] = [
      { userId: 'user-1', workspaceRole: null, pageRole: 'Editor', isExplicitDeny: false },
    ];
    assert.equal(resolveEffectivePageRole(ctx(), perms), 'Editor');
  });

  it('highest explicit user grant wins when multiple exist', () => {
    const perms: P[] = [
      { userId: 'user-1', workspaceRole: null, pageRole: 'Viewer', isExplicitDeny: false },
      { userId: 'user-1', workspaceRole: null, pageRole: 'Editor', isExplicitDeny: false },
    ];
    assert.equal(resolveEffectivePageRole(ctx(), perms), 'Editor');
  });

  it('workspace-role grant applies when user rank >= permission rank', () => {
    // WorkspaceMember (rank 2) >= WorkspaceMember (rank 2) → grant applies, overrides default Viewer
    const perms: P[] = [
      { userId: null, workspaceRole: 'WorkspaceMember', pageRole: 'Editor', isExplicitDeny: false },
    ];
    assert.equal(
      resolveEffectivePageRole(ctx({ workspaceRole: 'WorkspaceMember' }), perms),
      'Editor',
    );
  });

  it('workspace-role grant does NOT apply when user rank < permission rank', () => {
    const perms: P[] = [
      { userId: null, workspaceRole: 'WorkspaceAdmin', pageRole: 'Editor', isExplicitDeny: false },
    ];
    // WorkspaceGuest rank (1) < WorkspaceAdmin rank (3)
    assert.equal(
      resolveEffectivePageRole(ctx({ workspaceRole: 'WorkspaceGuest' }), perms),
      null,
    );
  });

  it('WorkspaceMember with no permissions defaults to Viewer', () => {
    assert.equal(resolveEffectivePageRole(ctx(), noPerms), 'Viewer');
  });

  it('WorkspaceGuest with no permissions defaults to null', () => {
    assert.equal(
      resolveEffectivePageRole(ctx({ workspaceRole: 'WorkspaceGuest' }), noPerms),
      null,
    );
  });

  it('explicit deny overrides workspace-role grant', () => {
    const perms: P[] = [
      { userId: null, workspaceRole: 'WorkspaceMember', pageRole: 'Editor', isExplicitDeny: false },
      { userId: 'user-1', workspaceRole: null, pageRole: 'Viewer', isExplicitDeny: true },
    ];
    assert.equal(resolveEffectivePageRole(ctx(), perms), null);
  });
});

describe('canEdit', () => {
  it('Owner can edit', () => assert.equal(canEdit('Owner'), true));
  it('Editor can edit', () => assert.equal(canEdit('Editor'), true));
  it('Viewer cannot edit', () => assert.equal(canEdit('Viewer'), false));
  it('null cannot edit', () => assert.equal(canEdit(null), false));
});

describe('canView', () => {
  it('Owner can view', () => assert.equal(canView('Owner'), true));
  it('Viewer can view', () => assert.equal(canView('Viewer'), true));
  it('null cannot view', () => assert.equal(canView(null), false));
});
