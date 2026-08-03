## 커밋·푸시

- 커밋을 완료하면(사용자가 요청했거나, 이미 커밋해도 되는 상황이면) 별도로 push 여부를 다시 묻지 않고 바로 `git push`까지 진행한다(2026-08-03, 사용자가 모든 프로젝트에 이 지침을 명시적으로 요청함). 커밋 자체를 언제 할지는 별개 — 사용자가 명시적으로 요청했을 때만 커밋한다는 기존 원칙은 그대로다.

## 구현 후 검증 필수

- 코드를 구현한 뒤 배포·커밋으로 넘어가기 전에 반드시 검증 단계를 거친다. 필드명·파라미터명·상태값을 "이렇게 생겼겠지"라고 추측하지 말고, 실제로 그 데이터를 쓰는(write) 쪽 소스 코드(자매 프로젝트 StreamBet-Market/soop-stock-market/interior-3d-viewer 포함)를 다시 읽어 대조한다.
- 실제로 검증 없이 넘어갔다면 조용히 묻혔을 사례들: 구매 현황 집계에서 `uid` 필드가 실제로는 `requesterUid`였던 걸 가정만 하고 넘어가 5/10개 항목이 누락될 뻔했던 일, 감사 로그 자동 기록 대상 액션 3개가 누락됐던 일, 배너/고정노출/중계방 신청이 최근 리팩터로 이미 신청 즉시 자동 승인되도록 바뀌어 있어 "승인 대기" 큐 UI를 만들어도 절대 나타나지 않는다는 걸 뒤늦게 발견한 일. 전부 실제 소스를 재확인하는 검증 단계에서만 잡을 수 있었다.
- 구체적으로 확인할 것: 문법 검사(`node -c` 등), 새 HTML id/함수명이 실제로 정의·호출 양쪽에 다 있는지 교차 확인, RTDB 규칙 변경은 `--dry-run`으로 먼저 확인, 그리고 무엇보다 새로 읽거나 다루는 RTDB 노드의 필드명은 그 노드를 쓰는 실제 코드를 찾아 대조.

## Firebase Functions 배포 주의사항

- 이 Firebase 프로젝트(soop-stock-market)는 StreamBet-Market·soop-stock-market·interior-3d-viewer와 같이 쓴다. admin-center의 `functions/`는 `firebase.json`에서 `codebase: "admincenter"`로 격리돼 있어 다른 저장소 함수와 이름이 겹칠 걱정은 없지만, 배포 시에는 습관적으로 `firebase deploy --only functions:admincenter:<함수명>,...`처럼 codebase와 함수명을 지정한다.

## RTDB 규칙 동기화

- `database.rules.json`의 원본은 StreamBet-Market이다. admin-center는 이 파일을 별도로 갖지 않고, RTDB 접근은 전부 Cloud Functions(Admin SDK, 규칙 무관)를 통해서만 한다 — 단, 13/14/15/18번처럼 admin-center 클라이언트가 직접 `onValue`로 구독하는 노드가 생기면, 그 노드의 `.read` 조건은 StreamBet-Market/interior-3d-viewer/soop-stock-market 3곳의 `database.rules.json`에 동일하게 반영돼 있어야 한다(동기화 확인은 `diff`로).
