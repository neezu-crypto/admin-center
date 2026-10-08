(function () {
  const WRITE_PATH = /^\/station\/[A-Za-z0-9]+\/post\/write\/\d+\/?$/;
  if (!WRITE_PATH.test(location.pathname)) return;

  // Run at document_start so Esc can stop the batch while SOOP is still loading
  // and the main writer script has not been injected yet. The worker validates
  // that this exact tab belongs to the active batch before stopping anything.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    chrome.runtime.sendMessage({ type: 'cancelPromoBatchFromSoop', runId: '' }).catch(function () {});
  }, true);
})();
