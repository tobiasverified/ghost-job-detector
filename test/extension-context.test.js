import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadScripts() {
  const timers = new Map();
  let nextId = 1;
  const messageListeners = [];
  const documentListeners = [];
  const observerInstances = [];
  const host = {
    id: 'ghd-widget-host',
    removed: false,
    remove() {
      this.removed = true;
    }
  };
  const badge = {
    className: 'ghd-badge',
    removed: false,
    remove() {
      this.removed = true;
    }
  };

  function querySelectorAll(selector) {
    const found = [];
    const text = String(selector);

    if ((text === '#ghd-widget-host' || text.includes('#ghd-widget-host')) && !host.removed) {
      found.push(host);
    }

    if ((text === '.ghd-badge' || text.includes('.ghd-badge')) && !badge.removed) {
      found.push(badge);
    }

    return found;
  }

  class ShadowRoot {}

  class Element {}

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observerInstances.push(this);
    }

    observe() {
      this.connected = true;
    }

    disconnect() {
      this.connected = false;
    }
  }

  const runtime = {
    id: 'ghost-job-detector',
    onMessage: {
      addListener(fn) {
        messageListeners.push(fn);
      },
      removeListener(fn) {
        const index = messageListeners.indexOf(fn);

        if (index >= 0) {
          messageListeners.splice(index, 1);
        }
      }
    },
    sendMessage() {
      return Promise.resolve();
    }
  };

  function track(kind, fn, delay, args) {
    const id = nextId++;
    const starter = kind === 'interval' ? setInterval : setTimeout;
    const handle = starter(() => {
      if (!timers.has(id)) {
        return;
      }

      if (kind === 'timeout') {
        timers.delete(id);
      }

      fn(...args);
    }, delay);
    handle.unref?.();
    timers.set(id, handle);
    return id;
  }

  const sandbox = {
    URL,
    console: { info() {}, warn() {}, log() {} },
    setTimeout: (fn, delay, ...args) => track('timeout', fn, delay, args),
    clearTimeout(id) {
      const handle = timers.get(id);
      timers.delete(id);

      if (handle) {
        clearTimeout(handle);
      }
    },
    setInterval: (fn, delay, ...args) => track('interval', fn, delay, args),
    clearInterval(id) {
      const handle = timers.get(id);
      timers.delete(id);

      if (handle) {
        clearInterval(handle);
      }
    },
    MutationObserver,
    ShadowRoot,
    Element,
    location: {
      href: 'https://www.linkedin.com/jobs/view/4476508048',
      hostname: 'www.linkedin.com',
      pathname: '/jobs/view/4476508048'
    },
    document: {
      documentElement: {},
      body: null,
      querySelector() {
        return null;
      },
      querySelectorAll,
      createElement() {
        return { innerHTML: '', innerText: '', textContent: '', style: {} };
      },
      addEventListener(type, handler, options) {
        documentListeners.push({ type, handler, options });
      },
      removeEventListener(type, handler) {
        const index = documentListeners.findIndex((entry) => entry.type === type && entry.handler === handler);

        if (index >= 0) {
          documentListeners.splice(index, 1);
        }
      }
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {}
        }
      },
      runtime
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of ['lib/job-page.js', 'lib/widget.js', 'content.js', 'content/workday.js']) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), sandbox);
  }

  return { host, badge, timers, messageListeners, documentListeners, observerInstances, runtime };
}

test('a healthy extension context never tears the page down', async () => {
  const page = loadScripts();

  await wait(2500);

  assert.equal(page.host.removed, false);
  assert.equal(page.badge.removed, false);
  assert.ok(page.timers.size > 0);
  assert.ok(page.observerInstances.some((observer) => observer.connected));
  assert.ok(page.messageListeners.length >= 1);
  assert.ok(page.documentListeners.some((entry) => entry.type === 'scroll'));

  page.runtime.id = undefined;
  await wait(2500);
});

test('a missing runtime id removes the widget and stops the timers', async () => {
  const page = loadScripts();

  assert.equal(page.host.removed, false);
  assert.equal(page.badge.removed, false);
  page.runtime.id = undefined;
  await wait(400);
  assert.equal(page.host.removed, false);
  assert.ok(page.timers.size > 0);

  await wait(2200);

  assert.equal(page.host.removed, true);
  assert.equal(page.badge.removed, true);
  assert.equal(page.timers.size, 0);
  assert.ok(page.observerInstances.length > 0);
  assert.ok(page.observerInstances.every((observer) => observer.connected === false));
  assert.equal(page.messageListeners.length, 0);
  assert.equal(page.documentListeners.length, 0);

  await wait(200);
  assert.equal(page.host.removed, true);
  assert.equal(page.timers.size, 0);
});
