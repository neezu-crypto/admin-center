const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DONATION_CONSENT_TTL_MS,
  integrationExpiresAt,
  isIntegrationExpired,
  isOutfitSessionExpired,
  removeExpiredRecordIfMatches,
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

test('scheduled task removes its expired record only if it has not been renewed', async () => {
  const records = { consent: { expiresAt: 100 }, session: { expiresAt: 100 } };
  const db = {
    ref(path) {
      const key = path.split('/').at(-1);
      return { async transaction(update) {
        const next = update(records[key]);
        if (next !== records[key]) records[key] = next;
        return { committed: true, snapshot: { val: () => records[key] ?? null } };
      } };
    },
  };

  assert.equal(await removeExpiredRecordIfMatches(db, 'integrations', 'consent', integrationExpiresAt, 100, 100), true);
  assert.equal(records.consent, null);
  assert.equal(await removeExpiredRecordIfMatches(db, 'sessions', 'session', record => Number(record.expiresAt), 100, 100), true);
  assert.equal(records.session, null);

  records.consent = { expiresAt: 200 };
  assert.equal(await removeExpiredRecordIfMatches(db, 'integrations', 'consent', integrationExpiresAt, 200, 199), false);
  assert.deepEqual(records.consent, { expiresAt: 200 });
  assert.equal(await removeExpiredRecordIfMatches(db, 'integrations', 'consent', integrationExpiresAt, 100, 200), false);
  assert.deepEqual(records.consent, { expiresAt: 200 });
});
