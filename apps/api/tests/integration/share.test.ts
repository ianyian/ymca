import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestPrismaClient } from '../../src/lib/prisma.ts';
import {
  mockPrisma,
  mockState,
  resetMockState,
  setAuthSession,
  FIXTURES,
} from './helpers/mock-prisma.ts';

__setTestPrismaClient(mockPrisma as never);
const { createServer } = await import('../../src/server.ts');

const PAGE_ID = FIXTURES.page.id;
const PERM_ID = FIXTURES.permission.id;
const CSRF = FIXTURES.session.csrfToken;
const COOKIE = `ymca_session=fixture-raw-token`;

describe('POST /pages/:id/share', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/share`,
      payload: { pageRole: 'Viewer' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/share`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { pageRole: 'Viewer' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/share`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { pageRole: 'Viewer' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('creates permission without userId (workspace-wide)', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/share`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { pageRole: 'Editor' },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body) as { permission: { id: string } };
    assert.equal(body.permission.id, PERM_ID);
  });

  it('creates permission for a specific user', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/share`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: {
        userId: FIXTURES.user.id,
        pageRole: 'Editor',
      },
    });
    assert.equal(res.statusCode, 201);
  });

  it('returns 400 when target userId is not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceMemberTargetResult = null; // target user not in workspace

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/share`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { userId: '99999999-9999-9999-9999-999999999999', pageRole: 'Editor' },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'USER_NOT_IN_WORKSPACE');
  });
});

describe('DELETE /pages/:id/share/:permissionId', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}/share/${PERM_ID}`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when permission not found', async () => {
    setAuthSession();
    mockState.pagePermissionFindUniqueResult = null;

    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}/share/${PERM_ID}`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'PERMISSION_NOT_FOUND');
  });

  it('deletes permission and returns 204', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}/share/${PERM_ID}`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 204);
  });
});
