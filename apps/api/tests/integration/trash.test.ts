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
const WORKSPACE_ID = FIXTURES.workspace.id;
const CSRF = FIXTURES.session.csrfToken;
const COOKIE = `ymca_session=fixture-raw-token`;

describe('DELETE /pages/:id (trash)', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/pages/${PAGE_ID}` });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'PAGE_NOT_FOUND');
  });

  it('returns 404 when page already deleted', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = { ...FIXTURES.page, deletedAt: new Date() };

    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 403);
  });

  it('soft-deletes page and returns it', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'DELETE',
      url: `/pages/${PAGE_ID}`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string } };
    assert.equal(body.page.id, PAGE_ID);
  });
});

describe('POST /pages/:id/restore', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/restore`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 when page is not deleted', async () => {
    setAuthSession();
    // deletedAt is null — page is live
    mockState.pageFindUniqueResult = { ...FIXTURES.page, deletedAt: null };

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/restore`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'PAGE_NOT_DELETED');
  });

  it('restores a deleted page', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = { ...FIXTURES.page, deletedAt: new Date() };

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/restore`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string } };
    assert.equal(body.page.id, PAGE_ID);
  });
});

describe('GET /workspaces/:workspaceId/trash', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/trash`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when not a member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/trash`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns trash pages', async () => {
    setAuthSession();
    const deletedPage = { ...FIXTURES.page, deletedAt: new Date() };
    mockState.pageFindManyResult = [deletedPage] as typeof FIXTURES.page[];

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/trash`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { pages: unknown[] };
    assert.equal(body.pages.length, 1);
  });
});
