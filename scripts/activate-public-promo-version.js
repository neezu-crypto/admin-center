#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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

const linkMapPath = path.join(os.tmpdir(), `admin-center-public-promo-link-map-${latest.version}.json`);
const directoryPath = path.join(os.tmpdir(), `admin-center-public-promo-directory-${latest.version}.json`);
if (!fs.existsSync(linkMapPath)) throw new Error('이 버전의 비공개 링크 매핑이 없습니다. 같은 컴퓨터에서 페이지 생성 명령부터 실행하세요.');
if (!fs.existsSync(directoryPath)) throw new Error('이 버전의 서버 목록 파일이 없습니다. 페이지 생성 명령부터 다시 실행하세요.');
const linkMap = JSON.parse(fs.readFileSync(linkMapPath, 'utf8'));
if (!linkMap || typeof linkMap !== 'object' || Object.keys(linkMap).some((key) => !/^[a-f0-9]{64}$/.test(key)) || Object.values(linkMap).some((url) => typeof url !== 'string' || !/^https:\/\//.test(url))) {
  throw new Error('비공개 링크 매핑 파일이 올바르지 않습니다.');
}
const directory = JSON.parse(fs.readFileSync(directoryPath, 'utf8'));
if (!directory || !Number.isInteger(directory.total) || directory.total < 0 || !directory.pages || typeof directory.pages !== 'object') {
  throw new Error('서버 목록 파일이 올바르지 않습니다.');
}
const directoryEntries = Object.values(directory.pages).flatMap((page) => Array.isArray(page) ? page : []);
if (directoryEntries.length !== directory.total || directoryEntries.some((entry) =>
  !entry || typeof entry.key !== 'string' || typeof entry.nickname !== 'string' || typeof entry.soopId !== 'string' ||
  typeof entry.hasLink !== 'boolean')) {
  throw new Error('서버 목록 항목 검증에 실패했습니다.');
}

const mapPath = `/adminCenter/publicPromoPage/linkMaps/${latest.version}`;
firebase(['database:set', mapPath, linkMapPath, '--project', PROJECT, '--force']);
const savedMap = JSON.parse(firebase(['database:get', mapPath, '--project', PROJECT]));
if (!savedMap || Object.keys(savedMap).length !== Object.keys(linkMap).length) throw new Error('서버 링크 매핑 확인에 실패했습니다.');

const directoryDbPath = `/adminCenter/publicPromoPage/directories/${latest.version}`;
firebase(['database:set', directoryDbPath, directoryPath, '--project', PROJECT, '--force']);
const savedDirectory = JSON.parse(firebase(['database:get', directoryDbPath, '--project', PROJECT]));
const savedEntries = Object.values(savedDirectory && savedDirectory.pages || {}).flatMap((page) => Array.isArray(page) ? page : []);
if (!savedDirectory || Number(savedDirectory.total) !== directory.total || savedEntries.length !== directory.total) throw new Error('서버 목록 확인에 실패했습니다.');

const record = { version: latest.version, postUrl: updateUrl, activatedAt: Date.now() };
firebase(['database:set', VERSION_PATH, '--project', PROJECT, '--data', JSON.stringify(record), '--force']);
const saved = JSON.parse(firebase(['database:get', VERSION_PATH, '--project', PROJECT]));
if (!saved || saved.version !== latest.version || saved.postUrl !== updateUrl) throw new Error('서버 버전 확인에 실패했습니다.');
fs.unlinkSync(linkMapPath);
fs.unlinkSync(directoryPath);

const stillActive = JSON.parse(firebase(['database:get', VERSION_PATH, '--project', PROJECT]));
if (stillActive && stillActive.version === latest.version) {
  // Once the new version is active, old maps/directories are unreachable by the
  // server gate. Remove only prior version children to prevent RTDB growth.
  for (const collection of ['linkMaps', 'directories']) {
    const root = `/adminCenter/publicPromoPage/${collection}`;
    const existing = JSON.parse(firebase(['database:get', root, '--project', PROJECT]) || 'null') || {};
    for (const version of Object.keys(existing)) {
      if (version !== latest.version && /^[a-f0-9]{32}$/.test(version)) {
        firebase(['database:remove', `${root}/${version}`, '--project', PROJECT, '--force']);
      }
    }
  }
} else {
  console.warn('다른 버전이 활성화되어 이전 데이터 정리를 건너뜁니다.');
}
console.log(`활성 버전 설정 완료: ${latest.version}`);
console.log(`서버에 링크 ${Object.keys(linkMap).length}개와 목록 ${directory.total}개를 등록했습니다.`);
console.log('이전 버전 링크 매핑과 목록을 정리했습니다.');
console.log(`새 버전 안내 링크: ${updateUrl}`);
