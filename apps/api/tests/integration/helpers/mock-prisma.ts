/**
 * Shared mock Prisma client for integration tests.
 *
 * Usage pattern (at the TOP of each integration test file, before any other imports):
 *
 *   import { mock } from 'node:test';
 *   import { mockPrisma, mockState, resetMockState, setAuthSession, FIXTURES } from './helpers/mock-prisma.ts';
 *
 *   mock.module(new URL('../../src/lib/prisma.js', import.meta.url), {
 *     namedExports: { prisma: mockPrisma },
 *   });
 *
 *   const { createServer } = await import('../../src/server.ts');
 */

import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Stable test fixtures
// ---------------------------------------------------------------------------

export const FIXTURES = {
  user: {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    email: 'fixture@test.com',
    displayName: 'Fixture User',
    // bcrypt hash for "TestPass1!" at cost 4 â€“ pre-computed to keep tests fast
    passwordHash: '$2b$04$SomeMockedHashValueThatWillBeIgnoredByMockedPrisma.......',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  session: {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    tokenHash: 'fixture-token-hash',
    csrfToken: 'fixture-csrf-token',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date('2024-01-01T00:00:00Z'),
    lastSeenAt: new Date('2024-01-01T00:00:00Z'),
    invalidatedAt: null,
    userAgent: null,
    ipAddress: null,
  },
  workspace: {
    id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    name: 'Fixture Workspace',
    slug: 'fixture-workspace',
    ownerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  page: {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    workspaceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    parentPageId: null,
    creatorId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    title: 'Untitled',
    icon: null,
    coverImageUrl: null,
    content: { type: 'doc', content: [] },
    position: null,
    version: 1,
    isPublished: false,
    publishedAt: null,
    publishToken: null,
    deletedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  publishedPage: {
    id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    workspaceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    parentPageId: null,
    creatorId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    title: 'Untitled',
    icon: null,
    coverImageUrl: null,
    content: { type: 'doc', content: [] },
    tags: [],
    position: null,
    version: 1,
    isPublished: true,
    publishedAt: new Date('2024-01-01T00:00:00Z'),
    publishToken: 'test-publish-token-abc123def456',
    publishTheme: 'muji',
    deletedAt: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  revision: {
    id: '11111111-1111-1111-1111-111111111111',
    pageId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    version: 1,
    snapshot: { type: 'doc', content: [] },
    createdBy: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    createdAt: new Date('2024-01-01T00:00:00Z'),
  },
  permission: {
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    pageId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    workspaceRole: null,
    pageRole: 'Editor' as const,
    isExplicitDeny: false,
    grantedById: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
  },
  invite: {
    id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    workspaceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    email: 'invitee@test.com',
    role: 'WorkspaceMember' as const,
    token: 'test-invite-token-abc123',
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    usedAt: null,
    createdById: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    createdAt: new Date('2024-01-01T00:00:00Z'),
  },
};

// ---------------------------------------------------------------------------
// Mutable state (controlled per test via resetMockState / setAuthSession)
// ---------------------------------------------------------------------------

export type MockState = {
  // Auth hook: which session resolveAuthFromRequest returns
  resolvedSession: (typeof FIXTURES.session & { user: { id: string; email: string; displayName: string | null } }) | null;

  // user.create overrides
  userCreateResult: typeof FIXTURES.user | null;
  userCreateError: Error | null;

  // user.findUnique override (null = not found)
  userFindUniqueResult: typeof FIXTURES.user | null;

  // workspace.$transaction result
  workspaceTransactionResult: typeof FIXTURES.workspace | null;
  workspaceCreateError: Error | null;

  // workspaceMember.findMany result
  workspaceMembersResult: Array<{ id: string; workspace: typeof FIXTURES.workspace; role: string; createdAt: Date }>;

  // workspaceMember.findUnique (access check for CALLER) — null means no access
  workspaceAccessResult: { id: string; role: string } | null;

  // workspaceMember.findUnique for TARGET user (share route) — undefined = fall back to workspaceAccessResult
  workspaceMemberTargetResult: { id: string; role: string } | null | undefined;

  // page.findUnique override
  pageFindUniqueResult: typeof FIXTURES.page | null;

  // page.findMany override (used by tree + trash routes)
  pageFindManyResult: typeof FIXTURES.page[];

  // page.update result
  pageUpdateResult: typeof FIXTURES.page | null;

  // page.$transaction result (for content update)
  pageTransactionResult: typeof FIXTURES.page | null;
  pageTransactionError: Error | null;

  // pagePermission state
  pagePermissionFindUniqueResult: typeof FIXTURES.permission | null;
  pagePermissionCreateResult: typeof FIXTURES.permission | null;
  pagePermissionCreateError: Error | null;

  // inviteToken state
  inviteFindUniqueResult: typeof FIXTURES.invite | null;
  inviteCreateResult: typeof FIXTURES.invite | null;
  inviteCreateError: Error | null;

  // Phase 3: publish — page.findUnique by publishToken
  pagePublishTokenResult: typeof FIXTURES.publishedPage | null;

  // Phase 3: revisions list
  pageRevisionFindManyResult: typeof FIXTURES.revision[];

  // Phase 3: pageRevision.findUnique (for restore)
  pageRevisionFindUniqueResult: typeof FIXTURES.revision | null;

  // Attachments — public-page route lists them for the published-page download section
  pageAttachmentFindManyResult: { id: string; originalName: string; size: number }[];

  // Phase 3: $queryRaw search results
  searchQueryResult: Array<{ id: string; title: string; icon: string | null; workspaceId: string; deletedAt: Date | null }>;
};

export const mockState: MockState = {
  resolvedSession: null,
  userCreateResult: null,
  userCreateError: null,
  userFindUniqueResult: null,
  workspaceTransactionResult: null,
  workspaceCreateError: null,
  workspaceMembersResult: [],
  workspaceAccessResult: null,
  workspaceMemberTargetResult: undefined,
  pageFindUniqueResult: FIXTURES.page,
  pageFindManyResult: [],
  pageUpdateResult: FIXTURES.page,
  pageTransactionResult: { ...FIXTURES.page, version: 2 },
  pageTransactionError: null,
  pagePermissionFindUniqueResult: FIXTURES.permission,
  pagePermissionCreateResult: FIXTURES.permission,
  pagePermissionCreateError: null,
  inviteFindUniqueResult: FIXTURES.invite,
  inviteCreateResult: FIXTURES.invite,
  inviteCreateError: null,
  pagePublishTokenResult: FIXTURES.publishedPage,
  pageRevisionFindManyResult: [FIXTURES.revision],
  pageRevisionFindUniqueResult: FIXTURES.revision,
  pageAttachmentFindManyResult: [],
  searchQueryResult: [],
};

export function resetMockState(overrides: Partial<MockState> = {}): void {
  mockState.resolvedSession = null;
  mockState.userCreateResult = null;
  mockState.userCreateError = null;
  mockState.userFindUniqueResult = null;
  mockState.workspaceTransactionResult = null;
  mockState.workspaceCreateError = null;
  mockState.workspaceMembersResult = [];
  mockState.workspaceAccessResult = null;
  mockState.pageFindUniqueResult = FIXTURES.page;
  mockState.pageFindManyResult = [];
  mockState.pageUpdateResult = FIXTURES.page;
  mockState.workspaceMemberTargetResult = undefined;
  mockState.pageTransactionResult = { ...FIXTURES.page, version: 2 };
  mockState.pageTransactionError = null;
  mockState.pagePermissionFindUniqueResult = FIXTURES.permission;
  mockState.pagePermissionCreateResult = FIXTURES.permission;
  mockState.pagePermissionCreateError = null;
  mockState.inviteFindUniqueResult = FIXTURES.invite;
  mockState.inviteCreateResult = FIXTURES.invite;
  mockState.inviteCreateError = null;
  mockState.pagePublishTokenResult = FIXTURES.publishedPage;
  mockState.pageRevisionFindManyResult = [FIXTURES.revision];
  mockState.pageRevisionFindUniqueResult = FIXTURES.revision;
  mockState.pageAttachmentFindManyResult = [];
  mockState.searchQueryResult = [];

  Object.assign(mockState, overrides);
}

/** Convenience: make all authenticated requests succeed as FIXTURES.user */
export function setAuthSession(): void {
  mockState.resolvedSession = {
    ...FIXTURES.session,
    user: {
      id: FIXTURES.user.id,
      email: FIXTURES.user.email,
      displayName: FIXTURES.user.displayName,
    },
  };
  mockState.workspaceAccessResult = { id: 'member-id', role: 'WorkspaceOwner' };
}

// ---------------------------------------------------------------------------
// Mock Prisma client
// ---------------------------------------------------------------------------

export const mockPrisma = {
  user: {
    create: async (args: { data: { email: string; passwordHash: string; displayName?: string } }) => {
      if (mockState.userCreateError) throw mockState.userCreateError;
      return mockState.userCreateResult ?? {
        id: FIXTURES.user.id,
        email: args.data.email,
        displayName: args.data.displayName ?? null,
      };
    },
    findUnique: async (_args: unknown) => mockState.userFindUniqueResult,
  },

  session: {
    create: async (args: { data: { userId: string; tokenHash: string; csrfToken: string; expiresAt: Date; userAgent?: string; ipAddress?: string } }) => ({
      ...FIXTURES.session,
      userId: args.data.userId,
      tokenHash: args.data.tokenHash,
      csrfToken: args.data.csrfToken,
      expiresAt: args.data.expiresAt,
    }),
    findFirst: async (_args: unknown) => mockState.resolvedSession,
    update: async (_args: unknown) => FIXTURES.session,
  },

  workspaceMember: {
    create: async (_args: unknown) => ({
      id: 'member-id',
      workspaceId: FIXTURES.workspace.id,
      userId: FIXTURES.user.id,
      role: 'WorkspaceOwner',
      invitedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    findMany: async (_args: unknown) => mockState.workspaceMembersResult,
    findUnique: async (args: { where?: { workspaceId_userId?: { userId?: string } } }) => {
      const userId = args?.where?.workspaceId_userId?.userId;
      // If querying for a user other than the fixture user, use target result
      if (userId && userId !== FIXTURES.user.id && mockState.workspaceMemberTargetResult !== undefined) {
        return mockState.workspaceMemberTargetResult;
      }
      return mockState.workspaceAccessResult;
    },
  },

  workspace: {
    create: async (args: { data: { name: string; slug: string; ownerId: string } }) => {
      if (mockState.workspaceCreateError) throw mockState.workspaceCreateError;
      return mockState.workspaceTransactionResult ?? {
        ...FIXTURES.workspace,
        name: args.data.name,
        slug: args.data.slug,
        ownerId: args.data.ownerId,
      };
    },
  },

  page: {
    create: async (args: { data: { workspaceId: string; title?: string; creatorId: string; content: unknown; parentPageId?: string } }) => ({
      ...FIXTURES.page,
      workspaceId: args.data.workspaceId,
      title: args.data.title ?? 'Untitled',
      creatorId: args.data.creatorId,
    }),
    findUnique: async (args: { where?: Record<string, unknown> }) => {
      // If querying by publishToken, return publishedPage fixture
      if (args?.where && 'publishToken' in args.where) {
        return mockState.pagePublishTokenResult;
      }
      return mockState.pageFindUniqueResult;
    },
    findMany: async (_args: unknown) => mockState.pageFindManyResult,
    update: async (args: { data: Record<string, unknown> }) => ({
      ...(mockState.pageUpdateResult ?? FIXTURES.page),
      ...args.data,
    }),
  },

  pageRevision: {
    create: async (_args: unknown) => ({
      id: 'revision-id',
      pageId: FIXTURES.page.id,
      version: 2,
      snapshot: {},
      createdBy: FIXTURES.user.id,
      createdAt: new Date(),
    }),
    findMany: async (_args: unknown) => mockState.pageRevisionFindManyResult,
    findUnique: async (_args: unknown) => mockState.pageRevisionFindUniqueResult,
    deleteMany: async (_args: unknown) => ({ count: 0 }),
  },

  pageAttachment: {
    findMany: async (_args: unknown) => mockState.pageAttachmentFindManyResult,
  },

  pagePermission: {
    create: async (_args: unknown) => {
      if (mockState.pagePermissionCreateError) throw mockState.pagePermissionCreateError;
      return mockState.pagePermissionCreateResult ?? FIXTURES.permission;
    },
    findUnique: async (_args: unknown) => mockState.pagePermissionFindUniqueResult,
    delete: async (_args: unknown) => FIXTURES.permission,
  },

  inviteToken: {
    create: async (_args: unknown) => {
      if (mockState.inviteCreateError) throw mockState.inviteCreateError;
      return mockState.inviteCreateResult ?? FIXTURES.invite;
    },
    findUnique: async (_args: unknown) => mockState.inviteFindUniqueResult,
    update: async (args: { data: Record<string, unknown> }) => ({
      ...(mockState.inviteCreateResult ?? FIXTURES.invite),
      ...args.data,
    }),
  },

  $transaction: async (fnOrOps: ((tx: typeof mockPrisma) => Promise<unknown>) | unknown[]) => {
    if (mockState.pageTransactionError) throw mockState.pageTransactionError;
    if (typeof fnOrOps === 'function') {
      return fnOrOps(mockPrisma);
    }
    // Array of operations — resolve them all sequentially
    const results: unknown[] = [];
    for (const op of fnOrOps as Promise<unknown>[]) {
      results.push(await op);
    }
    return results;
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  $queryRaw: async (_strings: unknown, ..._values: unknown[]) => mockState.searchQueryResult,
} satisfies Record<string, unknown>;

// Prisma error factory â€” constructs an error that passes instanceof checks
export function makePrismaKnownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Mock constraint error', {
    code,
    clientVersion: '0.0.0',
  });
}
