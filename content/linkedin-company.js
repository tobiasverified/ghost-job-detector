(() => {
  'use strict';

  if (globalThis.__GHD_LINKEDIN_COMPANY__) {
    return;
  }

  globalThis.__GHD_LINKEDIN_COMPANY__ = true;

  const headcount = globalThis.GhdHeadcount;
  let storedMarker = '';
  let timer = null;
  let observer = null;
  let contextTornDown = false;
  const timers = new Set();
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

  function extensionContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ''));
  }

  function later(fn, delay) {
    if (contextTornDown) {
      return 0;
    }

    const id = nativeSetTimeout(() => {
      timers.delete(id);

      if (!contextTornDown) {
        fn();
      }
    }, delay);
    timers.add(id);
    return id;
  }

  function teardownExtensionContext() {
    if (contextTornDown) {
      return;
    }

    contextTornDown = true;

    try {
      for (const id of [...timers]) {
        try {
          nativeClearTimeout(id);
        } catch {
          // The timer already fired.
        }
      }

      timers.clear();
      timer = null;
    } catch {
      // Timers are abandoned with the dead context.
    }

    try {
      observer?.disconnect();
    } catch {
      // Already disconnected.
    }

    observer = null;

    try {
      document.querySelectorAll('#ghd-widget-host, .ghd-badge').forEach((node) => {
        try {
          node.remove();
        } catch {
          // Already detached.
        }
      });
    } catch {
      // Removal is best-effort.
    }
  }

  function callChrome(fn) {
    try {
      const result = fn();

      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => value,
          (error) => {
            if (extensionContextInvalidated(error)) {
              teardownExtensionContext();
              return undefined;
            }

            throw error;
          }
        );
      }

      return result;
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        teardownExtensionContext();
        return undefined;
      }

      throw error;
    }
  }

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

    let write;

    try {
      write = callChrome(() => chrome.storage.local.set(payload));
    } catch (error) {
      console.error('[GHD] company headcount was not saved', error);
      return;
    }

    if (write && typeof write.catch === 'function') {
      write.catch((error) => {
        console.error('[GHD] company headcount was not saved', error);
      });
    }
  }

  function schedule() {
    nativeClearTimeout(timer);
    timers.delete(timer);
    timer = later(capture, 300);
  }

  [0, 700, 2000, 5000].forEach((delay) => later(capture, delay));

  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  capture();
})();
