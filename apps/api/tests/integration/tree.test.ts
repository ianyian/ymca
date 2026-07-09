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

describe('GET /workspaces/:workspaceId/pages/tree', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns 401 when not authenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/pages/tree`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when not a workspace member', async () => {
    setAuthSession();
    mockState.workspaceAccessResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/pages/tree`,
      headers: { cookie: `ymca_session=fixture-raw-token` },
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns empty tree when workspace has no pages', async () => {
    setAuthSession();
    mockState.pageFindManyResult = [];

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/pages/tree`,
      headers: { cookie: `ymca_session=fixture-raw-token` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { tree: unknown[] };
    assert.deepEqual(body.tree, []);
  });

  it('returns pages as a nested tree', async () => {
    setAuthSession();
    const parent = { ...FIXTURES.page, id: 'parent-id', position: '1' };
    const child = {
      ...FIXTURES.page,
      id: 'child-id',
      parentPageId: 'parent-id',
      position: '1',
    };
    mockState.pageFindManyResult = [parent, child] as typeof FIXTURES.page[];

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/pages/tree`,
      headers: { cookie: `ymca_session=fixture-raw-token` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { tree: Array<{ id: string; children: Array<{ id: string }> }> };
    assert.equal(body.tree.length, 1);
    assert.equal(body.tree[0]!.id, 'parent-id');
    assert.equal(body.tree[0]!.children.length, 1);
    assert.equal(body.tree[0]!.children[0]!.id, 'child-id');
  });

  it('excludes deleted pages from tree', async () => {
    setAuthSession();
    const live = { ...FIXTURES.page, id: 'live-id', position: '1' };
    const deleted = { ...FIXTURES.page, id: 'dead-id', position: '2', deletedAt: new Date() };
    mockState.pageFindManyResult = [live, deleted] as typeof FIXTURES.page[];

    const res = await app.inject({
      method: 'GET',
      url: `/workspaces/${WORKSPACE_ID}/pages/tree`,
      headers: { cookie: `ymca_session=fixture-raw-token` },
    });
    const body = JSON.parse(res.body) as { tree: Array<{ id: string }> };
    assert.equal(body.tree.length, 1);
    assert.equal(body.tree[0]!.id, 'live-id');
  });
});
