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
const CSRF = FIXTURES.session.csrfToken;
const COOKIE = `ymca_session=fixture-raw-token`;

describe('POST /pages/:id/publish', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/publish`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/publish`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/publish`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 403);
  });

  it('publishes the page and returns a publishToken', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/publish`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { publishToken: string; page: { id: string } };
    assert.ok(body.publishToken, 'publishToken should be present');
    assert.equal(body.page.id, PAGE_ID);
  });
});

describe('POST /pages/:id/unpublish', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/unpublish`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/unpublish`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 404);
  });

  it('unpublishes the page', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = { ...FIXTURES.publishedPage };

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/unpublish`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string } };
    assert.equal(body.page.id, PAGE_ID);
  });
});
