const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const finder = require('./station-board-finder.js');
const profileHover = require('./profile-promo-hover.js');

test('홍보 기본 목록은 공개 JSON 파일이 아니라 관리자 전용 RTDB에서 읽는다', () => {
  const functionsSource = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  assert.doesNotMatch(functionsSource, /require\(['"]\.\/streamer-promo-seed\.json['"]\)/);
  assert.match(functionsSource, /adminCenter\/streamerPromoSeed/);
  assert.match(functionsSource, /function getKnownPromoEntries\(seedValue, verifiedValue, candidateValue\)/);
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'functions', 'streamer-promo-seed.json')));
});

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
  assert.match(finderSource, /child\.hidden = item\.state === 'found' \|\| item\.state === 'excluded'/);
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
  assert.match(workerSource, /setStreamerPromoExclusion/);
  assert.match(finderSource, /pageUrl:\s*location\.href/);
  assert.match(finderSource, /data-add-promo-candidate/);
  assert.match(finderSource, /item\.currentRoute && hasWriteUrl && panelNickname/);
  assert.match(adminSource, /addStreamerPromoCandidateFn\(/);
  assert.match(functionSource, /adminCenter\/streamerPromoCandidates/);
  assert.match(functionSource, /addStreamerPromoCandidate,/);
  assert.match(functionSource, /setStreamerPromoExclusion,/);
  assert.match(finderSource, /홍보 후보 제외 목록에 등록된 스트리머입니다/);
});

test('미확인 프로필 단축키 진단을 SOOP 페이지에서 서비스 워커 로그로 전달한다', () => {
  const workerSource = fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8');
  const profileSource = fs.readFileSync(path.join(__dirname, 'profile-promo-hover.js'), 'utf8');
  assert.match(workerSource, /message\.type === 'promoShortcutDiagnostic'/);
  assert.match(workerSource, /\['sooplive\.com', 'www\.sooplive\.com'\]\.includes\(sourceUrl\.hostname\)/);
  assert.match(workerSource, /\[SOOP 홍보 단축키 진단\]/);
  assert.match(profileSource, /type: 'promoShortcutDiagnostic'/);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.9.23');
  assert.equal(manifest.commands['find-unconfirmed-profile'].suggested_key.default, 'Alt+Shift+U');
  assert.match(workerSource, /chrome\.commands\.onCommand\.addListener/);
  assert.match(workerSource, /findUnconfirmedPromoProfile/);
  assert.match(workerSource, /openUnconfirmedStationInNewTab/);
  assert.match(profileSource, /browser-command-received/);
  assert.match(profileSource, /DIAGNOSTIC_VERSION = '0\.9\.23'/);
  assert.match(profileSource, /shortcut-station-open-requested/);
  assert.match(profileSource, /type: 'openUnconfirmedStationInNewTab'/);
});

test('댓글 작성자 아바타 버튼에서 SOOP 아이디를 안전하게 읽는다', () => {
  assert.equal(profileHover.stationIdFromProfileButton({
    getAttribute: (name) => ({ 'aria-label': '', title: '', 'data-user-id': '', 'data-station-id': '' }[name] || ''),
    querySelector: () => ({ getAttribute: (name) => name === 'alt' ? 'gofl2237' : '' }),
    innerText: '', textContent: '',
  }), 'gofl2237');
  assert.equal(profileHover.stationIdFromProfileButton({
    getAttribute: (name) => ({ 'aria-label': '답글', title: '', 'data-user-id': '', 'data-station-id': '' }[name] || ''),
    querySelector: () => ({ getAttribute: (name) => name === 'alt' ? 'icoChevronDown' : '' }),
    innerText: '답글', textContent: '답글',
  }), '');
  const source = fs.readFileSync(path.join(__dirname, 'profile-promo-hover.js'), 'utf8');
  assert.match(source, /querySelectorAll\('a\[href\] img, button img'\)/);
  assert.match(source, /canToggleExclusion: !!anchor/);
});

test('게시글 완료 확인은 본문 링크 URL을 포함하고 내용이 안정적으로 유지된 뒤 처리한다', () => {
  const writerSource = fs.readFileSync(path.join(__dirname, 'soop-writer.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8');
  assert.match(writerSource, /querySelectorAll\('a\[href\]'\)/);
  assert.match(writerSource, /visibleText \+ '\\n' \+ visibleLinks/);
  assert.match(writerSource, /content-confirmation-pending/);
  assert.match(workerSource, /CONTENT_CONFIRMATION_STABILITY_MS = 1200/);
  assert.match(workerSource, /pending\.contentMatchArticleId = match\[2\]/);
  assert.match(workerSource, /now - matchedSince >= CONTENT_CONFIRMATION_STABILITY_MS/);
  assert.match(writerSource, /if \(reason !== 'post-content-not-confirmed'\) contentMismatchSince = 0/);
  assert.doesNotMatch(writerSource, /console\.warn\('\[SOOP 홍보 보조\] 게시글 상세 화면은 찾았지만/);
  assert.match(writerSource, /post-content-mismatch-persisted/);
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

test('패널은 포인터 근처에 배치하되 화면 가장자리에서 뷰포트 안으로 뒤집고 고정한다', () => {
  assert.deepEqual(finder.positionNearPointer(100, 100, 300, 200, 1000, 800, 16), { left: 116, top: 116 });
  assert.deepEqual(finder.positionNearPointer(900, 700, 300, 200, 1000, 800, 16), { left: 584, top: 484 });
  const clamped = finder.positionNearPointer(2, 2, 300, 200, 1000, 800, 16);
  assert.ok(clamped.left >= 8 && clamped.top >= 8);
});

test('숫자키 1–9와 0을 패널의 1–10번째 후보 순서로 매핑한다', () => {
  assert.equal(finder.shortcutIndexFromKey('Digit1'), 0);
  assert.equal(finder.shortcutIndexFromKey('Digit9'), 8);
  assert.equal(finder.shortcutIndexFromKey('Digit0'), 9);
  assert.equal(finder.shortcutIndexFromKey('Numpad1'), 0);
  assert.equal(finder.shortcutIndexFromKey('Numpad0'), 9);
  assert.equal(finder.shortcutIndexFromKey('Key1'), -1);
  assert.equal(finder.shortcutIndexFromKey('Enter'), -1);
});

test('숫자키 이동 기록이 있는 현재 게시판에서만 스페이스 추가를 허용한다', () => {
  const source = fs.readFileSync(path.join(__dirname, 'station-board-finder.js'), 'utf8');
  assert.match(source, /keyboardBoardStorageKey/);
  assert.match(source, /viaKeyboard:\s*true/);
  assert.match(source, /event\.code === 'Space' \|\| event\.key === ' '/);
  assert.match(source, /isTypingTarget\(event\.target\)/);
  assert.match(source, /String\(marker\.boardId \|\| ''\)\.toLowerCase\(\) !== current\.boardId\.toLowerCase\(\)/);
  assert.match(source, /activeShortcutEntries = orderedItems/);
});

test('프로필 이미지 로드 후 상태 아이콘을 표시하고 제외·해제하며 호버 UI를 만들지 않는다', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const worker = fs.readFileSync(path.join(__dirname, 'service-worker.js'), 'utf8');
  const hoverSource = fs.readFileSync(path.join(__dirname, 'profile-promo-hover.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, 'admin-bridge.js'), 'utf8');
  const adminPage = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const functions = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  const hoverScript = manifest.content_scripts.find((entry) => entry.js.includes('profile-promo-hover.js'));
  assert.ok(hoverScript.matches.includes('https://www.sooplive.com/*'));
  assert.equal(profileHover.stationIdFromProfileHref('/station/dommiii', 'https://www.sooplive.com/search?keyword=virtual'), 'dommiii');
  assert.equal(profileHover.stationIdFromProfileHref('https://example.com/station/dommiii'), '');
  assert.equal(profileHover.plausibleNickname('  도미-의 방송국 바로가기  '), '도미-');
  assert.match(hoverSource, /img\.addEventListener\('load'/);
  assert.match(hoverSource, /querySelectorAll\('a\[href\] img, button img'\)/);
  assert.match(hoverSource, /홍보 리스트 등록됨/);
  assert.match(hoverSource, /registered: \['✅'/);
  assert.match(hoverSource, /excluded: \['🚫'/);
  assert.match(hoverSource, /unregistered: \['？'/);
  assert.match(hoverSource, /lookupContext:\s*'profile-hover'/);
  assert.match(hoverSource, /후보에서 제외/);
  assert.match(hoverSource, /제외된 리스트/);
  assert.match(hoverSource, /클릭하면 제외를 해제합니다/);
  assert.doesNotMatch(hoverSource, /pointerover|pointerout|pointermove|mouseenter|mouseleave|soop-promo-profile-hover/);
  assert.match(worker, /isProfileHoverLookup = message\.lookupContext === 'profile-hover'/);
  assert.match(worker, /isProfileHoverLookup \|\|/);
  assert.match(worker, /type: 'setStreamerPromoExclusion'/);
  assert.match(bridge, /__soopPromoExclusionRequest/);
  assert.match(bridge, /__soopPromoExclusionResult/);
  assert.match(adminPage, /setStreamerPromoExclusionFn/);
  assert.match(adminPage, /excludedStreamers/);
  assert.match(functions, /adminCenter\/streamerPromoExcluded/);
  assert.match(hoverSource, /event\.preventDefault\(\)/);
  assert.match(hoverSource, /event\.stopPropagation\(\)/);
});

test('확장 단축키는 미확인 프로필을 찾아 방송국을 새 탭으로 연다', () => {
  const hoverSource = fs.readFileSync(path.join(__dirname, 'profile-promo-hover.js'), 'utf8');
  assert.equal(profileHover.isUnconfirmedStatusIcon({ dataset: { soopPromoProfileStatusIcon: 'true' }, textContent: '？' }), true);
  assert.equal(profileHover.isUnconfirmedStatusIcon({ dataset: { soopPromoProfileStatusIcon: 'true' }, textContent: ' ? ' }), false);
  assert.equal(profileHover.isUnconfirmedStatusIcon({ dataset: {}, textContent: '？' }), false);
  assert.equal(profileHover.isFindUnconfirmedShortcut({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, code: 'Space' }), true);
  assert.equal(profileHover.isFindUnconfirmedShortcut({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: 'Space', getModifierState: (key) => key === 'Control' || key === 'Shift' }), true);
  assert.equal(profileHover.isFindUnconfirmedShortcut({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, code: 'Space' }), false);
  assert.equal(profileHover.isFindUnconfirmedShortcut({ ctrlKey: true, shiftKey: true, altKey: true, metaKey: false, code: 'Space' }), false);
  assert.match(hoverSource, /listener-ready/);
  assert.match(hoverSource, /modified-space-keydown/);
  assert.match(hoverSource, /shortcut-accepted/);
  assert.match(hoverSource, /shortcut-candidate-found/);
  assert.match(hoverSource, /shortcut-no-candidate/);
  assert.match(hoverSource, /modifierPressed\(event, 'ctrlKey', 'Control'\)/);
  assert.match(hoverSource, /modifierPressed\(event, 'shiftKey', 'Shift'\)/);
  assert.match(hoverSource, /!alt && !meta && space/);
  assert.match(hoverSource, /record\.started && record\.img\.isConnected && record\.button\.isConnected && isUnconfirmedStatusIcon\(record\.button\)/);
  assert.match(hoverSource, /type: 'openUnconfirmedStationInNewTab'/);
  assert.match(hoverSource, /현재 페이지에 미확인\(？\) 스트리머가 없습니다/);
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
