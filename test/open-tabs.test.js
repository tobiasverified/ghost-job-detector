import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const LINKEDIN_FILES = [
  'lib/company-headcount.js',
  'lib/job-page.js',
  'lib/heuristics.js',
  'lib/pay.js',
  'lib/widget.js',
  'content.js'
];
const WORKDAY_FILES = [
  'lib/company-headcount.js',
  'lib/job-page.js',
  'lib/heuristics.js',
  'lib/pay.js',
  'lib/widget.js',
  'content/workday.js'
];
const COMPANY_FILES = ['lib/company-headcount.js', 'content/linkedin-company.js'];

function loadBackground(tabs, { framesFor, seed = [] } = {}) {
  const queries = [];
  const calls = [];
  const installed = [];
  const messages = [];
  const debugWrites = [];
  const debug = [...seed];
  const chrome = {
    runtime: {
      onMessage: {
        addListener(fn) {
          messages.push(fn);
        }
      },
      onSuspend: { addListener() {} },
      onInstalled: {
        addListener(fn) {
          installed.push(fn);
        }
      },
      lastError: null
    },
    tabs: {
      onUpdated: { addListener() {} },
      query(query) {
        queries.push(query);
        return Promise.resolve(tabs);
      }
    },
    storage: {
      local: {
        async get() {
          return { ghd_inject_debug: debug };
        },
        async set(items) {
          if (Object.prototype.hasOwnProperty.call(items || {}, 'ghd_inject_debug')) {
            debugWrites.push(items.ghd_inject_debug);
          }
        },
        async remove(key) {
          if (key === 'ghd_inject_debug') {
            debug.splice(0, debug.length);
          }
        }
      }
    },
    webNavigation: {
      onHistoryStateUpdated: { addListener() {} },
      async getAllFrames(query) {
        if (typeof framesFor === 'function') {
          return framesFor(query.tabId);
        }

        return [{ frameId: 0 }];
      }
    },
    scripting: {
      async executeScript(details) {
        const tab = tabs.find((item) => item.id === details.target.tabId);
        calls.push({
          tabId: details.target.tabId,
          files: details.files || null,
          world: details.world || null,
          frameIds: details.target.frameIds ? [...details.target.frameIds] : null
        });

        if (tab?.probeReject && typeof details.func === 'function') {
          throw new Error(tab.probeReject);
        }

        if (typeof details.func === 'function') {
          const page = {
            chrome: { runtime: { id: tab.runtimeId } },
            document: {
              getElementById(id) {
                return id === 'ghd-widget-host' ? (tab.host || null) : null;
              }
            },
            __GHD_INSTANCE__: tab.instance || '',
            __GHD_LINKEDIN_COMPANY__: tab.company === true,
            GhdWidget: tab.widget
          };
          page.globalThis = page;
          const context = vm.createContext(page);

          if (tab.copyLive === 'alive') {
            vm.runInContext(
              'globalThis.__GHD_COPY_LIVE__ = function () { try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (error) { return false; } };',
              context
            );
          } else if (tab.copyLive === 'dead') {
            vm.runInContext('globalThis.__GHD_COPY_LIVE__ = function () { return false; };', context);
          }

          const result = vm.runInContext(`(${details.func.toString()})()`, context);
          return [{ result }];
        }

        tab.injected.push(details.files);

        if (details.files.includes('lib/widget.js')) {
          tab.runtimeId = 'ghost-job-detector';
          tab.instance = 'live-widget';
          tab.copyLive = 'alive';
          tab.host = {
            getAttribute(name) {
              return name === 'data-ghd-instance' ? 'live-widget' : null;
            }
          };
          tab.widget = { analyze() {} };
        }

        if (details.files.includes('content/linkedin-company.js')) {
          tab.runtimeId = 'ghost-job-detector';
          tab.company = true;
          tab.instance = 'live-company';
          tab.copyLive = 'alive';
        }

        return [];
      }
    }
  };
  const sandbox = {
    console,
    URL,
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    chrome,
    importScripts() {}
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../background.js', import.meta.url), 'utf8'), sandbox);

  return { sandbox, queries, calls, installed, messages, debug, debugWrites };
}

function fileCalls(calls) {
  return calls.filter((call) => call.files);
}

test('open tabs with no script get the navigation file list', async () => {
  const tabs = [
    { id: 1, url: 'https://www.linkedin.com/jobs/view/4476508048', runtimeId: undefined, widget: undefined, company: false, injected: [] },
    { id: 2, url: 'https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/Role_1', runtimeId: undefined, widget: undefined, company: false, injected: [] },
    { id: 3, url: 'https://www.linkedin.com/company/acme/', runtimeId: undefined, widget: undefined, company: false, injected: [] }
  ];
  const page = loadBackground(tabs);

  await page.sandbox.injectOpenTabs();

  assert.deepEqual([...page.queries[0].url], [
    '*://*.linkedin.com/jobs/*',
    '*://*.linkedin.com/jobs/search*',
    '*://*.linkedin.com/jobs/search?*',
    '*://linkedin.com/jobs/*',
    '*://*.myworkdayjobs.com/*',
    '*://*.linkedin.com/company/*',
    '*://linkedin.com/company/*'
  ]);
  assert.deepEqual(tabs[0].injected.map((files) => [...files]), [LINKEDIN_FILES]);
  assert.deepEqual(tabs[1].injected.map((files) => [...files]), [WORKDAY_FILES]);
  assert.deepEqual(tabs[2].injected.map((files) => [...files]), [COMPANY_FILES]);
  assert.ok(fileCalls(page.calls).every((call) => call.world === 'ISOLATED' && call.frameIds[0] === 0));

  page.installed[0]({ reason: 'update' });
  await page.sandbox.injectOpenTabs();
  assert.equal(fileCalls(page.calls).length, 3);

  page.installed[0]({ reason: 'chrome_update' });
  await page.sandbox.injectOpenTabs();
  assert.equal(fileCalls(page.calls).length, 3);
});

test('a tab that already has a healthy widget is not injected again', async () => {
  const tabs = [
    {
      id: 4,
      url: 'https://www.linkedin.com/jobs/search/?currentJobId=4476508048',
      runtimeId: 'ghost-job-detector',
      instance: 'live-widget',
      copyLive: 'alive',
      host: {
        getAttribute(name) {
          return name === 'data-ghd-instance' ? 'live-widget' : null;
        }
      },
      widget: { analyze() {} },
      company: false,
      injected: []
    },
    {
      id: 5,
      url: 'https://argonne.wd1.myworkdayjobs.com/en-US/Argonne_Careers/job/Lemont-IL/Engineer_423470',
      runtimeId: 'ghost-job-detector',
      instance: 'live-widget',
      copyLive: 'alive',
      host: {
        getAttribute(name) {
          return name === 'data-ghd-instance' ? 'live-widget' : null;
        }
      },
      widget: { analyze() {} },
      company: false,
      injected: []
    },
    {
      id: 6,
      url: 'https://www.linkedin.com/company/georgia-tech/',
      runtimeId: 'ghost-job-detector',
      instance: 'live-company',
      copyLive: 'alive',
      widget: undefined,
      company: true,
      injected: []
    }
  ];
  const page = loadBackground(tabs);

  await page.sandbox.injectOpenTabs();
  page.installed[0]({ reason: 'install' });
  await page.sandbox.injectOpenTabs();

  assert.equal(fileCalls(page.calls).length, 0);
  assert.deepEqual(tabs[0].injected, []);
  assert.deepEqual(tabs[1].injected, []);
  assert.deepEqual(tabs[2].injected, []);
  assert.ok(page.calls.length >= 3);
});

test('leftover widget DOM does not skip injection', async () => {
  const orphanHost = {
    getAttribute(name) {
      return name === 'data-ghd-instance' ? 'orphan' : null;
    }
  };
  const tabs = [
    {
      id: 7,
      url: 'https://www.linkedin.com/jobs/view/4475184050',
      runtimeId: 'ghost-job-detector',
      instance: 'orphan',
      copyLive: 'dead',
      host: orphanHost,
      widget: { analyze() {} },
      company: false,
      injected: []
    },
    {
      id: 8,
      url: 'https://www.linkedin.com/jobs/view/4460918631',
      runtimeId: 'ghost-job-detector',
      instance: 'live-widget',
      copyLive: 'alive',
      host: {
        getAttribute(name) {
          return name === 'data-ghd-instance' ? 'someone-else' : null;
        }
      },
      widget: { analyze() {} },
      company: false,
      injected: []
    },
    {
      id: 9,
      url: 'https://www.linkedin.com/jobs/search/?currentJobId=4445720940',
      runtimeId: 'ghost-job-detector',
      instance: '',
      host: orphanHost,
      widget: { analyze() {} },
      company: false,
      injected: []
    }
  ];
  const page = loadBackground(tabs);

  await page.sandbox.injectOpenTabs();

  assert.deepEqual(tabs[0].injected.map((files) => [...files]), [LINKEDIN_FILES]);
  assert.deepEqual(tabs[1].injected.map((files) => [...files]), [LINKEDIN_FILES]);
  assert.deepEqual(tabs[2].injected.map((files) => [...files]), [LINKEDIN_FILES]);
});

test('a probe error still injects, and the reload deletes a stored debug record', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.host_permissions.some((pattern) => pattern.includes('linkedin.com')));
  assert.ok(manifest.host_permissions.some((pattern) => pattern.includes('myworkdayjobs.com')));
  assert.deepEqual(manifest.content_scripts[0].js, LINKEDIN_FILES);
  assert.deepEqual(manifest.content_scripts[1].js, WORKDAY_FILES);
  assert.deepEqual(manifest.content_scripts[2].js, COMPANY_FILES);
  assert.equal(manifest.content_scripts.every((entry) => entry.all_frames === true), false);

  const tabs = [
    {
      id: 11,
      url: 'https://www.linkedin.com/jobs/search/?currentJobId=4475184050',
      runtimeId: 'ghost-job-detector',
      probeReject: 'Cannot access contents of the page',
      company: false,
      injected: []
    }
  ];
  const page = loadBackground(tabs, {
    seed: [{ event: 'old', tabs: [{ host: 'www.linkedin.com', path: '/jobs/search/' }] }],
    framesFor() {
      return [{ frameId: 0 }, { frameId: 7 }];
    }
  });

  await page.sandbox.injectOpenTabs('startup');
  await page.installed[0]({ reason: 'update' });
  await page.installed[0]({ reason: 'chrome_update' });

  assert.deepEqual(tabs[0].injected.map((files) => [...files]), [LINKEDIN_FILES, LINKEDIN_FILES]);
  assert.deepEqual(page.debug, []);
  assert.deepEqual(page.debugWrites, []);
});

test('a probe that cannot see the content-script copy does not call a host healthy', async () => {
  const tabs = [
    {
      id: 12,
      url: 'https://www.linkedin.com/jobs/view/4475184050',
      runtimeId: 'ghost-job-detector',
      instance: 'orphan',
      host: {
        getAttribute(name) {
          return name === 'data-ghd-instance' ? 'orphan' : null;
        }
      },
      widget: { analyze() {} },
      company: false,
      injected: []
    }
  ];
  const page = loadBackground(tabs);

  await page.sandbox.injectOpenTabs('startup');

  assert.deepEqual(tabs[0].injected.map((files) => [...files]), [LINKEDIN_FILES]);
  assert.deepEqual(page.debug, []);
  assert.deepEqual(page.debugWrites, []);
});

test('headcount, job page, and widget ignore a second injection', () => {
  const headcount = { console, URL, chrome: { runtime: { id: 'ghost-job-detector' } } };
  headcount.globalThis = headcount;
  vm.createContext(headcount);
  const headcountSource = readFileSync(new URL('../lib/company-headcount.js', import.meta.url), 'utf8');
  vm.runInContext(headcountSource, headcount);
  const firstHeadcount = headcount.GhdHeadcount;
  vm.runInContext(headcountSource, headcount);
  assert.equal(headcount.GhdHeadcount, firstHeadcount);
  assert.equal(headcount.__GHD_HEADCOUNT__, true);

  const pages = { console, URL, chrome: { runtime: { id: 'ghost-job-detector' } } };
  pages.globalThis = pages;
  vm.createContext(pages);
  const pageSource = readFileSync(new URL('../lib/job-page.js', import.meta.url), 'utf8');
  vm.runInContext(pageSource, pages);
  const firstPage = pages.GhdPage;
  vm.runInContext(pageSource, pages);
  assert.equal(pages.GhdPage, firstPage);
  assert.equal(pages.__GHD_PAGE__, true);

  const widget = {
    console: { info() {}, warn() {} },
    URL,
    setTimeout,
    clearTimeout,
    setInterval(fn, delay, ...args) {
      const timer = global.setInterval(fn, delay, ...args);
      timer.unref?.();
      return timer;
    },
    clearInterval(timer) {
      global.clearInterval(timer);
    },
    chrome: { runtime: { id: 'ghost-job-detector' } },
    document: { querySelectorAll() { return []; } }
  };
  widget.globalThis = widget;
  vm.createContext(widget);
  const widgetSource = readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8');
  vm.runInContext(widgetSource, widget);
  const firstWidget = widget.GhdWidget;
  vm.runInContext(widgetSource, widget);
  assert.equal(widget.GhdWidget, firstWidget);
  assert.equal(typeof firstWidget.analyze, 'function');
});

test('a dead copy flag does not stop a new library copy', () => {
  function loadDead(file, flag, liveName, apiName) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const sandbox = {
      console,
      URL,
      chrome: { runtime: { id: 'ghost-job-detector' } }
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox[flag] = true;
    sandbox[liveName] = function deadCopy() {
      throw new Error('Extension context invalidated');
    };
    sandbox[apiName] = { stale: true };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    assert.notEqual(sandbox[apiName].stale, true);
    assert.equal(sandbox[liveName](), true);
    return sandbox;
  }

  const headcount = loadDead('lib/company-headcount.js', '__GHD_HEADCOUNT__', '__GHD_HEADCOUNT_LIVE__', 'GhdHeadcount');
  assert.equal(typeof headcount.GhdHeadcount.slugFromUrl, 'function');
  const pages = loadDead('lib/job-page.js', '__GHD_PAGE__', '__GHD_PAGE_LIVE__', 'GhdPage');
  assert.equal(typeof pages.GhdPage.parseJobPage, 'function');
  const pay = loadDead('lib/pay.js', '__GHD_PAY__', '__GHD_PAY_LIVE__', 'GhdPay');
  assert.equal(typeof pay.GhdPay.parsePostedPay, 'function');
  const heuristics = loadDead('lib/heuristics.js', '__GHD_HEURISTICS__', '__GHD_HEURISTICS_LIVE__', 'GhostJobHeuristics');
  assert.equal(typeof heuristics.GhostJobHeuristics.analyzeJob, 'function');
});

test('an install deletes a stored debug record and does not write one', async () => {
  const seed = Array.from({ length: 20 }, (_, index) => ({
    time: String(index),
    event: 'old',
    tabs: []
  }));
  const page = loadBackground([], { seed });

  await page.sandbox.injectOpenTabs('startup');
  await page.installed[0]({ reason: 'install' });

  assert.deepEqual(page.debug, []);
  assert.deepEqual(page.debugWrites, []);
});

test('FETCH_TEXT is not handled', () => {
  const page = loadBackground([]);
  const listener = page.messages[0];
  let responded = false;

  const handled = listener({ type: 'FETCH_TEXT', url: 'https://www.linkedin.com/jobs/view/1' }, {}, () => {
    responded = true;
  });

  assert.equal(handled, false);
  assert.equal(responded, false);
  assert.equal(readFileSync(new URL('../background.js', import.meta.url), 'utf8').includes('FETCH_TEXT'), false);
});
