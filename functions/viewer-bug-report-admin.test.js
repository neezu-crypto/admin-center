'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyBugReportAction, buildBugReportPage } = require('./viewer-bug-report-admin');
test('삭제하면 본문과 사용자 식별자를 남기지 않고 삭제 표식만 보관한다', () => { assert.deepEqual(applyBugReportAction({ content: 'secret', senderUid: 'uid', status:'open' }, 'delete', 10), { status:'deleted', deletedAt:10 }); });
test('삭제된 제보는 되살릴 수 없다', () => { assert.equal(applyBugReportAction({ status:'deleted' }, 'reopen', 10), undefined); });
test('처리 후 재오픈은 본문을 보존한다', () => { const closed=applyBugReportAction({content:'body',status:'open'},'resolve',10); assert.equal(applyBugReportAction(closed,'reopen',20).content,'body'); });
test('동일한 접수 시각도 제보 ID로 안정적으로 정렬하고 다음 위치를 반환한다', () => {
  const records = { a: { createdAt: 100, content: 'a' }, c: { createdAt: 100, content: 'c' }, b: { createdAt: 100, content: 'b' } };
  const page = buildBugReportPage(records, 2);
  assert.deepEqual(page.items.map(item => item.id), ['c', 'b']);
  assert.deepEqual(page.nextCursor, { createdAt: 100, id: 'b' });
});
test('삭제 표식은 본문과 함께 목록에서 제외한다', () => {
  const page = buildBugReportPage({ a: { createdAt: 100, status: 'deleted', content: 'secret' }, b: { createdAt: 90, content: 'safe' } });
  assert.deepEqual(page.items.map(item => item.id), ['b']);
  assert.equal(page.nextCursor, null);
});
