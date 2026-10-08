(function () {
  const OPEN_BUTTON_ID = 'streamerPromoGeneratorOpenBtn';
  const completionReplies = new Map();
  const duplicateLookupReplies = new Map();
  const candidateAddReplies = new Map();
  const promoExclusionReplies = new Map();
  const verificationNoteReplies = new Map();
  const onyuGiftNotificationReplies = new Map();
  let extensionContextUnavailable = false;

  function trace(attemptId, stage, details) {
    console.info('[SOOP 홍보 진단]', JSON.stringify({
      attemptId: attemptId || 'unassigned',
      stage: stage,
      at: new Date().toISOString(),
      details: details || {},
    }));
  }

  function createAttemptId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'promo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function showMessage(message, isError) {
    let status = document.getElementById('soop-promo-extension-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'soop-promo-extension-status';
      status.setAttribute('role', 'status');
      status.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px 16px;border-radius:12px;background:#171a20;color:#fff;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:min(420px,calc(100vw - 40px));';
      document.body.appendChild(status);
    }
    status.textContent = message;
    status.style.border = isError ? '1px solid #e2554f' : '1px solid #3fb689';
    clearTimeout(status._hideTimer);
    status._hideTimer = setTimeout(function () { status.remove(); }, 5000);
  }

  function hasValidExtensionContext() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source === window && event.origin === location.origin && data && data.__soopPromoExtensionProbe === true) {
      window.postMessage({ __soopPromoExtensionReady: true }, location.origin);
    }
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data || data.__streamerVerificationInboxWatch !== true) return;
    const active = data.active === true;
    const expiresAt = Number(data.expiresAt) || 0;
    if (extensionContextUnavailable || !hasValidExtensionContext()) {
      extensionContextUnavailable = true;
      trace('', 'verification-inbox-watch-skipped-context-unavailable', { active: active });
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'watchStreamerVerificationInbox', active: active, expiresAt: expiresAt })
        .then(function (result) {
          trace('', 'verification-inbox-watch-requested', { active: active, inboxTabCount: Number(result && result.inboxTabCount) || 0 });
        }).catch(function (error) {
          const contextInvalidated = /Extension context invalidated/i.test(String(error && error.message || error));
          if (contextInvalidated) extensionContextUnavailable = true;
          trace('', contextInvalidated ? 'verification-inbox-watch-skipped-context-unavailable' : 'verification-inbox-watch-request-failed', {
            active: active, error: String(error && error.message || error).slice(0, 120),
          });
        });
    } catch (error) {
      const contextInvalidated = /Extension context invalidated/i.test(String(error && error.message || error));
      if (contextInvalidated) extensionContextUnavailable = true;
      trace('', contextInvalidated ? 'verification-inbox-watch-skipped-context-unavailable' : 'verification-inbox-watch-request-failed', {
        active: active, error: String(error && error.message || error).slice(0, 120),
      });
    }
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data || data.__onyuGameGiftNotificationWatch !== true) return;
    if (extensionContextUnavailable || !hasValidExtensionContext()) {
      trace('', 'onyu-gift-watch-skipped-context-unavailable', { active: data.active === true });
      extensionContextUnavailable = true;
      return;
    }
    chrome.runtime.sendMessage({
      type: 'watchOnyuGameGiftNotifications',
      active: data.active === true,
      expiresAt: Number(data.expiresAt) || 0,
    }).then(function (result) {
      trace('', 'onyu-gift-watch-requested', { active: data.active === true, soopTabCount: Number(result && result.soopTabCount) || 0 });
    }).catch(function (error) {
      const invalidated = /Extension context invalidated/i.test(String(error && error.message || error));
      if (invalidated) extensionContextUnavailable = true;
      trace('', invalidated ? 'onyu-gift-watch-skipped-context-unavailable' : 'onyu-gift-watch-request-failed', {
        active: data.active === true, error: String(error && error.message || error).slice(0, 120),
      });
    });
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data ||
        data.__onyuGiftBackgroundMonitorStart !== true || typeof data.customToken !== 'string') return;
    if (extensionContextUnavailable || !hasValidExtensionContext()) {
      extensionContextUnavailable = true;
      window.postMessage({ __onyuGiftBackgroundMonitorStatus: true, ok: false, reason: 'extension-context-unavailable' }, location.origin);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'startOnyuGiftBackgroundMonitor',
      customToken: data.customToken,
      adminUid: String(data.adminUid || ''),
    }).then(function (result) {
      window.postMessage({
        __onyuGiftBackgroundMonitorStatus: true,
        ok: !!(result && result.ok),
        state: result && result.ok ? 'starting' : 'failed',
        reason: String(result && result.reason || ''),
      }, location.origin);
    }).catch(function () {
      window.postMessage({ __onyuGiftBackgroundMonitorStatus: true, ok: false, reason: 'background-start-failed' }, location.origin);
    });
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data || data.__onyuGiftBackgroundMonitorStop !== true) return;
    if (extensionContextUnavailable || !hasValidExtensionContext()) return;
    chrome.runtime.sendMessage({ type: 'stopOnyuGiftBackgroundMonitor' }).then(function (result) {
      window.postMessage({ __onyuGiftBackgroundMonitorStatus: true, ok: !!(result && result.ok), state: 'stopped' }, location.origin);
    }).catch(function () {});
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data ||
        data.__soopPromoBatchRequest !== true || typeof data.requestId !== 'string') return;
    if (extensionContextUnavailable || !hasValidExtensionContext()) {
      extensionContextUnavailable = true;
      window.postMessage({
        __soopPromoBatchResponse: true,
        requestId: data.requestId,
        ok: false,
        message: '확장 프로그램이 갱신되었습니다. 관리자 센터 탭을 새로고침해주세요.',
      }, location.origin);
      return;
    }
    const action = String(data.action || '');
    const request = { type: 'promoBatchControl', action: action };
    if (action === 'start') {
      request.items = Array.isArray(data.items) ? data.items : [];
      request.repeatCount = Number(data.repeatCount) || 0;
      request.delayMs = Number(data.delayMs) || 0;
      request.testOnly = data.testOnly === true;
    }
    chrome.runtime.sendMessage(request).then(function (result) {
      window.postMessage({
        __soopPromoBatchResponse: true,
        requestId: data.requestId,
        ok: !!(result && result.ok),
        message: String(result && result.message || result && result.reason || ''),
        state: result && result.state || null,
      }, location.origin);
    }).catch(function (error) {
      window.postMessage({
        __soopPromoBatchResponse: true,
        requestId: data.requestId,
        ok: false,
        message: '확장 프로그램 요청을 처리하지 못했습니다: ' + String(error && error.message || error).slice(0, 100),
      }, location.origin);
    });
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || !data ||
        data.__onyuGameGiftNotificationResult !== true || typeof data.requestId !== 'string') return;
    const reply = onyuGiftNotificationReplies.get(data.requestId);
    if (reply) reply({ ok: data.ok === true, reason: String(data.reason || ''), targetNickname: String(data.targetNickname || '') });
  });

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message && message.type === 'promoBatchStatusUpdate') {
      window.postMessage({ __soopPromoBatchStatus: true, state: message.state || {} }, location.origin);
      return false;
    }
    if (message && message.type === 'onyuGiftBackgroundMonitorStatus') {
      window.postMessage({
        __onyuGiftBackgroundMonitorStatus: true,
        ok: message.state !== 'failed',
        state: String(message.state || ''),
        reason: String(message.reason || ''),
      }, location.origin);
      return false;
    }
    if (message && message.type === 'confirmOnyuGameGiftNotification') {
      const requestId = createAttemptId();
      const timeout = setTimeout(function () {
        onyuGiftNotificationReplies.delete(requestId);
        sendResponse({ ok: false, reason: 'admin-center-timeout' });
      }, 25000);
      onyuGiftNotificationReplies.set(requestId, function (result) {
        clearTimeout(timeout);
        onyuGiftNotificationReplies.delete(requestId);
        sendResponse(result || { ok: false, reason: 'empty-response' });
      });
      window.postMessage({
        __onyuGameGiftNotificationCandidate: true,
        requestId: requestId,
        senderSoopId: message.senderSoopId,
        balloons: message.balloons,
        observedAt: message.observedAt,
        eventAtMin: message.eventAtMin,
        eventAtMax: message.eventAtMax,
        exactTimestamp: message.exactTimestamp === true,
        candidateFingerprint: message.candidateFingerprint,
      }, location.origin);
      return true;
    }
    if (message && message.type === 'confirmStreamerVerificationNote' &&
        typeof message.senderId === 'string' && typeof message.code === 'string' && typeof message.noteNo === 'string') {
      const requestId = createAttemptId();
      const timeout = setTimeout(function () {
        verificationNoteReplies.delete(requestId);
        sendResponse({ ok: false, reason: 'admin-center-timeout' });
      }, 25000);
      verificationNoteReplies.set(requestId, function (result) {
        clearTimeout(timeout);
        verificationNoteReplies.delete(requestId);
        sendResponse(result || { ok: false, reason: 'empty-response' });
      });
      window.postMessage({
        __streamerVerificationNoteRequest: true,
        requestId: requestId,
        senderId: message.senderId,
        code: message.code,
        noteNo: message.noteNo,
      }, location.origin);
      return true;
    }
    if (message && message.type === 'addStreamerPromoCandidate' &&
        typeof message.nickname === 'string' && typeof message.soopId === 'string' && typeof message.writeUrl === 'string') {
      const requestId = createAttemptId();
      const timeout = setTimeout(function () {
        candidateAddReplies.delete(requestId);
        trace(requestId, 'admin-bridge-candidate-add-timeout', {});
        sendResponse({ ok: false, reason: 'admin-center-timeout', message: '관리자 센터 응답 시간이 초과되었습니다.' });
      }, 20000);
      candidateAddReplies.set(requestId, function (result) {
        clearTimeout(timeout);
        candidateAddReplies.delete(requestId);
        sendResponse(result || { ok: false, reason: 'empty-response' });
      });
      trace(requestId, 'admin-bridge-candidate-add-received', { soopId: message.soopId });
      window.postMessage({
        __soopPromoCandidateAddRequest: true,
        requestId: requestId,
        nickname: message.nickname,
        soopId: message.soopId,
        writeUrl: message.writeUrl,
      }, location.origin);
      return true;
    }
    if (message && message.type === 'lookupStreamerPromoDuplicate' &&
        typeof message.requestId === 'string' && typeof message.nickname === 'string' &&
        typeof message.stationId === 'string') {
      const timeout = setTimeout(function () {
        duplicateLookupReplies.delete(message.requestId);
        trace('', 'admin-bridge-duplicate-lookup-timeout', { requestId: message.requestId });
        sendResponse({ ok: false, reason: 'admin-center-timeout' });
      }, 15000);
      duplicateLookupReplies.set(message.requestId, function (result) {
        clearTimeout(timeout);
        duplicateLookupReplies.delete(message.requestId);
        sendResponse(result || { ok: false, reason: 'empty-response' });
      });
      trace('', 'admin-bridge-duplicate-lookup-received', { requestId: message.requestId, stationId: message.stationId });
      window.postMessage({
        __soopPromoDuplicateLookupRequest: true,
        requestId: message.requestId,
        stationId: message.stationId,
        nickname: message.nickname,
      }, location.origin);
      return true;
    }
    if (message && message.type === 'setStreamerPromoExclusion' &&
        typeof message.requestId === 'string' && typeof message.nickname === 'string' &&
        typeof message.soopId === 'string' && typeof message.excluded === 'boolean') {
      const timeout = setTimeout(function () {
        promoExclusionReplies.delete(message.requestId);
        trace('', 'admin-bridge-promo-exclusion-timeout', { requestId: message.requestId, soopId: message.soopId });
        sendResponse({ ok: false, reason: 'admin-center-timeout', message: '관리자 센터 응답 시간이 초과되었습니다.' });
      }, 20000);
      promoExclusionReplies.set(message.requestId, function (result) {
        clearTimeout(timeout);
        promoExclusionReplies.delete(message.requestId);
        sendResponse(result || { ok: false, reason: 'empty-admin-response' });
      });
      trace(message.requestId, 'admin-bridge-promo-exclusion-received', { soopId: message.soopId, excluded: message.excluded });
      window.postMessage({
        __soopPromoExclusionRequest: true,
        requestId: message.requestId,
        nickname: message.nickname,
        soopId: message.soopId,
        excluded: message.excluded,
      }, location.origin);
      return true;
    }
    if (!message || message.type !== 'markPromoCompleted' ||
        typeof message.requestId !== 'string' || typeof message.promoKey !== 'string') return false;
    trace(message.attemptId, 'admin-bridge-received-completion', { requestId: message.requestId });
    const timeout = setTimeout(function () {
      completionReplies.delete(message.requestId);
      trace(message.attemptId, 'admin-bridge-timeout', { requestId: message.requestId });
      sendResponse({ ok: false, error: '관리 센터 응답 시간이 초과되었습니다.', attemptId: message.attemptId || '' });
    }, 15000);
    completionReplies.set(message.requestId, function (result) {
      clearTimeout(timeout);
      completionReplies.delete(message.requestId);
      sendResponse(Object.assign({ attemptId: message.attemptId || '' }, result || {}));
    });
    window.postMessage({
      __soopPromoCompletionRequest: true,
      requestId: message.requestId,
      promoKey: message.promoKey,
      soopId: message.soopId || '',
      attemptId: message.attemptId || '',
    }, location.origin);
    return true;
  });

  window.addEventListener('message', function (event) {
    const data = event.data;
    if (event.source === window && event.origin === location.origin && data &&
        data.__streamerVerificationNoteResult === true && typeof data.requestId === 'string') {
      const reply = verificationNoteReplies.get(data.requestId);
      if (reply) reply({ ok: data.ok === true, reason: String(data.reason || ''), nickname: String(data.nickname || '') });
      return;
    }
    if (event.source === window && event.origin === location.origin && data &&
        data.__soopPromoCandidateAddResult === true && typeof data.requestId === 'string') {
      const candidateReply = candidateAddReplies.get(data.requestId);
      if (candidateReply) {
        trace(data.requestId, data.ok === true ? 'admin-bridge-candidate-add-succeeded' : 'admin-bridge-candidate-add-failed', {
          reason: String(data.reason || ''),
        });
        candidateReply({ ok: data.ok === true, reason: String(data.reason || ''), message: String(data.message || '') });
      }
      return;
    }
    if (event.source === window && event.origin === location.origin && data &&
        data.__soopPromoDuplicateLookupResult === true && typeof data.requestId === 'string') {
      const duplicateReply = duplicateLookupReplies.get(data.requestId);
      if (duplicateReply) {
        trace('', data.ok === true ? 'admin-bridge-duplicate-lookup-succeeded' : 'admin-bridge-duplicate-lookup-failed', {
          requestId: data.requestId, found: data.found === true, reason: String(data.reason || ''),
        });
        duplicateReply({ ok: data.ok === true, found: data.found === true, excluded: data.excluded === true, nickname: String(data.nickname || ''), matchMethod: String(data.matchMethod || ''), reason: String(data.reason || '') });
      }
      return;
    }
    if (event.source === window && event.origin === location.origin && data &&
        data.__soopPromoExclusionResult === true && typeof data.requestId === 'string') {
      const exclusionReply = promoExclusionReplies.get(data.requestId);
      if (exclusionReply) {
        trace(data.requestId, data.ok === true ? 'admin-bridge-promo-exclusion-succeeded' : 'admin-bridge-promo-exclusion-failed', {
          soopId: String(data.soopId || ''), excluded: data.excluded === true, reason: String(data.reason || ''),
        });
        exclusionReply({ ok: data.ok === true, excluded: data.excluded === true, nickname: String(data.nickname || ''), reason: String(data.reason || ''), message: String(data.message || '') });
      }
      return;
    }
    if (event.source !== window || event.origin !== location.origin || !data ||
        data.__soopPromoCompletionResult !== true || typeof data.requestId !== 'string') return;
    const reply = completionReplies.get(data.requestId);
    if (reply) {
      trace(data.attemptId, data.ok === true ? 'admin-page-save-succeeded' : 'admin-page-save-failed', {
        error: String(data.error || ''),
      });
      reply({ ok: data.ok === true, error: String(data.error || '') });
    }
  });

  document.addEventListener('click', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const listLink = target ? target.closest('a[data-promo-write-link="true"]') : null;
    const button = target
      ? target.closest('#' + OPEN_BUTTON_ID)
      : null;
    if (!button && !listLink) return;

    const attemptId = createAttemptId();

    if (extensionContextUnavailable || !hasValidExtensionContext()) {
      trace(attemptId, 'admin-bridge-context-unavailable', { page: location.href });
      extensionContextUnavailable = true;
      event.preventDefault();
      if (button) event.stopImmediatePropagation();
      showMessage('확장 프로그램이 갱신되었습니다. 관리자 센터 탭을 새로고침한 뒤 다시 눌러주세요.', true);
      return;
    }

    const nickname = listLink
      ? listLink.dataset.nickname || ''
      : (document.getElementById('streamerPromoGeneratorName') || {}).value || '';
    const title = listLink
      ? listLink.dataset.promoTitle || ''
      : (document.getElementById('streamerPromoGeneratedTitle') || {}).textContent || '';
    const body = listLink
      ? listLink.dataset.promoBody || ''
      : (document.getElementById('streamerPromoGeneratedBody') || {}).textContent || '';
    const html = listLink
      ? listLink.dataset.promoHtml || ''
      : (document.getElementById('streamerPromoGeneratedHtml') || {}).textContent || '';
    const writeUrl = listLink ? listLink.dataset.writeUrl || '' : button.dataset.writeUrl || '';
    const promoKey = listLink ? listLink.dataset.promoKey || '' : button.dataset.promoKey || '';
    const soopId = listLink ? listLink.dataset.soopId || '' : button.dataset.soopId || '';

    if (!nickname.trim() || !title || !body || !html || !writeUrl || !promoKey || (button && button.disabled)) {
      trace(attemptId, 'admin-bridge-validation-failed', {
        nickname: !!nickname.trim(), title: !!title, body: !!body, html: !!html,
        writeUrl: !!writeUrl, promoKey: !!promoKey, buttonDisabled: !!(button && button.disabled),
      });
      event.preventDefault();
      if (button) event.stopImmediatePropagation();
      showMessage('스트리머를 선택하고 생성된 내용을 확인해주세요.', true);
      return;
    }

    event.preventDefault();
    if (button) {
      event.stopImmediatePropagation();
      button.disabled = true;
    }
    let sendRequest;
    try {
      trace(attemptId, 'open-request-sent', {
        stationId: (writeUrl.match(/\/station\/([^/]+)/i) || [])[1] || '',
        promoKey: promoKey,
        titleLength: title.length,
        bodyLength: body.length,
        htmlLength: html.length,
      });
      sendRequest = chrome.runtime.sendMessage({
        type: 'openPromoDraft',
        attemptId: attemptId,
        draft: {
          nickname: nickname.trim(),
          title: title,
          body: body,
          html: html,
          writeUrl: writeUrl,
          promoKey: promoKey,
          soopId: soopId,
        },
      });
    } catch (error) {
      extensionContextUnavailable = true;
      trace(attemptId, 'open-request-threw', { error: String(error && error.message || error) });
      if (button) button.disabled = false;
      showMessage('확장 프로그램이 갱신되었습니다. 관리자 센터 탭을 새로고침한 뒤 다시 눌러주세요.', true);
      return;
    }
    sendRequest.then(function (result) {
      if (!result || !result.ok) {
        trace(attemptId, 'open-request-rejected', { error: result && result.error || 'empty-response' });
        showMessage((result && result.error) || '확장 프로그램 요청을 처리하지 못했습니다.', true);
        return;
      }
      trace(attemptId, 'open-request-accepted', {});
      showMessage('SOOP 글쓰기 탭을 열었습니다. 입력 결과를 검수한 뒤 직접 게시해주세요.');
    }).catch(function (error) {
      trace(attemptId, 'open-request-failed', { error: String(error && error.message || error) });
      const contextInvalidated = !hasValidExtensionContext() || /Extension context invalidated/i.test(String(error && error.message || error));
      if (contextInvalidated) {
        extensionContextUnavailable = true;
        showMessage('확장 프로그램이 갱신되었습니다. 관리자 센터 탭을 새로고침한 뒤 다시 눌러주세요.', true);
      } else {
        console.error('SOOP 홍보글 확장 프로그램 연결 실패:', error);
        showMessage('확장 프로그램에 연결하지 못했습니다. 설치 및 사용 설정을 확인해주세요.', true);
      }
    }).finally(function () {
      if (button) button.disabled = false;
    });
  }, true);

  window.postMessage({ __soopPromoExtensionReady: true }, location.origin);
})();
