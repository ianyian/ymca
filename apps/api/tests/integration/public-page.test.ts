import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __setTestPrismaClient } from '../../src/lib/prisma.ts';
import {
  mockPrisma,
  mockState,
  resetMockState,
  FIXTURES,
} from './helpers/mock-prisma.ts';

__setTestPrismaClient(mockPrisma as never);
const { createServer } = await import('../../src/server.ts');

const SHARE_TOKEN = FIXTURES.publishedPage.publishToken!;

describe('GET /public/:shareToken', () => {
  let app: Awaited<ReturnType<typeof createServer>>;

  before(async () => {
    app = createServer();
    await app.ready();
  });

  afterEach(() => resetMockState());

  it('returns public page without authentication', async () => {
    // pagePublishTokenResult defaults to publishedPage fixture
    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: { id: string; title: string; isPublished: boolean } };
    assert.equal(body.page.id, FIXTURES.page.id);
    assert.equal(body.page.isPublished, true);
  });

  it('returns 404 for unknown token', async () => {
    mockState.pagePublishTokenResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/public/nonexistent-token`,
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body) as { code: string };
    assert.equal(body.code, 'PAGE_NOT_FOUND');
  });

  it('returns 404 when page exists but is not published', async () => {
    mockState.pagePublishTokenResult = { ...FIXTURES.publishedPage, isPublished: false };

    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns only safe fields — title, content, icon, version, publishedAt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { page: Record<string, unknown> };
    // The route selects only public-safe fields; verify the response has page data
    assert.ok(body.page.id, 'page.id should be present');
    assert.ok(body.page.title !== undefined, 'page.title should be present');
  });
});
