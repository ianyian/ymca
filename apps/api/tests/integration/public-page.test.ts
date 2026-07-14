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

  it('renders the published page as HTML without authentication', async () => {
    mockState.pagePublishTokenResult = {
      ...FIXTURES.publishedPage,
      title: 'My Public Doc',
    };
    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /<!DOCTYPE html>/i);
    assert.match(res.body, /My Public Doc/);
  });

  it('returns a 404 HTML page for an unknown token', async () => {
    mockState.pagePublishTokenResult = null;

    const res = await app.inject({
      method: 'GET',
      url: `/public/nonexistent-token`,
    });
    assert.equal(res.statusCode, 404);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    assert.match(res.body, /not published or does not exist/i);
  });

  it('returns 404 when page exists but is not published', async () => {
    mockState.pagePublishTokenResult = { ...FIXTURES.publishedPage, isPublished: false };

    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 404);
  });

  it('does not leak internal fields (workspaceId, creatorId) in the HTML', async () => {
    mockState.pagePublishTokenResult = { ...FIXTURES.publishedPage };
    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, new RegExp(FIXTURES.publishedPage.workspaceId));
    assert.doesNotMatch(res.body, new RegExp(FIXTURES.publishedPage.creatorId));
  });

  it('renders no attachments section when the page has no attachments', async () => {
    mockState.pagePublishTokenResult = { ...FIXTURES.publishedPage };
    mockState.pageAttachmentFindManyResult = [];
    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 200);
    // The CSS rule (.page-attachments {...}) is always present in <style>;
    // only the rendered <section> element proves the list itself is absent.
    assert.doesNotMatch(res.body, /<section class="page-attachments">/);
  });

  it('lists attachments with a working download link and formatted size', async () => {
    mockState.pagePublishTokenResult = { ...FIXTURES.publishedPage };
    mockState.pageAttachmentFindManyResult = [
      { id: 'att-1', originalName: 'quarterly-report.pdf', size: 2_500_000 },
    ];
    const res = await app.inject({
      method: 'GET',
      url: `/public/${SHARE_TOKEN}`,
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<section class="page-attachments">/);
    assert.match(res.body, /quarterly-report\.pdf/);
    assert.match(res.body, /href="\/attachments\/att-1\/inline"/);
    assert.match(res.body, /2\.4 MB/);
  });
});
