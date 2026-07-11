import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPageTree, type FlatPage } from '../../../src/domain/tree.ts';

function makePage(
  overrides: Partial<FlatPage> & { id: string },
): FlatPage {
  return {
    parentPageId: null,
    title: 'Untitled',
    icon: null,
    version: 1,
    deletedAt: null,
    ...overrides,
  };
}

describe('buildPageTree', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(buildPageTree([]), []);
  });

  it('single root page', () => {
    const pages = [makePage({ id: 'a', title: 'A' })];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.id, 'a');
    assert.deepEqual(tree[0]!.children, []);
  });

  it('excludes deleted pages', () => {
    const pages = [
      makePage({ id: 'a' }),
      makePage({ id: 'b', deletedAt: new Date() }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.id, 'a');
  });

  it('nests children under parent', () => {
    const pages = [
      makePage({ id: 'parent' }),
      makePage({ id: 'child', parentPageId: 'parent' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.children.length, 1);
    assert.equal(tree[0]!.children[0]!.id, 'child');
  });

  it('promotes orphaned page (parent is deleted) to root', () => {
    const pages = [
      makePage({ id: 'deleted-parent', deletedAt: new Date() }),
      makePage({ id: 'orphan', parentPageId: 'deleted-parent' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.id, 'orphan');
  });



  it('builds multi-level tree', () => {
    const pages = [
      makePage({ id: 'root' }),
      makePage({ id: 'child', parentPageId: 'root' }),
      makePage({ id: 'grandchild', parentPageId: 'child' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree[0]!.children[0]!.children[0]!.id, 'grandchild');
  });
});
