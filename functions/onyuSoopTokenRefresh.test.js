'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOOP_TOKEN_ENDPOINT,
  isOnyuSoopRefreshEligible,
  classifySoopRefreshFailure,
  refreshSoopTokens,
} = require('./onyuSoopTokenRefresh');

test('refresh is eligible only for an approved, unexpired integration matching the verified SOOP ID', () => {
  const valid = {
    status: 'active',
    sdkApproved: true,
    soopConsentAt: 100,
    expiresAt: 10_000,
    soopId: 'streamer-id',
  };
  assert.equal(isOnyuSoopRefreshEligible(valid, { verifiedSoopId: 'streamer-id', now: 1_000 }), true);
  assert.equal(isOnyuSoopRefreshEligible({ ...valid, status: 'preparing' }, { verifiedSoopId: 'streamer-id', now: 1_000 }), false);
  assert.equal(isOnyuSoopRefreshEligible({ ...valid, sdkApproved: false }, { verifiedSoopId: 'streamer-id', now: 1_000 }), false);
  assert.equal(isOnyuSoopRefreshEligible(valid, { verifiedSoopId: 'other-id', now: 1_000 }), false);
  assert.equal(isOnyuSoopRefreshEligible(valid, { verifiedSoopId: 'streamer-id', now: 10_000 }), false);
});

test('refresh request uses SOOP token endpoint and form-encoded refresh grant', async () => {
  let request;
  const result = await refreshSoopTokens({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'old-refresh-token',
    redirectUri: 'https://example.test/callback',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }) };
    },
  });

  assert.equal(request.url, SOOP_TOKEN_ENDPOINT);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request.options.body)), {
    grant_type: 'refresh_token',
    client_id: 'client-id',
    client_secret: 'client-secret',
    refresh_token: 'old-refresh-token',
    redirect_uri: 'https://example.test/callback',
  });
  assert.deepEqual(result, { ok: true, accessToken: 'new-access', refreshToken: 'new-refresh', expiresInSeconds: 3600 });
});

test('only configured SOOP error codes are treated as confirmed revocation', async () => {
  const revoked = await refreshSoopTokens({
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
    confirmedRevocationCodes: ['CHANNEL_AUTH_REVOKED'],
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error_code: 'CHANNEL_AUTH_REVOKED' }) }),
  });
  assert.equal(revoked.failureClass, 'revoked');
  assert.equal(revoked.errorCode, 'CHANNEL_AUTH_REVOKED');

  const unknown = await refreshSoopTokens({
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
    confirmedRevocationCodes: [],
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'not_documented_by_soop' }) }),
  });
  assert.equal(unknown.failureClass, 'unclassified');
  assert.equal(unknown.errorCode, 'NOT_DOCUMENTED_BY_SOOP');
});

test('temporary server errors are retryable and are not interpreted as revocation', () => {
  assert.equal(classifySoopRefreshFailure({ httpStatus: 503, errorCode: 'TEMPORARY' }), 'retryable');
  assert.equal(classifySoopRefreshFailure({ httpStatus: 429, errorCode: 'RATE_LIMITED' }), 'retryable');
  assert.equal(classifySoopRefreshFailure({ httpStatus: 401, errorCode: 'UNCONFIRMED' }), 'unclassified');
});

test('malformed successful response fails closed without returning token fields', async () => {
  await assert.rejects(() => refreshSoopTokens({
    clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'only-access', expires_in: 3600 }) }),
  }), { code: 'SOOP_REFRESH_RESPONSE_INVALID' });
});
