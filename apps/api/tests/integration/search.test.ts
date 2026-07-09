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

const WORKSPACE_ID = FIXTURES.workspace.id;
const COOKIE = `ymca_session=fixture-raw-token`;

describe('GET /search', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=test&workspaceId=${WORKSPACE_ID}`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/search?q=test&workspaceId=${WORKSPACE_ID}`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 400 when q is missing', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'GET',
      url: `/search?workspaceId=${WORKSPACE_ID}`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when workspaceId is missing', async () => {
    setAuthSession();

    const res = await app.inject({
      method: 'GET',
      url: `/search?q=test`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns empty results when nothing matches', async () => {
    setAuthSession();
    mockState.searchQueryResult = [];
    mockState.pageFindManyResult = [];

    const res = await app.inject({
      method: 'GET',
      url: `/search?q=nonexistent&workspaceId=${WORKSPACE_ID}`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { results: unknown[]; query: string };
    assert.deepEqual(body.results, []);
    assert.equal(body.query, 'nonexistent');
  });

  it('returns matching pages from search', async () => {
    setAuthSession();
    const matchPage = { id: FIXTURES.page.id, title: 'Test Page', icon: null, workspaceId: WORKSPACE_ID, deletedAt: null };
    mockState.searchQueryResult = [matchPage];

    const res = await app.inject({
      method: 'GET',
      url: `/search?q=test&workspaceId=${WORKSPACE_ID}`,
      headers: { cookie: COOKIE },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { results: Array<{ id: string }>; query: string };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0]!.id, FIXTURES.page.id);
    assert.equal(body.query, 'test');
  });
});
