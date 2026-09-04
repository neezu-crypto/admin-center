## 커밋·푸시

- 커밋을 완료하면(사용자가 요청했거나, 이미 커밋해도 되는 상황이면) 별도로 push 여부를 다시 묻지 않고 바로 `git push`까지 진행한다(2026-08-03, 사용자가 모든 프로젝트에 이 지침을 명시적으로 요청함). 커밋 자체를 언제 할지는 별개 — 사용자가 명시적으로 요청했을 때만 커밋한다는 기존 원칙은 그대로다.

## 구현 후 검증 필수

- 코드를 구현한 뒤 배포·커밋으로 넘어가기 전에 반드시 검증 단계를 거친다. 필드명·파라미터명·상태값을 "이렇게 생겼겠지"라고 추측하지 말고, 실제로 그 데이터를 쓰는(write) 쪽 소스 코드(자매 프로젝트 StreamBet-Market/soop-stock-market/interior-3d-viewer 포함)를 다시 읽어 대조한다.
- 실제로 검증 없이 넘어갔다면 조용히 묻혔을 사례들: 구매 현황 집계에서 `uid` 필드가 실제로는 `requesterUid`였던 걸 가정만 하고 넘어가 5/10개 항목이 누락될 뻔했던 일, 감사 로그 자동 기록 대상 액션 3개가 누락됐던 일, 배너/고정노출/중계방 신청이 최근 리팩터로 이미 신청 즉시 자동 승인되도록 바뀌어 있어 "승인 대기" 큐 UI를 만들어도 절대 나타나지 않는다는 걸 뒤늦게 발견한 일. 전부 실제 소스를 재확인하는 검증 단계에서만 잡을 수 있었다.
- 구체적으로 확인할 것: 문법 검사(`node -c` 등), 새 HTML id/함수명이 실제로 정의·호출 양쪽에 다 있는지 교차 확인, RTDB 규칙 변경은 `--dry-run`으로 먼저 확인, 그리고 무엇보다 새로 읽거나 다루는 RTDB 노드의 필드명은 그 노드를 쓰는 실제 코드를 찾아 대조.

## Firebase Functions 배포 주의사항

- 이 Firebase 프로젝트(soop-stock-market)는 StreamBet-Market·soop-stock-market·interior-3d-viewer·streamer-life-game·rocket-game·streamer-gallery와 같이 쓴다. admin-center의 `functions/`는 `firebase.json`에서 `codebase: "admincenter"`로 격리돼 있지만, **codebase는 실제 배포되는 Cloud Function 리소스 이름을 네임스페이스하지 않는다** — 프로젝트+리전 전체에서 함수 이름이 유일해야 한다(2026-09-04 실제 발생: streamer-gallery의 `whoAmI`가 rocket-game의 동명 함수를 실제로 덮어쓴 적 있음). 새 함수를 추가할 때는 배포 전 `firebase functions:list --project soop-stock-market`으로 겹치는 이름이 없는지 먼저 확인하고, 배포 시엔 `firebase deploy --only functions:admincenter:<함수명>,...`처럼 codebase와 함수명을 지정한다.

## RTDB 규칙 동기화

- `database.rules.json`의 원본은 StreamBet-Market이다. admin-center는 이 파일을 별도로 갖지 않고, RTDB 접근은 전부 Cloud Functions(Admin SDK, 규칙 무관)를 통해서만 한다 — 단, 13/14/15/18번처럼 admin-center 클라이언트가 직접 `onValue`로 구독하는 노드가 생기면, 그 노드의 `.read` 조건은 이 RTDB를 공유하는 6개 레포(StreamBet-Market·soop-stock-market·interior-3d-viewer·streamer-life-game·rocket-game·streamer-gallery)의 `database.rules.json`에 동일하게 반영돼 있어야 한다(동기화 확인은 `diff`로).

## 신규 게임 온보딩 체크리스트 (2026-09-04 추가 — 실제 누락 발견)

- 새 자매 사이트를 만들 때 이 저장소(admin-center)에서도 반드시 등록해야 하는 항목들이 있다.
  streamer-life-game·rocket-game·streamer-gallery 3곳 모두 이 등록이 빠진 채로 운영되고
  있었던 게 2026-09-04에 발견됨(functions/index.js의 `GAME_CATALOG` 배열 바로 위 주석에
  "새 게임이 생기면 여기에 한 줄만 추가하면 된다"고 이미 명시돼 있었는데도 누락됐었다):
  - **`GAME_CATALOG`**(functions/index.js): 이게 없으면 그 게임은 콘텐츠 동결(seriesConfig)
    토글·게시글 홍보 현황 관리를 못 씀.
  - **`PRESENCE_APPS`**(functions/index.js): 접속자 수 분석(시간당 최고 동접)에 포함시키려면
    등록 + 클라이언트가 `presence/{appId}/{uid}`에 `{ lastSeen: <ms> }` 형태로 직접 써야 함
    (streamer-life-game은 이 표준 경로/필드명을 안 따르는 자체 구현이라 여전히 비대상).
  - **게임별 정지(ban) 관리 UI**: 지금 admin-center UI는 배팅시장/주식시장 섹션만 하드코딩
    돼 있다. 다른 게임에서 개별 유저를 정지시키려면 그 게임 저장소에 자체
    `banAccount`/`unbanAccount` 함수를 만들고(`bannedAccounts/{uid}/games/<name>` 경로에
    쓰기), admin-center에도 그 게임 전용 UI 섹션을 추가하거나, 최소한 "전체 게임 정지"
    (`banAccountAllGames`)만으로 대응 가능하다는 걸 인지하고 있어야 한다.
  - **Discord 신고 알림(`makeQueueTrigger`)**: 새 게임에 신고/승인 대기 큐가 생기면 여기에
    한 줄 추가해야 관리자가 Discord로 즉시 알림을 받는다. 안 하면 신고가 들어와도 관리자가
    직접 그 게임 관리 패널을 열어봐야만 앎.
  - **통합 감사 로그(`listAuditLogOverview`)**: 지금은 `bettingMarket/auditLog`와
    `adminAuditLog` 두 개만 병합해서 보여준다. 새 게임의 `auditLog`도 여기 합치고 싶으면
    이 함수에 소스 하나를 추가해야 한다.
