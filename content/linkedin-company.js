(() => {
  'use strict';

  if (globalThis.__GHD_LINKEDIN_COMPANY__) {
    return;
  }

  globalThis.__GHD_LINKEDIN_COMPANY__ = true;

  const headcount = globalThis.GhdHeadcount;
  let storedMarker = '';
  let timer = null;

  function capture() {
    if (!headcount || !chrome?.storage?.local?.set) {
      return;
    }

    const slug = headcount.slugFromUrl(location.href);
    const employees = headcount.readPageEmployees(document);
    const company = headcount.pageCompanyName?.(document) || '';

    if (!slug || !employees) {
      return;
    }

    const marker = `${slug}:${company}:${employees}`;

    if (marker === storedMarker) {
      return;
    }

    storedMarker = marker;
    const record = headcount.captureRecord(slug, company, employees, Date.now());
    const keys = headcount.captureKeys(slug, company);

    if (!keys.length) {
      return;
    }

    const payload = {};

    for (const key of keys) {
      payload[key] = record;
    }

    const write = chrome.storage.local.set(payload);

    if (write && typeof write.catch === 'function') {
      write.catch(() => {
        // Storage can reject the write while the page is closing.
      });
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(capture, 300);
  }

  [0, 700, 2000, 5000].forEach((delay) => setTimeout(capture, delay));

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  capture();
})();
