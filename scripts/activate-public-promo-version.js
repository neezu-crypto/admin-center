#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'soop-stock-market';
const VERSION_PATH = '/adminCenter/publicPromoPage/currentVersion';

function firebase(args, input) {
  return execFileSync('firebase', args, {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

const latest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public-promo-latest.json'), 'utf8'));
if (!/^[a-f0-9]{32}$/.test(latest.version || '')) throw new Error('public-promo-latest.json의 버전이 올바르지 않습니다.');
const updateUrl = String(process.argv[2] || '').trim();
if (!/^https:\/\/www\.sooplive\.com\/station\/skftodwocks2\/(?:board|post)\/[A-Za-z0-9_-]+\/?$/.test(updateUrl)) {
  throw new Error('관리자 방송국 게시판 또는 새 버전 게시글 주소를 인수로 지정하세요.');
}

const record = { version: latest.version, postUrl: updateUrl, activatedAt: Date.now() };
firebase(['database:set', VERSION_PATH, '--project', PROJECT, '--data', JSON.stringify(record), '--force']);
const saved = JSON.parse(firebase(['database:get', VERSION_PATH, '--project', PROJECT]));
if (!saved || saved.version !== latest.version || saved.postUrl !== updateUrl) throw new Error('서버 버전 확인에 실패했습니다.');
console.log(`활성 버전 설정 완료: ${latest.version}`);
console.log(`새 버전 안내 링크: ${updateUrl}`);
