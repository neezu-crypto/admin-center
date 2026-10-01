const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const finder = require('./station-board-finder.js');

test('렌더러에는 링크·버튼 배열을 포함한 스캔 결과 객체를 전달한다', () => {
  const source = fs.readFileSync(path.join(__dirname, 'station-board-finder.js'), 'utf8');
  assert.match(source, /render\(result,\s*stationId,\s*result\)/);
  assert.doesNotMatch(source, /render\(result\.links,\s*stationId,\s*result\)/);
});

test('중복 확인은 관리자 센터 전체 홍보 목록을 조회하고 실패를 미등록으로 표시하지 않는다', () => {
  const finderSource = fs.readFileSync(path.join(__dirname, 'station-board-finder.js'), 'utf8');
  const bridgeSource = fs.readFileSync(path.join(__dirname, 'admin-bridge.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const functionSource = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  assert.match(finderSource, /이미 홍보 리스트에 등록된 닉네임입니다/);
  assert.match(finderSource, /child\.hidden = item\.state === 'found'/);
  assert.match(finderSource, /홍보 리스트 중복 확인을 할 수 없습니다/);
  assert.match(finderSource, /type:\s*'checkPromoListDuplicate'/);
  assert.match(workerSource, /type:\s*'lookupStreamerPromoDuplicate'/);
  assert.match(bridgeSource, /__soopPromoDuplicateLookupRequest/);
  assert.match(adminSource, /listStreamerPromoLinksFn\(\)/);
  assert.match(adminSource, /__soopPromoDuplicateLookupResult/);
  assert.match(finderSource, /홍보 리스트에 추가/);
  assert.match(finderSource, /type:\s*'addPromoCandidateFromConfirmedPage'/);
  assert.match(workerSource, /type:\s*'addStreamerPromoCandidate'/);
  assert.match(workerSource, /message\.pageUrl/);
  assert.match(workerSource, /pageMatchesWriteUrl/);
  assert.match(workerSource, /pageBoardMatch/);
  assert.match(finderSource, /pageUrl:\s*location\.href/);
  assert.match(finderSource, /data-add-promo-candidate/);
  assert.match(finderSource, /item\.currentRoute && hasWriteUrl && panelNickname/);
  assert.match(adminSource, /addStreamerPromoCandidateFn\(/);
  assert.match(functionSource, /adminCenter\/streamerPromoCandidates/);
  assert.match(functionSource, /addStreamerPromoCandidate,/);
});

test('추적 중인 방송국의 게시판 주소에서 게시판과 글쓰기 주소를 만든다', () => {
  assert.deepEqual(
    finder.extractBoardLink('/station/demo123/board/98765', 'demo123', 'https://www.sooplive.com/station/demo123'),
    {
      stationId: 'demo123',
      boardId: '98765',
      boardUrl: 'https://www.sooplive.com/station/demo123/board/98765',
      writeUrl: 'https://www.sooplive.com/station/demo123/post/write/98765',
    }
  );
});

test('다른 방송국·다른 도메인·글 상세 경로를 게시판으로 오인하지 않는다', () => {
  assert.equal(finder.extractBoardLink('/station/other/board/98765', 'demo123'), null);
  assert.equal(finder.extractBoardLink('https://example.com/station/demo123/board/98765', 'demo123'), null);
  assert.equal(finder.extractBoardLink('/station/demo123/post/98765', 'demo123'), null);
});

test('SOOP 버튼 선택 후 도달한 현재 게시판 URL에서 글쓰기 주소를 구성한다', () => {
  assert.deepEqual(
    finder.extractCurrentBoard('/station/dommiii/board/122232421', 'dommiii'),
    {
      stationId: 'dommiii',
      boardId: '122232421',
      boardUrl: 'https://www.sooplive.com/station/dommiii/board/122232421',
      writeUrl: 'https://www.sooplive.com/station/dommiii/post/write/122232421',
    }
  );
  assert.equal(finder.extractCurrentBoard('/station/other/board/122232421', 'dommiii'), null);
});

test('글쓰기 경로에서 방송국과 게시판 ID를 안전하게 추출한다', () => {
  assert.deepEqual(finder.extractWriteRoute('/station/dommiii/post/write/122232421'), {
    stationId: 'dommiii', boardId: '122232421',
  });
  assert.equal(finder.extractWriteRoute('/station/other/post/write/122232421/extra'), null);
});

test('방송국 닉네임을 추출하고 신뢰도 높은 후보부터 정렬한다', () => {
  assert.equal(finder.stationNicknameFromTitles('도미-의 방송국 | SOOP', ''), '도미-');
  assert.equal(finder.stationNicknameFromTitles('SOOP', '도미-의 방송국'), '도미-');
  const sorted = finder.sortCandidatesByConfidence([
    { title: '요청함', confidence: '보통' },
    { title: '게임 추천', confidence: '높음' },
    { title: '게임 게시판', confidence: '낮음' },
    { title: '뻐꾸기', confidence: '높음' },
  ]);
  assert.deepEqual(sorted.map((item) => item.title), ['게임 추천', '뻐꾸기', '요청함', '게임 게시판']);
});

test('뻐꾸기·추천·게임 추천은 우선 후보로 분류한다', () => {
  assert.equal(finder.classifyBoardTitle('🦉 뻐꾸기동지').kind, 'candidate');
  for (const title of ['🐦‍⬛뻐꾺', '🐤뻐꾹 요기 뻐꾹', '>뻐구기', '**🦉┃뻐꾹게시판']) {
    const result = finder.classifyBoardTitle(title);
    assert.equal(result.kind, 'candidate', title);
    assert.equal(result.confidence, '높음', title);
  }
  assert.equal(finder.classifyBoardTitle('게임 추천').confidence, '높음');
  assert.equal(finder.classifyBoardTitle('게임추천').confidence, '높음');
  for (const title of [
    '게임 추천 게시판',
    '🐟게임 추천🎮',
    '오늘의 🐟게임 추천🎮 모음',
    '게임🎮 추천 게시판',
  ]) {
    const result = finder.classifyBoardTitle(title);
    assert.equal(result.kind, 'candidate', title);
    assert.equal(result.confidence, '높음', title);
  }
  assert.match(finder.classifyBoardTitle('🐟게임 추천🎮').reason, /게임 추천/);
});

test('제안·요청은 후보로 표시하되 확인이 필요하다고 분류한다', () => {
  assert.equal(finder.classifyBoardTitle('콘텐츠 제안').confidence, '보통');
  assert.equal(finder.classifyBoardTitle('시청자 요청함').kind, 'candidate');
});

test('공지·VOD·스트리머 전용으로 보이는 게시판은 제외한다', () => {
  assert.equal(finder.classifyBoardTitle('콘텐츠 추천 공지').kind, 'exclude');
  assert.equal(finder.classifyBoardTitle('스트리머 전용 뻐꾸기').kind, 'exclude');
  assert.equal(finder.classifyBoardTitle('VOD').kind, 'exclude');
  assert.equal(finder.classifyBoardTitle('노래 추천').kind, 'exclude');
  assert.equal(finder.classifyBoardTitle('🎵노래┃추천 게시판').kind, 'exclude');
});

test('이름이 모호한 콘텐츠 게시판은 글쓰기 후보 대신 수동 확인으로 남긴다', () => {
  assert.equal(finder.classifyBoardTitle('컨텐츠 게시판').kind, 'review');
  assert.equal(finder.classifyBoardTitle('현재 게시판 (용도 확인 필요)').kind, 'review');
  assert.equal(finder.classifyBoardTitle('팬 게시판').kind, 'ignore');
});
