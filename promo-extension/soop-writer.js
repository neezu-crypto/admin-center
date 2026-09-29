(function () {
  const WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
  const POST_DETAIL_PATH = /^\/station\/[A-Za-z0-9]+\/post\/\d+\/?$/;
  const PUBLISH_CLICK_SESSION_KEY = 'soopPromoPublishClickedAt';
  const isWritePage = WRITE_PATH.test(location.pathname);
  let diagnosticAttemptId = '';

  function trace(stage, details) {
    console.info('[SOOP 홍보 진단]', JSON.stringify({
      attemptId: diagnosticAttemptId || 'unassigned',
      stage: stage,
      at: new Date().toISOString(),
      details: Object.assign({ path: location.pathname }, details || {}),
    }));
  }

  if (!isWritePage && !POST_DETAIL_PATH.test(location.pathname)) {
    trace('page-route-not-supported', { host: location.hostname });
    return;
  }

  function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findTitleField(bodyEditor) {
    const selectors = [
      'input[placeholder*="게시글 제목"]',
      'textarea[placeholder*="게시글 제목"]',
      '[contenteditable="true"][aria-label*="게시글 제목"]',
      '[contenteditable="true"][data-placeholder*="게시글 제목"]',
      'input[placeholder*="제목"]',
    ];
    for (const selector of selectors) {
      const field = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (field) return field;
    }

    // SOOP may expose the title box as an unlabeled textbox. Locate it by
    // position relative to the much larger body editor in that case.
    const editorTop = bodyEditor ? bodyEditor.getBoundingClientRect().top : Infinity;
    const candidates = Array.from(document.querySelectorAll(
      'input:not([type="search"]):not([type="hidden"]), textarea, [role="textbox"], [contenteditable="true"]'
    )).filter(function (field) {
      if (!isVisible(field) || field === bodyEditor) return false;
      const rect = field.getBoundingClientRect();
      const isTextInput = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
      const type = (field.getAttribute('type') || '').toLowerCase();
      if (isTextInput && type && type !== 'text') return false;
      return rect.width > 300 && rect.height >= 20 && rect.height < 140 && rect.top < editorTop;
    });
    candidates.sort(function (a, b) {
      return b.getBoundingClientRect().top - a.getBoundingClientRect().top;
    });
    return candidates[0] || null;
  }

  function findBodyEditor(titleField) {
    const selectors = [
      '[contenteditable="true"].ProseMirror',
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
      '[role="textbox"]',
      '[contenteditable="true"]',
    ];
    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector)).filter(function (element) {
        if (element === titleField || !isVisible(element)) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 350 && rect.height > 120;
      });
      if (candidates.length) return candidates.sort(function (a, b) {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
      })[0];
    }
    return null;
  }

  async function waitForEditor(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const bodyEditor = findBodyEditor(null);
      const titleField = findTitleField(bodyEditor);
      if (titleField && bodyEditor) return { titleField: titleField, bodyEditor: bodyEditor };
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
    }
    return { titleField: findTitleField(null), bodyEditor: findBodyEditor(null) };
  }

  function setInputValue(field, value) {
    const prototype = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setTitleValue(field, value) {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      setInputValue(field, value);
      return;
    }
    field.focus();
    field.textContent = value;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getTitleValue(field) {
    return typeof field.value === 'string' ? field.value : field.textContent || '';
  }

  function sanitizeHtml(html) {
    const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    const allowedTags = new Set(['P', 'DIV', 'SPAN', 'A', 'IMG', 'FIGURE', 'BR', 'STRONG', 'EM', 'U']);
    const allowedAttributes = new Set(['href', 'src', 'alt', 'title', 'style', 'class', 'data-paragraph-type']);
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
    const elements = [];
    while (walker.nextNode()) elements.push(walker.currentNode);
    elements.forEach(function (element) {
      if (!allowedTags.has(element.tagName)) {
        element.replaceWith(...Array.from(element.childNodes));
        return;
      }
      Array.from(element.attributes).forEach(function (attribute) {
        if (!allowedAttributes.has(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
      });
      ['href', 'src'].forEach(function (attributeName) {
        if (!element.hasAttribute(attributeName)) return;
        try {
          const url = new URL(element.getAttribute(attributeName), location.origin);
          if (url.protocol !== 'https:') element.removeAttribute(attributeName);
          else element.setAttribute(attributeName, url.href);
        } catch (error) {
          element.removeAttribute(attributeName);
        }
      });
    });
    return doc.body.innerHTML;
  }

  function selectEditorContents(editor) {
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function setEditorHtml(editor, html) {
    const safeHtml = sanitizeHtml(html);
    const textDoc = new DOMParser().parseFromString('<body>' + safeHtml + '</body>', 'text/html');
    const plainText = textDoc.body.innerText || textDoc.body.textContent || '';
    editor.focus();
    selectEditorContents(editor);

    // SOOP's editor maintains its own document model. Prefer its paste handler
    // so the visible DOM and the data submitted with the post stay in sync.
    let pasteHandled = false;
    try {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', safeHtml);
      clipboardData.setData('text/plain', plainText);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboardData,
      });
      editor.dispatchEvent(pasteEvent);
      pasteHandled = pasteEvent.defaultPrevented;
    } catch (error) {
      console.warn('SOOP 붙여넣기 이벤트를 만들지 못했습니다. 기본 편집 입력을 시도합니다.', error);
    }

    // execCommand emits the browser's native editing/input events. Never fall
    // back to assigning innerHTML: that can paint content without updating the
    // editor's internal state, causing SOOP to reject the post as empty.
    if (!pasteHandled) {
      editor.focus();
      selectEditorContents(editor);
      if (!document.execCommand('insertHTML', false, safeHtml)) return false;
    }
    return true;
  }

  function waitForEditorUpdate(editor, timeoutMs) {
    return new Promise(function (resolve) {
      let settled = false;
      let timer = null;
      const finish = function () {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      const observer = new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(finish, 350);
      });
      observer.observe(editor, { childList: true, subtree: true, characterData: true, attributes: true });
      timer = setTimeout(finish, timeoutMs);
    });
  }

  function showStatus(message, isError) {
    let status = document.getElementById('soop-promo-extension-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'soop-promo-extension-status';
      status.setAttribute('role', 'status');
      status.style.cssText = 'position:fixed;right:24px;top:24px;z-index:2147483647;padding:12px 16px;border-radius:12px;background:#171a20;color:#fff;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.25);max-width:min(440px,calc(100vw - 48px));';
      document.body.appendChild(status);
    }
    status.textContent = message;
    status.style.border = isError ? '1px solid #e2554f' : '1px solid #3fb689';
    clearTimeout(status._hideTimer);
    status._hideTimer = setTimeout(function () { status.remove(); }, 9000);
  }

  function startPublishedPostWatch() {
    let stopped = false;
    let checking = false;
    let lastCheckAt = 0;
    let minimumCheckIntervalMs = 1200;
    let lastReportedResult = '';
    let failureShown = false;
    let mismatchLogged = false;
    let contentMismatchSince = 0;
    let timer = null;
    let fastWatchTimer = null;
    let observer = null;
    function stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(fastWatchTimer);
      if (observer) observer.disconnect();
    }
    function activateFastWatch(reason) {
      if (stopped) return;
      minimumCheckIntervalMs = 400;
      clearInterval(timer);
      timer = setInterval(check, minimumCheckIntervalMs);
      clearTimeout(fastWatchTimer);
      fastWatchTimer = setTimeout(function () {
        minimumCheckIntervalMs = 1200;
        clearInterval(timer);
        timer = setInterval(check, minimumCheckIntervalMs);
        trace('post-fast-watch-ended', { reason: reason || 'timeout' });
      }, 20000);
      trace('post-fast-watch-started', { reason: reason || 'publish-click', intervalMs: minimumCheckIntervalMs });
      check();
    }
    function check() {
      if (stopped || checking || !POST_DETAIL_PATH.test(location.pathname) || Date.now() - lastCheckAt < minimumCheckIntervalMs) return;
      checking = true;
      lastCheckAt = Date.now();
      const visibleText = document.body ? document.body.innerText || document.body.textContent || '' : '';
      Promise.resolve().then(function () {
        return chrome.runtime.sendMessage({
          type: 'confirmPromoPost',
          attemptId: diagnosticAttemptId,
          visibleText: visibleText.slice(0, 30000),
        });
      })
        .then(function (result) {
          if (result && result.attemptId) diagnosticAttemptId = result.attemptId;
          const reason = result && result.reason || (result && result.completed ? 'completed' : 'empty-response');
          if (reason !== lastReportedResult) {
            lastReportedResult = reason;
            trace('post-confirmation-result', { reason: reason, completed: !!(result && result.completed) });
          }
          if (result && result.completed) {
            stop();
            try { sessionStorage.removeItem(PUBLISH_CLICK_SESSION_KEY); } catch (error) { /* Storage may be blocked. */ }
            showStatus('게시글 등록을 확인해 홍보 완료로 표시했습니다. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), false);
          } else if (result && ['admin-save-failed', 'admin-tab-unavailable'].includes(result.reason) && !failureShown) {
            failureShown = true;
            showStatus('게시글은 확인했지만 관리 센터에 완료 상태를 저장하지 못했습니다. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
          } else if (result && result.reason === 'post-content-not-confirmed') {
            if (!contentMismatchSince) contentMismatchSince = Date.now();
            if (!mismatchLogged) {
              mismatchLogged = true;
              console.warn('[SOOP 홍보 보조] 게시글 상세 화면은 찾았지만 작성한 홍보글과 제목/게임 링크가 일치하지 않습니다.');
            }
            if (!failureShown && Date.now() - contentMismatchSince > 10000) {
              failureShown = true;
              showStatus('게시글 제목 또는 게임 링크가 대기 중인 내용과 달라 완료 처리하지 않았습니다. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
            }
          } else if (result && result.reason === 'multiple-pending-promos' && !failureShown) {
            failureShown = true;
            showStatus('같은 방송국에 일치하는 대기 홍보글이 여러 건입니다. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
          } else if (result && result.reason === 'no-pending-promo' && !failureShown) {
            failureShown = true;
            stop();
            showStatus('홍보 완료 추적 정보가 없어 자동 체크하지 못했습니다. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
          } else if (result && ['different-station', 'expired', 'not-post-detail'].includes(result.reason)) {
            if (!failureShown) {
              failureShown = true;
              showStatus('게시글 확인 정보가 일치하지 않습니다 (' + result.reason + '). 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
            }
            stop();
          } else if (result && result.reason && result.reason !== 'completion-in-progress' &&
              result.reason !== 'post-content-not-confirmed' && !failureShown) {
            failureShown = true;
            showStatus('홍보 완료 확인 단계에서 오류가 발생했습니다 (' + result.reason + '). 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
          } else if (!result && !failureShown) {
            failureShown = true;
            showStatus('홍보 완료 확인 응답이 비어 있습니다. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
          }
        })
        .catch(function (error) {
          trace('post-confirmation-message-error', { error: String(error && error.message || error) });
          if (!failureShown) {
            failureShown = true;
            showStatus('홍보 완료 확인 연결이 실패했습니다. 확장 프로그램 로그를 확인해주세요. 진단 ID: ' + (diagnosticAttemptId || '확인 불가'), true);
          }
        })
        .finally(function () { checking = false; });
    }
    timer = setInterval(check, minimumCheckIntervalMs);
    if (document.body) {
      observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    check();
    let publishClickAt = 0;
    try { publishClickAt = Number(sessionStorage.getItem(PUBLISH_CLICK_SESSION_KEY) || 0); } catch (error) { /* Storage may be blocked. */ }
    if (publishClickAt && Date.now() - publishClickAt < 120000) {
      activateFastWatch('after-publish-navigation');
    }
    if (isWritePage) {
      document.addEventListener('click', function (event) {
        const target = event.target instanceof Element ? event.target.closest('button') : null;
        if (!target || (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim() !== '게시') return;
        const clickedAt = Date.now();
        try { sessionStorage.setItem(PUBLISH_CLICK_SESSION_KEY, String(clickedAt)); } catch (error) { /* Storage may be blocked. */ }
        trace('publish-button-click-detected', {});
        activateFastWatch('publish-button-click');
      }, true);
    }
  }

  if (!isWritePage) {
    try { diagnosticAttemptId = sessionStorage.getItem('soopPromoDiagnosticAttemptId') || ''; } catch (error) { /* Storage may be blocked. */ }
    trace('post-detail-watcher-started', { attemptIdAvailable: !!diagnosticAttemptId });
    startPublishedPostWatch();
    return;
  }

  // Keep watching even if the extension is reloaded after taking the draft.
  // The completion token is persisted separately from the one-shot draft.
  startPublishedPostWatch();

  trace('write-page-watcher-started', {});
  Promise.resolve().then(function () {
    return chrome.runtime.sendMessage({ type: 'takePromoDraft' });
  }).then(async function (result) {
    const draft = result && result.draft;
    if (!draft) {
      trace('draft-not-found', { reason: result && result.error || 'no-draft-response' });
      return;
    }
    diagnosticAttemptId = draft.attemptId || '';
    try { sessionStorage.setItem('soopPromoDiagnosticAttemptId', diagnosticAttemptId); } catch (error) { /* Storage may be blocked. */ }
    trace('draft-received', {
      titleLength: (draft.title || '').length,
      bodyLength: (draft.body || '').length,
      htmlLength: (draft.html || '').length,
      stationId: (location.pathname.match(/^\/station\/([^/]+)/i) || [])[1] || '',
    });

    // SOOP renders the editor asynchronously after the page shell; wait for
    // both fields instead of consuming the one-shot draft before they exist.
    const fields = await waitForEditor(20000);
    const bodyEditor = fields.bodyEditor;
    const titleField = fields.titleField;
    if (!titleField || !bodyEditor) {
      trace('editor-fields-not-found', { titleFieldFound: !!titleField, bodyEditorFound: !!bodyEditor });
      showStatus('확장 프로그램이 제목 또는 본문 편집 영역을 찾지 못했습니다. 게시하지 않았습니다.', true);
      return;
    }

    try {
      setTitleValue(titleField, draft.title);
      bodyEditor.focus();
      const inserted = setEditorHtml(bodyEditor, draft.html);
      if (!inserted) {
        trace('editor-insert-failed', {});
        showStatus('SOOP 편집기가 내용을 입력받지 못했습니다. 편집 모드를 기본으로 바꾼 뒤 다시 시도해주세요. 게시하지 않았습니다.', true);
        return;
      }
      await waitForEditorUpdate(bodyEditor, 1800);
      bodyEditor.blur();

      const titleMatches = getTitleValue(titleField).trim() === draft.title;
      const insertedText = bodyEditor.innerText || bodyEditor.textContent || '';
      const imageCount = bodyEditor.querySelectorAll('img').length;
      const looksLikeHtmlSource = /<\/?(?:p|figure|img|div|span)\b/i.test(insertedText);
      const bodyMatches = insertedText.includes(draft.nickname) && imageCount >= 2 && !looksLikeHtmlSource;
      trace('editor-fill-verified', {
        titleMatches: titleMatches,
        nicknamePresent: insertedText.includes(draft.nickname),
        imageCount: imageCount,
        looksLikeHtmlSource: looksLikeHtmlSource,
        bodyTextLength: insertedText.length,
      });
      if (!titleMatches || !bodyMatches) {
        showStatus('SOOP 편집기에 본문이 정상 반영되지 않았습니다. HTML 코드가 글자로 보이거나 게시 버튼에서 빈 내용 안내가 나오면 게시하지 말고 기본 편집 모드에서 다시 시도해주세요. 게시하지 않았습니다.', true);
        return;
      }
      showStatus('제목과 본문을 편집기에 입력했습니다. 게시 전에 본문이 유지되는지와 이미지 2장을 확인해주세요. 자동 게시·임시저장은 하지 않았습니다.');
    } catch (error) {
      trace('editor-fill-threw', { error: String(error && error.message || error) });
      console.error('SOOP 작성란 자동 입력 실패:', error);
      showStatus('입력 중 문제가 발생했습니다. 작성 내용을 확인해주세요. 게시하지 않았습니다.', true);
    }
  }).catch(function (error) {
    trace('draft-request-failed', { error: String(error && error.message || error) });
    console.error('SOOP 홍보글 데이터 수신 실패:', error);
  });
})();
