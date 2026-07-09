import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePositionBetween,
  appendPosition,
  rebalancePositions,
} from '../../../src/domain/ordering.ts';

describe('generatePositionBetween', () => {
  it('midpoint between null and null gives 1', () => {
    // before=null → 0, after=null → 0+2=2, mid=1
    assert.equal(generatePositionBetween(null, null), '1');
  });

  it('midpoint between 1 and 3 is 2', () => {
    assert.equal(generatePositionBetween('1', '3'), '2');
  });

  it('midpoint between 1 and 2 is 1.5', () => {
    assert.equal(generatePositionBetween('1', '2'), '1.5');
  });

  it('inserts before first item (before=null, after=1)', () => {
    const pos = parseFloat(generatePositionBetween(null, '1'));
    assert.ok(pos > 0 && pos < 1, `Expected position between 0 and 1, got ${pos}`);
  });

  it('inserts after last item (before=3, after=null)', () => {
    const pos = parseFloat(generatePositionBetween('3', null));
    assert.ok(pos > 3, `Expected position > 3, got ${pos}`);
  });

  it('throws when gap is too small', () => {
    assert.throws(
      () => generatePositionBetween('1', '1.0000000001'),
      /rebalance required/,
    );
  });
});

describe('appendPosition', () => {
  it('first item gets position 1 when list is empty', () => {
    assert.equal(appendPosition(null), '1');
  });

  it('appends after last item by adding 1', () => {
    assert.equal(appendPosition('5'), '6');
  });
});

describe('rebalancePositions', () => {
  it('empty list returns empty map', () => {
    assert.equal(rebalancePositions([]).size, 0);
  });

  it('assigns 1-based integer positions', () => {
    const result = rebalancePositions(['a', 'b', 'c']);
    assert.equal(result.get('a'), '1');
    assert.equal(result.get('b'), '2');
    assert.equal(result.get('c'), '3');
  });

  it('preserves order of input array', () => {
    const ids = ['x', 'y', 'z'];
    const result = rebalancePositions(ids);
    const entries = Array.from(result.entries());
    assert.deepEqual(
      entries.map(([id]) => id),
      ids,
    );
  });
});
