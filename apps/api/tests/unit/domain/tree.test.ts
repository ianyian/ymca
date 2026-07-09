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
    position: null,
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
    const pages = [makePage({ id: 'a', title: 'A', position: '1' })];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.id, 'a');
    assert.deepEqual(tree[0]!.children, []);
  });

  it('excludes deleted pages', () => {
    const pages = [
      makePage({ id: 'a', position: '1' }),
      makePage({ id: 'b', position: '2', deletedAt: new Date() }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.id, 'a');
  });

  it('nests children under parent', () => {
    const pages = [
      makePage({ id: 'parent', position: '1' }),
      makePage({ id: 'child', parentPageId: 'parent', position: '1' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.children.length, 1);
    assert.equal(tree[0]!.children[0]!.id, 'child');
  });

  it('promotes orphaned page (parent is deleted) to root', () => {
    const pages = [
      makePage({ id: 'deleted-parent', deletedAt: new Date(), position: '1' }),
      makePage({ id: 'orphan', parentPageId: 'deleted-parent', position: '1' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.id, 'orphan');
  });

  it('sorts siblings by position ascending', () => {
    const pages = [
      makePage({ id: 'c', position: '3' }),
      makePage({ id: 'a', position: '1' }),
      makePage({ id: 'b', position: '2' }),
    ];
    const tree = buildPageTree(pages);
    assert.deepEqual(
      tree.map((n) => n.id),
      ['a', 'b', 'c'],
    );
  });

  it('pages with null position sort after positioned pages', () => {
    const pages = [
      makePage({ id: 'no-pos', position: null }),
      makePage({ id: 'pos', position: '1' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree[0]!.id, 'pos');
    assert.equal(tree[1]!.id, 'no-pos');
  });

  it('builds multi-level tree', () => {
    const pages = [
      makePage({ id: 'root', position: '1' }),
      makePage({ id: 'child', parentPageId: 'root', position: '1' }),
      makePage({ id: 'grandchild', parentPageId: 'child', position: '1' }),
    ];
    const tree = buildPageTree(pages);
    assert.equal(tree[0]!.children[0]!.children[0]!.id, 'grandchild');
  });
});
