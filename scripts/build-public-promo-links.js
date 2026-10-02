#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'soop-stock-market';
const TEMPLATE_PATH = path.join(ROOT, 'public-promo-links.template.html');
const OUTPUT_PATH = path.join(ROOT, 'public-promo-links.html');
const RELEASES_DIR = path.join(ROOT, 'releases');
const LATEST_PATH = path.join(ROOT, 'public-promo-latest.json');
const ADMIN_STATION_URL = 'https://www.sooplive.com/station/skftodwocks2/board/128562829';

function readDatabase(pathname) {
  const output = execFileSync('firebase', ['database:get', pathname, '--project', PROJECT], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
  if (!output) return null;
  return JSON.parse(output);
}

function normalizeSoopId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9]{2,20}$/.test(normalized) ? normalized : '';
}

function promoStorageKey(verificationId, soopId) {
  const normalizedId = normalizeSoopId(soopId);
  return normalizedId || ('verification_' + String(verificationId || '').replace(/[^A-Za-z0-9_-]/g, '_'));
}

function collectVerifiedStreamerEntries(value) {
  const data = value || {};
  const bySoopId = {};
  const entries = [];
  Object.keys(data).forEach((id) => {
    const row = data[id] || {};
    const soopId = normalizeSoopId(row.soopId);
    const entry = { id, nickname: String(row.nickname || '').trim(), soopId, verifiedAt: row.verifiedAt || 0 };
    if (!entry.nickname && !entry.soopId) return;
    if (soopId && bySoopId[soopId]) {
      if ((entry.verifiedAt || 0) <= (bySoopId[soopId].verifiedAt || 0)) return;
      const oldIndex = entries.indexOf(bySoopId[soopId]);
      if (oldIndex >= 0) entries.splice(oldIndex, 1);
    }
    if (soopId) bySoopId[soopId] = entry;
    entries.push(entry);
  });
  return entries;
}

function getKnownPromoEntries(seedValue, verifiedValue, candidateValue) {
  const entries = Object.keys(seedValue || {}).map((key) => Object.assign({}, seedValue[key] || {}, { isSeed: true }));
  const byKey = {};
  entries.forEach((entry) => { byKey[entry.key] = entry; });
  collectVerifiedStreamerEntries(verifiedValue).forEach((entry) => {
    const key = promoStorageKey(entry.id, entry.soopId);
    if (byKey[key]) {
      byKey[key].isVerified = true;
      if (!byKey[key].nickname && entry.nickname) byKey[key].nickname = entry.nickname;
      return;
    }
    byKey[key] = Object.assign({}, entry, { key, isVerified: true });
  });
  const candidates = candidateValue || {};
  Object.keys(candidates).forEach((soopId) => {
    const row = candidates[soopId] || {};
    const normalizedId = normalizeSoopId(row.soopId || soopId);
    if (!normalizedId || !String(row.nickname || '').trim()) return;
    const key = promoStorageKey('', normalizedId);
    if (byKey[key]) return;
    byKey[key] = { key, nickname: String(row.nickname).trim(), soopId: normalizedId, writeUrl: String(row.writeUrl || ''), isManualCandidate: true };
  });
  return Object.keys(byKey).map((key) => byKey[key]);
}

function main() {
  const [verified, links, excluded, candidates, seed] = [
    readDatabase('/streamerVerifications'),
    readDatabase('/adminCenter/streamerPromoLinks'),
    readDatabase('/adminCenter/streamerPromoExcluded'),
    readDatabase('/adminCenter/streamerPromoCandidates'),
    readDatabase('/adminCenter/streamerPromoSeed'),
  ];
  const excludedIds = excluded || {};
  const seen = new Set();
  const entries = getKnownPromoEntries(seed, verified, candidates)
    .filter((entry) => !(excludedIds[entry.key] === true || (entry.soopId && excludedIds[entry.soopId] === true)))
    .map((entry) => {
      const saved = (links || {})[entry.key] || {};
      return {
        key: String(entry.key || ''),
        nickname: String(entry.nickname || '').trim(),
        soopId: normalizeSoopId(entry.soopId),
        writeUrl: String(saved.writeUrl || entry.writeUrl || '').trim(),
      };
    })
    .filter((entry) => {
      if (!entry.key || seen.has(entry.key)) return false;
      seen.add(entry.key);
      return Boolean(entry.nickname || entry.soopId);
    })
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko-KR'));

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  const version = crypto.randomBytes(16).toString('hex');
  const safeJson = JSON.stringify(entries).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const html = template.replace('__PROMO_SNAPSHOT__', safeJson).replace('__SNAPSHOT_DATE__', date).replace('__VERSION_ID__', version);
  if (html.includes('__PROMO_SNAPSHOT__') || html.includes('__SNAPSHOT_DATE__') || html.includes('__VERSION_ID__')) throw new Error('HTML 템플릿 치환이 완료되지 않았습니다.');
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const releasePath = path.join(RELEASES_DIR, version + '.html');
  const pageUrl = `https://neezu-crypto.github.io/admin-center/releases/${version}.html`;
  const latest = { version, pageUrl, adminStationUrl: ADMIN_STATION_URL, updatedAt: new Date().toISOString() };
  // Keep the predictable historical path as a locked entry point. Only the
  // random release URL receives the active version ID.
  const lockedEntryPoint = html.replace("const APP_VERSION = '" + version + "';", "const APP_VERSION = 'legacy-entrypoint';");
  fs.writeFileSync(OUTPUT_PATH, lockedEntryPoint);
  fs.writeFileSync(releasePath, html);
  fs.writeFileSync(LATEST_PATH, JSON.stringify(latest, null, 2) + '\n');
  console.log(`공개 페이지 생성 완료: ${releasePath} (${entries.length}명, 기준일 ${date})`);
  console.log(`이번 버전 URL: ${pageUrl}`);
}

try { main(); }
catch (error) {
  console.error('공개 홍보 링크 페이지를 생성하지 못했습니다:', error.message);
  process.exitCode = 1;
}
