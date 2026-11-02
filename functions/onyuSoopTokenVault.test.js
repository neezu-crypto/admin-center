'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ONYU_SOOP_REFRESH_SECRET_PREFIX,
  onyuRefreshSecretId,
  onyuRefreshSecretName,
  accessTokenExpiresAt,
  storeOnyuRefreshToken,
  readOnyuRefreshToken,
  deleteOnyuRefreshTokenSecret,
} = require('./onyuSoopTokenVault');
const { DONATION_CONSENT_TTL_MS } = require('./onyuDonationRetention');

test('refresh secret identifiers are deterministic and do not reveal the Firebase UID', () => {
  const id = onyuRefreshSecretId('firebase-user-123', 1_800_000_000_000);
  assert.match(id, new RegExp(`^${ONYU_SOOP_REFRESH_SECRET_PREFIX}[a-f0-9]{64}$`));
  assert.equal(id, onyuRefreshSecretId('firebase-user-123', 1_800_000_000_000));
  assert.notEqual(id, onyuRefreshSecretId('firebase-user-123', 1_800_000_000_001));
  assert.equal(id.includes('firebase-user-123'), false);
  assert.equal(onyuRefreshSecretName('soop-stock-market', id), `projects/soop-stock-market/secrets/${id}`);
});

test('Access Token expiry is derived from SOOP expires_in seconds', () => {
  assert.equal(accessTokenExpiresAt(3600, 1000), 3_601_000);
  for (const invalid of [0, -1, 1.5, 'not-a-number']) {
    assert.throws(() => accessTokenExpiresAt(invalid, 1000), TypeError);
  }
});

test('Refresh Token is written to a single-region expiring secret and old versions are destroyed', async () => {
  const calls = [];
  const oldName = 'projects/soop-stock-market/secrets/old/versions/1';
  const newName = 'projects/soop-stock-market/secrets/new/versions/2';
  const client = {
    async createSecret(request) { calls.push(['createSecret', request]); },
    async addSecretVersion(request) { calls.push(['addSecretVersion', request]); return [{ name: newName }]; },
    async listSecretVersions(request) {
      calls.push(['listSecretVersions', request]);
      return [[{ name: oldName }, { name: newName }]];
    },
    async destroySecretVersion(request) { calls.push(['destroySecretVersion', request]); },
  };
  const consentAt = 1_800_000_000_000;
  const now = consentAt + 1000;
  const preparationExpiresAt = consentAt + 12 * 60 * 60 * 1000;
  const stored = await storeOnyuRefreshToken({
    client,
    projectId: 'soop-stock-market',
    uid: 'firebase-user-123',
    soopConsentAt: consentAt,
    preparationExpiresAt,
    refreshToken: 'refresh-token-test-value',
    now,
  });

  assert.equal(stored.secretId, onyuRefreshSecretId('firebase-user-123', consentAt));
  assert.equal(stored.secretVersion, newName);
  assert.equal(stored.expiresAt, preparationExpiresAt);
  assert.equal(stored.expiresAt, Math.min(consentAt + DONATION_CONSENT_TTL_MS, preparationExpiresAt));

  const createRequest = calls.find(([name]) => name === 'createSecret')[1];
  assert.deepEqual(createRequest.secret.replication, { userManaged: { replicas: [{ location: 'us-central1' }] } });
  assert.deepEqual(createRequest.secret.expireTime, {
    seconds: Math.floor(preparationExpiresAt / 1000),
    nanos: (preparationExpiresAt % 1000) * 1_000_000,
  });
  const addRequest = calls.find(([name]) => name === 'addSecretVersion')[1];
  assert.equal(addRequest.payload.data.toString('utf8'), 'refresh-token-test-value');
  assert.deepEqual(calls.find(([name]) => name === 'destroySecretVersion')[1], { name: oldName });
  assert.equal(JSON.stringify(stored).includes('refresh-token-test-value'), false);
});

test('existing expiring secrets receive an updated expiry before a new version is added', async () => {
  const calls = [];
  const client = {
    async createSecret() { const error = new Error('already exists'); error.code = 6; throw error; },
    async updateSecret(request) { calls.push(['updateSecret', request]); },
    async addSecretVersion() { return [{ name: 'projects/p/secrets/s/versions/2' }]; },
    async listSecretVersions() { return [[]]; },
  };
  const consentAt = 1_800_000_000_000;
  const expiresAt = consentAt + 60 * 60 * 1000;
  await storeOnyuRefreshToken({
    client,
    projectId: 'soop-stock-market',
    uid: 'firebase-user-123',
    soopConsentAt: consentAt,
    preparationExpiresAt: expiresAt,
    refreshToken: 'rotated-token',
    now: consentAt + 1000,
  });
  assert.equal(calls[0][0], 'updateSecret');
  assert.deepEqual(calls[0][1].updateMask, { paths: ['expire_time'] });
  assert.equal(calls[0][1].secret.expireTime.seconds, Math.floor(expiresAt / 1000));
});

test('Refresh Token reads only the requested secret version and deletion tolerates an already-missing secret', async () => {
  const id = onyuRefreshSecretId('firebase-user-123', 1_800_000_000_000);
  const calls = [];
  const client = {
    async accessSecretVersion(request) {
      calls.push(['accessSecretVersion', request]);
      return [{ payload: { data: Buffer.from('secret-value') } }];
    },
    async deleteSecret(request) { calls.push(['deleteSecret', request]); },
  };
  assert.equal(await readOnyuRefreshToken({ client, projectId: 'soop-stock-market', secretId: id }), 'secret-value');
  assert.equal(calls[0][1].name, `projects/soop-stock-market/secrets/${id}/versions/latest`);
  assert.equal(await deleteOnyuRefreshTokenSecret({ client, projectId: 'soop-stock-market', secretId: id }), true);

  const missingClient = { async deleteSecret() { const error = new Error('not found'); error.code = 5; throw error; } };
  assert.equal(await deleteOnyuRefreshTokenSecret({ client: missingClient, projectId: 'soop-stock-market', secretId: id }), false);
});
