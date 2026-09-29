(function () {
  const OPEN_BUTTON_ID = 'streamerPromoGeneratorOpenBtn';
  const completionReplies = new Map();
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

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
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
})();
