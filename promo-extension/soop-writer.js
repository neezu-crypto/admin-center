(function () {
  const WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
  if (!WRITE_PATH.test(location.pathname)) return;

  function isVisible(element) {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findTitleField() {
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
    return null;
  }

  function findBodyEditor(titleField) {
    const selectors = [
      '[contenteditable="true"].ProseMirror',
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
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

  function setEditorHtml(editor, html) {
    editor.focus();
    const safeHtml = sanitizeHtml(html);
    const inserted = document.execCommand('insertHTML', false, safeHtml);
    if (!inserted || !editor.querySelector('img')) {
      editor.innerHTML = safeHtml;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
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

  chrome.runtime.sendMessage({ type: 'takePromoDraft' }).then(function (result) {
    const draft = result && result.draft;
    if (!draft) return;

    const titleField = findTitleField();
    const bodyEditor = findBodyEditor(titleField);
    if (!titleField || !bodyEditor) {
      showStatus('확장 프로그램이 제목 또는 본문 편집 영역을 찾지 못했습니다. 게시하지 않았습니다.', true);
      return;
    }

    try {
      if (titleField.isContentEditable) {
        titleField.focus();
        titleField.textContent = draft.title;
        titleField.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: draft.title }));
      } else {
        setInputValue(titleField, draft.title);
      }
      bodyEditor.focus();
      document.execCommand('selectAll', false, null);
      setEditorHtml(bodyEditor, draft.html);
      bodyEditor.blur();

      const titleMatches = titleField.isContentEditable
        ? titleField.textContent.trim() === draft.title
        : titleField.value.trim() === draft.title;
      const insertedText = bodyEditor.innerText || bodyEditor.textContent || '';
      const imageCount = bodyEditor.querySelectorAll('img').length;
      const bodyMatches = insertedText.includes(draft.nickname) && imageCount >= 2;
      if (!titleMatches || !bodyMatches) {
        showStatus('일부 입력을 확인하지 못했습니다. 제목·본문·이미지 ' + imageCount + '장을 검수해주세요. 게시하지 않았습니다.', true);
        return;
      }
      showStatus('제목과 본문, 이미지 2장을 입력했습니다. 내용 검수 후 직접 게시해주세요. 자동 게시·임시저장은 하지 않았습니다.');
    } catch (error) {
      console.error('SOOP 작성란 자동 입력 실패:', error);
      showStatus('입력 중 문제가 발생했습니다. 작성 내용을 확인해주세요. 게시하지 않았습니다.', true);
    }
  }).catch(function (error) {
    console.error('SOOP 홍보글 데이터 수신 실패:', error);
  });
})();
