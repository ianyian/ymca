import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAdminRole,
  APP_ROLE_ADMIN,
  APP_ROLE_USER,
  APP_ROLE_IDS,
} from '../../../src/domain/app-roles.ts';

describe('isAdminRole', () => {
  it('is true only for the admin role key', () => {
    assert.equal(isAdminRole(APP_ROLE_ADMIN), true);
  });

  it('is false for normal users and unknown/blank roles', () => {
    assert.equal(isAdminRole(APP_ROLE_USER), false);
    assert.equal(isAdminRole('viewer'), false);
    assert.equal(isAdminRole(null), false);
    assert.equal(isAdminRole(undefined), false);
    assert.equal(isAdminRole(''), false);
  });
});

describe('seeded role ids', () => {
  it('match the stable ids used by the migration', () => {
    assert.equal(APP_ROLE_IDS.admin, 1);
    assert.equal(APP_ROLE_IDS.user, 2);
  });
});
