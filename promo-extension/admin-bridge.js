(function () {
  const OPEN_BUTTON_ID = 'streamerPromoGeneratorOpenBtn';

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

  document.addEventListener('click', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    const listLink = target ? target.closest('a[data-promo-write-link="true"]') : null;
    const button = target
      ? target.closest('#' + OPEN_BUTTON_ID)
      : null;
    if (!button && !listLink) return;

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

    if (!nickname.trim() || !title || !body || !html || !writeUrl || (button && button.disabled)) {
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
    chrome.runtime.sendMessage({
      type: 'openPromoDraft',
      draft: {
        nickname: nickname.trim(),
        title: title,
        body: body,
        html: html,
        writeUrl: writeUrl,
      },
    }).then(function (result) {
      if (!result || !result.ok) {
        showMessage((result && result.error) || '확장 프로그램 요청을 처리하지 못했습니다.', true);
        return;
      }
      showMessage('SOOP 글쓰기 탭을 열었습니다. 입력 결과를 검수한 뒤 직접 게시해주세요.');
    }).catch(function (error) {
      console.error('SOOP 홍보글 확장 프로그램 연결 실패:', error);
      showMessage('확장 프로그램에 연결하지 못했습니다. 설치 및 사용 설정을 확인해주세요.', true);
    }).finally(function () {
      if (button) button.disabled = false;
    });
  }, true);
})();
