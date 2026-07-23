import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordAnalyticsForUser } from '../../../src/domain/user-analytics.ts';

describe('shouldRecordAnalyticsForUser', () => {
  it('does not record analytics for a brand-new user with no workspace or page activity', () => {
    assert.equal(shouldRecordAnalyticsForUser(false, false), false);
  });

  it('records analytics once the user has workspace or page activity', () => {
    assert.equal(shouldRecordAnalyticsForUser(true, false), true);
  });

  it('still allows explicit demo-seeded analytics for an existing user', () => {
    assert.equal(shouldRecordAnalyticsForUser(false, true), true);
  });
});
