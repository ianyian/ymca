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

describe('POST /pages/:id/move', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/move`,
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when page not found', async () => {
    setAuthSession();
    mockState.pageFindUniqueResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/move`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: {},
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/move`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: {},
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 400 when parentPageId === page id (cycle)', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/move`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { parentPageId: PAGE_ID },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'CIRCULAR_REFERENCE');
  });

  it('moves page to root (parentPageId: null)', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/move`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { parentPageId: null },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string } };
    assert.equal(body.page.id, PAGE_ID);
  });

  it('moves page after a sibling', async () => {
    setAuthSession();
    const sibling = { ...FIXTURES.page, id: 'sibling-id', position: '3' };
    // first findUnique returns the moved page; second returns the sibling
    let callCount = 0;
    const origFindUnique = mockPrisma.page.findUnique;
    (mockPrisma.page as Record<string, unknown>)['findUnique'] = async (_args: unknown) => {
      callCount++;
      if (callCount === 1) return FIXTURES.page;
      return sibling;
    };

    const res = await app.inject({
      method: 'POST',
      url: `/pages/${PAGE_ID}/move`,
      headers: { cookie: COOKIE, 'x-csrf-token': CSRF },
      payload: { afterPageId: sibling.id },
    });

    (mockPrisma.page as Record<string, unknown>)['findUnique'] = origFindUnique;

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string } };
    assert.equal(body.page.id, PAGE_ID);
  });
});
