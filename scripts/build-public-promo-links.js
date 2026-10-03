#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
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

function retiredPageHtml() {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>새 업데이트가 있습니다</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6fa;color:#172033;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{max-width:480px;margin:20px;padding:28px;border:1px solid #e1e6ef;border-radius:18px;background:#fff;box-shadow:0 12px 36px #17203312}.card h1{font-size:22px;margin:0 0 10px}.card p{color:#647087;margin:0}.card a{display:inline-block;margin-top:20px;padding:10px 15px;border-radius:10px;background:#2878f0;color:#fff;text-decoration:none;font-weight:800}</style></head><body><main class="card"><h1>새 업데이트가 있습니다</h1><p>이 버전은 더 이상 사용할 수 없습니다. 관리자 방송국 게시판에서 최신 페이지를 열어 주세요.</p><a href="${ADMIN_STATION_URL}" target="_blank" rel="noopener noreferrer">새 업데이트 받기</a></main></body></html>`;
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
  const privateLinkMap = {};
  const entries = getKnownPromoEntries(seed, verified, candidates)
    .filter((entry) => !(excludedIds[entry.key] === true || (entry.soopId && excludedIds[entry.soopId] === true)))
    .map((entry) => {
      const saved = (links || {})[entry.key] || {};
      const rawUrl = String(saved.writeUrl || entry.writeUrl || '').trim();
      let token = '';
      try {
        const url = new URL(rawUrl);
        const host = url.hostname.toLowerCase();
        const allowed = url.protocol === 'https:' && !url.username && !url.password &&
          (host === 'sooplive.com' || host.endsWith('.sooplive.com') || host === 'sooplive.co.kr' || host.endsWith('.sooplive.co.kr') || host === 'cafe.naver.com');
        if (allowed) {
          token = crypto.randomBytes(16).toString('hex');
          privateLinkMap[token] = url.toString();
        }
      } catch (_) { /* Keep entries with no valid link visible but not openable. */ }
      return {
        key: String(entry.key || ''),
        nickname: String(entry.nickname || '').trim(),
        soopId: normalizeSoopId(entry.soopId),
        token,
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
  const privateMapPath = path.join(os.tmpdir(), `admin-center-public-promo-link-map-${version}.json`);
  fs.writeFileSync(privateMapPath, JSON.stringify(privateLinkMap));
  const retiredHtml = retiredPageHtml();
  const trackedReleaseFiles = execFileSync('git', ['ls-files', '--', 'releases/*.html'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split(/\r?\n/).filter(Boolean);
  for (const relativePath of trackedReleaseFiles) {
    const filename = path.basename(relativePath);
    if (filename !== `${version}.html`) fs.writeFileSync(path.join(RELEASES_DIR, filename), retiredHtml);
  }
  // Keep the predictable historical path as a locked entry point. Only the
  // random release URL receives the active version ID.
  fs.writeFileSync(OUTPUT_PATH, retiredHtml);
  fs.writeFileSync(releasePath, html);
  fs.writeFileSync(LATEST_PATH, JSON.stringify(latest, null, 2) + '\n');
  console.log(`공개 페이지 생성 완료: ${releasePath} (${entries.length}명, 기준일 ${date})`);
  console.log(`이번 버전 URL: ${pageUrl}`);
  console.log(`주소 매핑은 공개 저장소 밖에 임시 보관했습니다. 게시 후 활성화 스크립트에서 사용됩니다 (${Object.keys(privateLinkMap).length}개 링크).`);
}

try { main(); }
catch (error) {
  console.error('공개 홍보 링크 페이지를 생성하지 못했습니다:', error.message);
  process.exitCode = 1;
}
