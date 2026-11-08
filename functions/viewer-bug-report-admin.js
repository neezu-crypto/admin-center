'use strict';
function applyBugReportAction(current, action, now) {
  if (!current || typeof current !== 'object' || current.status === 'deleted') return undefined;
  if (action === 'delete') return { status: 'deleted', deletedAt: now };
  if (action === 'resolve') return { ...current, status: 'resolved', resolvedAt: now };
  if (action === 'reopen') return { ...current, status: 'open', resolvedAt: null };
  return undefined;
}
function buildBugReportPage(records, pageSize = 100) {
  const sorted = Object.entries(records || {}).sort((a, b) =>
    (Number(b[1]?.createdAt) || 0) - (Number(a[1]?.createdAt) || 0) || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  const page = sorted.slice(0, pageSize);
  const items = page.filter(([, value]) => value && value.status !== 'deleted').map(([id, value]) => ({
    id, title: String(value.title || ''), content: String(value.content || ''),
    status: value.status === 'resolved' ? 'resolved' : 'open', createdAt: Number(value.createdAt) || 0,
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: sorted.length > pageSize && last && Number.isSafeInteger(last[1]?.createdAt)
    ? { createdAt: last[1].createdAt, id: last[0] } : null };
}
module.exports = { applyBugReportAction, buildBugReportPage };
