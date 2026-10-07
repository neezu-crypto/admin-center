(function () {
  const MONITOR_KEY = 'soopStreamerVerificationInboxMonitor';
  const ATTEMPT_KEY = 'soopStreamerVerificationInboxAttemptTimes';
  const REFRESH_MS = 10000;
  const RETRY_MS = 30000;
  const CODE_RE = /(?:^|[^A-Z0-9])([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6})(?=$|[^A-Z0-9])/i;
  let refreshTimer = null;
  let scanning = false;

  function trace(stage, details) {
    console.info('[SOOP 스트리머 인증 쪽지]', JSON.stringify({
      stage: stage,
      at: new Date().toISOString(),
      details: details || {},
    }));
  }

  function showNotice(message, isError) {
    let notice = document.getElementById('soop-streamer-verification-note-status');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'soop-streamer-verification-note-status';
      notice.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;padding:12px 16px;border-radius:10px;background:#171a20;color:#fff;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:min(420px,calc(100vw - 36px));';
      document.body.appendChild(notice);
    }
    notice.textContent = message;
    notice.style.border = isError ? '1px solid #e2554f' : '1px solid #3fb689';
    clearTimeout(notice._hideTimer);
    notice._hideTimer = setTimeout(function () { notice.remove(); }, 9000);
  }

  function findCandidateRowText(anchor) {
    // The inbox uses nested clickable cells. The nearest <tr>/<li> can contain
    // only the linked cell in some SOOP layouts, so walk upward until the
    // sender ID and preview code are both present in the same bounded row.
    let node = anchor;
    let fallback = null;
    for (let i = 0; node && i < 24; i += 1, node = node.parentElement) {
      const text = (node.innerText || node.textContent || '').normalize('NFC');
      if (text.length > 0 && text.length < 1600) {
        const hasSenderId = /\([a-z0-9]{2,20}\)/i.test(text);
        const hasCode = CODE_RE.test(text);
        if (hasSenderId && hasCode) return { text: text, hasSenderId: true, hasCode: true, depth: i };
        if (!fallback && (hasSenderId || hasCode)) {
          fallback = { text: text, hasSenderId: hasSenderId, hasCode: hasCode, depth: i };
        }
      }
      if (node === document.body) break;
    }
    return fallback;
  }

  function inspectCandidate(anchor) {
    let url;
    try { url = new URL(anchor.href, location.href); } catch (_) { return { reason: 'invalid-link' }; }
    if (url.hostname !== 'note.sooplive.com' || url.pathname !== '/app/index.php' || url.searchParams.get('page') !== 'recv_view') {
      return { reason: 'unexpected-link' };
    }
    const noteNo = url.searchParams.get('no') || '';
    if (!/^\d{1,20}$/.test(noteNo)) return { reason: 'missing-note-number' };
    const row = findCandidateRowText(anchor);
    if (!row) return { reason: 'sender-and-code-not-in-row', depth: 24 };
    if (!row.hasSenderId) return { reason: 'sender-id-not-in-row', depth: row.depth };
    if (!row.hasCode) return { reason: 'code-not-in-row', depth: row.depth };
    const idMatch = row.text.match(/\(([a-z0-9]{2,20})\)/i);
    const codeMatch = row.text.match(CODE_RE);
    if (!idMatch) return { reason: 'sender-id-not-found' };
    if (!codeMatch) return { reason: 'code-not-found' };
    return { candidate: { noteNo: noteNo, senderId: idMatch[1].toLowerCase(), code: codeMatch[1].toUpperCase() } };
  }

  async function scanInbox() {
    if (scanning || new URL(location.href).searchParams.get('page') !== 'recv_list') return;
    scanning = true;
    try {
      const state = await chrome.storage.local.get([MONITOR_KEY, ATTEMPT_KEY]);
      const monitor = state[MONITOR_KEY] || {};
      if (!monitor.active || Number(monitor.expiresAt) <= Date.now()) {
        await chrome.storage.local.remove(MONITOR_KEY);
        return;
      }
      const now = Date.now();
      const attemptTimes = state[ATTEMPT_KEY] && typeof state[ATTEMPT_KEY] === 'object' ? state[ATTEMPT_KEY] : {};
      Object.keys(attemptTimes).forEach(function (key) {
        if (!Number.isFinite(Number(attemptTimes[key])) || now - Number(attemptTimes[key]) > 20 * 60 * 1000) delete attemptTimes[key];
      });
      const anchors = Array.from(document.querySelectorAll('a[href*="page=recv_view"]'));
      const parseResults = {};
      const attemptedThisScan = new Set();
      let retryDeferred = 0;
      for (const anchor of anchors) {
        const inspected = inspectCandidate(anchor);
        if (!inspected.candidate) {
          const reason = inspected.reason + '-depth-' + inspected.depth;
          parseResults[reason] = (parseResults[reason] || 0) + 1;
          continue;
        }
        const candidate = inspected.candidate;
        // Note number + sender identify a row without persisting the private
        // verification code. Deduplicate duplicate links within this scan,
        // but retry failed checks after a short cooldown and across reloads.
        const signature = candidate.noteNo + ':' + candidate.senderId;
        if (attemptedThisScan.has(signature)) continue;
        attemptedThisScan.add(signature);
        if (Number(attemptTimes[signature]) && now - Number(attemptTimes[signature]) < RETRY_MS) {
          retryDeferred += 1;
          continue;
        }
        attemptTimes[signature] = now;
        await chrome.storage.local.set({ [ATTEMPT_KEY]: attemptTimes });
        trace('candidate-detected', { senderId: candidate.senderId, noteNo: candidate.noteNo });
        let result;
        try {
          result = await chrome.runtime.sendMessage(Object.assign({ type: 'confirmStreamerVerificationNoteFromInbox' }, candidate));
        } catch (error) {
          trace('candidate-forward-failed', { reason: String(error && error.message || error).slice(0, 120) });
          continue;
        }
        if (result && result.ok) {
          showNotice(result.isSwitch
            ? '기존 인증 계정의 SOOP 아이디가 확인돼 ' + (result.nickname || '스트리머') + ' 계정 전환을 승인했습니다.'
            : '인증 쪽지와 신청 정보가 일치해 ' + (result.nickname || '스트리머') + ' 인증을 승인했습니다.', false);
          trace(result.isSwitch ? 'verification-switch-approved' : 'verification-approved', { senderId: candidate.senderId, noteNo: candidate.noteNo });
          // Other sister-site requests may still be pending. Keep the inbox
          // watcher alive until Admin Center reports that none remain.
          await scheduleNextRefresh();
          return;
        }
        trace('candidate-not-approved', { senderId: candidate.senderId, noteNo: candidate.noteNo, reason: String(result && result.reason || 'empty-response') });
      }
      trace('inbox-scan-complete', { rowsScanned: anchors.length, retryDeferred: retryDeferred, candidatesNotParsed: parseResults });
    } catch (error) {
      trace('inbox-scan-failed', { error: String(error && error.message || error).slice(0, 160) });
    } finally {
      scanning = false;
    }
  }

  async function scheduleNextRefresh() {
    clearTimeout(refreshTimer);
    const state = await chrome.storage.local.get(MONITOR_KEY);
    const monitor = state[MONITOR_KEY] || {};
    if (!monitor.active) return;
    if (Number(monitor.expiresAt) <= Date.now()) {
      await chrome.storage.local.remove(MONITOR_KEY);
      trace('inbox-watch-expired', {});
      showNotice('인증 쪽지 자동 확인 시간이 끝났어요. 통합 관리 센터와 받은 쪽지함을 다시 열어주세요.', true);
      return;
    }
    refreshTimer = setTimeout(function () { location.reload(); }, REFRESH_MS);
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'setStreamerVerificationInboxWatch') return false;
    if (message.active !== true) {
      clearTimeout(refreshTimer);
      chrome.storage.local.remove([MONITOR_KEY, ATTEMPT_KEY, 'soopStreamerVerificationInboxSeenNotes']).then(function () {
        trace('inbox-watch-stopped', {});
        sendResponse({ ok: true });
      });
      return true;
    }
    const expiresAt = Math.min(Number(message.expiresAt) || 0, Date.now() + 20 * 60 * 1000);
    if (expiresAt <= Date.now()) {
      sendResponse({ ok: false, reason: 'expired' });
      return false;
    }
    chrome.storage.local.get(MONITOR_KEY).then(async function (state) {
      const current = state[MONITOR_KEY] || {};
      if (current.active && Number(current.expiresAt) >= expiresAt) {
        await scanInbox();
        sendResponse({ ok: true, expiresAt: current.expiresAt });
        return;
      }
      // Remove signatures saved by older versions, which marked failed
      // candidates as permanently handled and contained the verification code.
      await chrome.storage.local.remove('soopStreamerVerificationInboxSeenNotes');
      await chrome.storage.local.set({ [MONITOR_KEY]: { active: true, expiresAt: expiresAt } });
      trace('inbox-watch-started', { expiresAt: expiresAt });
      await scanInbox();
      await scheduleNextRefresh();
      sendResponse({ ok: true, expiresAt: expiresAt });
    }).catch(function (error) {
      sendResponse({ ok: false, reason: String(error && error.message || error) });
    });
    return true;
  });

  chrome.storage.local.get(MONITOR_KEY).then(async function (state) {
    const monitor = state[MONITOR_KEY] || {};
    if (!monitor.active) return;
    trace('inbox-watch-resumed', { expiresAt: monitor.expiresAt });
    await scanInbox();
    await scheduleNextRefresh();
  });
})();
