const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DONATION_CONSENT_TTL_MS,
  integrationExpiresAt,
  isIntegrationExpired,
  isOutfitSessionExpired,
  removeExpiredRecords,
} = require('./onyuDonationRetention');

test('preparation consent expires 24 hours after consent', () => {
  const consentedAt = 1_800_000_000_000;
  assert.equal(integrationExpiresAt({ consentedAt }), consentedAt + DONATION_CONSENT_TTL_MS);
  assert.equal(isIntegrationExpired({ consentedAt }, consentedAt + DONATION_CONSENT_TTL_MS), true);
  assert.equal(isIntegrationExpired({ consentedAt }, consentedAt + DONATION_CONSENT_TTL_MS - 1), false);
});

test('explicit expiry is honored and active records remain until their expiry', () => {
  const record = { status: 'active', consentedAt: 100, expiresAt: 500 };
  assert.equal(integrationExpiresAt(record), 500);
  assert.equal(isIntegrationExpired(record, 499), false);
  assert.equal(isIntegrationExpired(record, 500), true);
});

test('outfit sessions expire at their own shorter expiry', () => {
  assert.equal(isOutfitSessionExpired({ expiresAt: 1000 }, 999), false);
  assert.equal(isOutfitSessionExpired({ expiresAt: 1000 }, 1000), true);
  assert.equal(isOutfitSessionExpired({}, 1000), false);
});

test('cleanup transaction preserves renewed records and removes only expired ones', async () => {
  const records = { old: { expiresAt: 10 }, renewed: { expiresAt: 100 } };
  const db = {
    ref(path) {
      const key = path.split('/').at(-1);
      return {
        async get() {
          return { val: () => records };
        },
        async transaction(update) {
          const next = update(records[key]);
          if (next !== records[key]) records[key] = next;
          return { committed: true, snapshot: { val: () => records[key] ?? null } };
        },
      };
    },
  };

  assert.equal(await removeExpiredRecords(db, 'integrations', (record, now) => record.expiresAt <= now, 50), 1);
  assert.equal(records.old, null);
  assert.deepEqual(records.renewed, { expiresAt: 100 });
});
