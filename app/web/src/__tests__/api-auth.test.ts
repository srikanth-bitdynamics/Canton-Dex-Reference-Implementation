import { afterEach, describe, expect, it } from 'vitest';

import {
  apiAuthHeaders,
  clearApiSessionCredentials,
  getApiSessionCredentials,
  setApiSessionCredentials,
} from '@/services/api-auth';

afterEach(() => clearApiSessionCredentials());

describe('operator API session credentials', () => {
  it('adds only the caller token to reads', () => {
    setApiSessionCredentials({
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
      callerToken: 'caller.jwt',
    });
    expect(apiAuthHeaders('/v1/pools', 'GET')).toEqual({
      'X-Caller-Token': 'caller.jwt',
    });
  });

  it('uses the operator token and caller token for trader writes', () => {
    setApiSessionCredentials({
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
      callerToken: 'caller.jwt',
    });
    expect(apiAuthHeaders('/v1/pools/swap', 'POST')).toEqual({
      Authorization: 'Bearer operator-secret',
      'X-Caller-Token': 'caller.jwt',
    });
  });

  it('uses the separate admin token for admin writes', () => {
    setApiSessionCredentials({
      operatorToken: 'operator-secret',
      adminToken: 'admin-secret',
      callerToken: '',
    });
    expect(apiAuthHeaders('/v1/admin/pools', 'POST')).toEqual({
      Authorization: 'Bearer admin-secret',
    });
  });

  it('clears whitespace-only values instead of storing them', () => {
    setApiSessionCredentials({
      operatorToken: '  ',
      adminToken: '',
      callerToken: '',
    });
    expect(getApiSessionCredentials()).toEqual({
      operatorToken: '',
      adminToken: '',
      callerToken: '',
    });
  });
});
