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
const REVISION_ID = FIXTURES.revision.id;
const CSRF = FIXTURES.session.csrfToken;
const COOKIE = `ymca_session=fixture-raw-token`;

describe('GET /pages/:id/revisions', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}/revisions`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}/revisions`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}/revisions`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns revision list', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}/revisions`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { revisions: Array<{ id: string; version: number }> };
    assert.equal(body.revisions.length, 1);
    assert.equal(body.revisions[0]!.id, REVISION_ID);
    assert.equal(body.revisions[0]!.version, 1);
  });

  it('returns empty array when no revisions', async () => {
    setAuthSession();
    mockState.pageRevisionFindManyResult = [];

    const res = await app.inject({
      method: 'GET',
      url: `/pages/${PAGE_ID}/revisions`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { revisions: unknown[] };
    assert.deepEqual(body.revisions, []);
  });
});

describe('POST /pages/:id/revisions/:revisionId/restore', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/revisions/${REVISION_ID}/restore`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/revisions/${REVISION_ID}/restore`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'PAGE_NOT_FOUND');
  });

  it('returns 404 when revision not found', async () => {
    setAuthSession();
    mockState.pageRevisionFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/revisions/${REVISION_ID}/restore`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'REVISION_NOT_FOUND');
  });

  it('restores page to revision snapshot', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/revisions/${REVISION_ID}/restore`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string } };
    assert.equal(body.page.id, PAGE_ID);
  });
});
