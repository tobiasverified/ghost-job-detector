import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const widgetSource = readFileSync(new URL('../lib/widget.js', import.meta.url), 'utf8');
const contentSource = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const jobPageSource = readFileSync(new URL('../lib/job-page.js', import.meta.url), 'utf8');
const heuristicsSource = readFileSync(new URL('../lib/heuristics.js', import.meta.url), 'utf8');

function collectText(node) {
  const kids = (node.children || []).map((child) => collectText(child)).join(' ');
  return `${node.ownText || ''} ${kids}`.replace(/\s+/g, ' ').trim();
}

function splitSelectors(selector) {
  return String(selector).split(',').map((part) => part.trim()).filter(Boolean);
}

function matchesOne(node, raw) {
  let selector = String(raw || '').trim();

  if (!selector || selector.startsWith(':scope')) {
    return false;
  }

  if (selector === '*') {
    return true;
  }

  const attrs = [];
  selector = selector.replace(/\[([^\]*=\s]+)(?:(\*)?=("([^"]*)"|'([^']*)'))?\]/g, (_, name, star, _quoted, doubleQuoted, singleQuoted) => {
    attrs.push({
      name,
      contains: star === '*',
      value: doubleQuoted ?? singleQuoted ?? null
    });
    return '';
  });

  const idMatch = selector.match(/#([A-Za-z0-9_-]+)/);
  const id = idMatch ? idMatch[1] : '';
  selector = selector.replace(/#[A-Za-z0-9_-]+/g, '');
  const classes = [];
  selector = selector.replace(/\.([A-Za-z0-9_-]+)/g, (_, className) => {
    classes.push(className);
    return '';
  });
  const tag = selector.trim().toLowerCase();

  if (tag && String(node.tagName || '').toLowerCase() !== tag) {
    return false;
  }

  if (id && node.id !== id) {
    return false;
  }

  const classList = String(node.className || '').split(/\s+/).filter(Boolean);

  if (classes.some((className) => !classList.includes(className))) {
    return false;
  }

  for (const attr of attrs) {
    const value = node.getAttribute(attr.name);

    if (value == null) {
      return false;
    }

    if (attr.value == null) {
      continue;
    }

    if (attr.contains ? !String(value).includes(attr.value) : String(value) !== attr.value) {
      return false;
    }
  }

  return true;
}

function matches(node, selector) {
  return splitSelectors(selector).some((part) => matchesOne(node, part));
}

function createDocument() {
  const document = {
    documentElement: null,
    body: null,
    createElement(tag) {
      return createNode(tag);
    },
    createElementNS(_namespace, tag) {
      return createNode(tag);
    },
    querySelector(selector) {
      return queryAll(document.documentElement, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(document.documentElement, selector);
    },
    getElementById(id) {
      return walk(document.documentElement).find((node) => node.isConnected && node.id === id) || null;
    }
  };

  function createNode(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      id: '',
      className: '',
      href: '',
      ownText: '',
      markup: '',
      attrs: {},
      dataset: {},
      style: {},
      children: [],
      parentElement: null,
      isConnected: false,
      shadowRoot: null,
      setAttribute(name, value) {
        const text = String(value);
        this.attrs[name] = text;

        if (name === 'id') {
          this.id = text;
        }

        if (name === 'class') {
          this.className = text;
        }

        if (name === 'href') {
          this.href = text;
        }
      },
      getAttribute(name) {
        if (name === 'id') {
          return this.id || null;
        }

        if (name === 'class') {
          return this.className || null;
        }

        if (name === 'href') {
          return this.href || this.attrs.href || null;
        }

        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        markConnected(child, this.isConnected);
        return child;
      },
      append(...children) {
        children.forEach((child) => this.appendChild(child));
      },
      remove() {
        this.isConnected = false;

        if (this.parentElement) {
          this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
          this.parentElement = null;
        }
      },
      closest(selector) {
        let current = this;

        while (current) {
          if (matches(current, selector)) {
            return current;
          }

          current = current.parentElement;
        }

        return null;
      },
      contains(other) {
        let current = other;

        while (current) {
          if (current === this) {
            return true;
          }

          current = current.parentElement;
        }

        return false;
      },
      querySelector(selector) {
        return queryAll(this, selector)[0] || null;
      },
      querySelectorAll(selector) {
        return queryAll(this, selector);
      },
      getElementById(id) {
        return walk(this).find((child) => child.id === id) || null;
      },
      getRootNode() {
        return this;
      },
      attachShadow() {
        this.shadowRoot = createNode('shadow');
        this.shadowRoot.isConnected = true;
        return this.shadowRoot;
      },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 10, height: 10 };
      },
      setPointerCapture() {}
    };

    Object.defineProperty(node, 'innerText', {
      get() {
        return collectText(this);
      }
    });
    Object.defineProperty(node, 'textContent', {
      get() {
        return this.ownText || collectText(this);
      },
      set(value) {
        this.ownText = String(value ?? '');
      }
    });
    Object.defineProperty(node, 'innerHTML', {
      get() {
        return this.markup || '';
      },
      set(value) {
        this.markup = String(value ?? '');
      }
    });

    return node;
  }

  function markConnected(node, connected) {
    node.isConnected = connected;

    for (const child of node.children || []) {
      markConnected(child, connected);
    }
  }

  function walk(node, found = []) {
    for (const child of node?.children || []) {
      if (child.isConnected !== false) {
        found.push(child);
        walk(child, found);
      }

      if (child.shadowRoot) {
        walk(child.shadowRoot, found);
      }
    }

    return found;
  }

  function queryAll(root, selector) {
    const text = String(selector).trim();

    if (text.includes(':scope')) {
      const found = [];

      for (const part of splitSelectors(text)) {
        const childSelector = part.replace(/^:scope\s*>\s*/, '');

        for (const child of root.children || []) {
          if (child.isConnected !== false && matchesOne(child, childSelector)) {
            found.push(child);
          }
        }
      }

      return found;
    }

    return walk(root).filter((node) => matches(node, text));
  }

  document.documentElement = createNode('html');
  document.documentElement.isConnected = true;
  document.body = createNode('body');
  document.documentElement.appendChild(document.body);
  return { document, createNode };
}

function installPage(saved) {
  const { document } = createDocument();
  const description = 'You will advise customers on products and stock shelves for each shift of the week with specific duties, a posted schedule, and a store location that is already chosen. ';
  const details = document.createElement('div');
  details.id = 'job-details';
  const heading = document.createElement('h1');
  heading.textContent = 'Beauty Advisor';
  const company = document.createElement('a');
  company.href = 'https://www.linkedin.com/company/ulta-beauty/';
  company.textContent = 'Ulta Beauty';
  const body = document.createElement('div');
  body.className = 'show-more-less-html__markup';
  body.textContent = description.repeat(3);
  details.append(heading, company, body);

  const list = document.createElement('div');
  list.className = 'scaffold-layout__list';
  const card = document.createElement('li');
  card.setAttribute('data-occludable-job-id', '4475184050');
  const link = document.createElement('a');
  link.href = 'https://www.linkedin.com/jobs/view/4475184050';
  link.setAttribute('aria-label', 'Beauty Advisor at Ulta Beauty');
  const cardTitle = document.createElement('h3');
  cardTitle.textContent = 'Beauty Advisor';
  link.appendChild(cardTitle);
  const cardCompany = document.createElement('div');
  cardCompany.className = 'job-card-container__primary-description';
  cardCompany.textContent = 'Ulta Beauty';
  card.append(link, cardCompany);
  list.appendChild(card);
  document.body.append(list, details);

  class MutationObserver {
    observe() {}
    disconnect() {}
  }

  const sandbox = {
    URL,
    console: { info() {}, warn() {}, log() {}, error() {} },
    setTimeout(fn, delay, ...args) {
      const timer = global.setTimeout(fn, delay, ...args);
      timer.unref?.();
      return timer;
    },
    clearTimeout,
    setInterval(fn, delay, ...args) {
      const timer = global.setInterval(fn, delay, ...args);
      timer.unref?.();
      return timer;
    },
    clearInterval(timer) {
      global.clearInterval(timer);
    },
    MutationObserver,
    Element: class Element {},
    ShadowRoot: class ShadowRoot {},
    location: {
      href: 'https://www.linkedin.com/jobs/search/?currentJobId=4475184050',
      hostname: 'www.linkedin.com',
      pathname: '/jobs/search/'
    },
    document,
    getComputedStyle() {
      return { position: 'relative' };
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async (items) => {
            saved.push(items);
          }
        }
      },
      runtime: {
        id: 'ghost-job-detector',
        sendMessage() {
          return Promise.resolve();
        },
        onMessage: {
          addListener() {},
          removeListener() {}
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, document };
}

function loadCopy(sandbox) {
  vm.runInContext(jobPageSource, sandbox);
  vm.runInContext(heuristicsSource, sandbox);
  vm.runInContext(widgetSource, sandbox);
  vm.runInContext(contentSource, sandbox);
}

test('an orphaned teardown leaves the new widget and badges in place', async () => {
  const oldSaved = [];
  const newSaved = [];
  const oldPage = installPage(oldSaved);
  loadCopy(oldPage.sandbox);
  await wait(400);

  const oldId = oldPage.sandbox.__GHD_INSTANCE__;
  const oldHost = oldPage.document.getElementById('ghd-widget-host');
  const oldBadges = oldPage.document.querySelectorAll('.ghd-badge');
  assert.equal(oldHost?.getAttribute('data-ghd-instance'), oldId);
  assert.ok(oldBadges.length >= 1);
  assert.ok(oldBadges.every((badge) => badge.getAttribute('data-ghd-instance') === oldId));

  const foreignStyle = oldPage.document.createElement('style');
  foreignStyle.setAttribute('data-ghd-instance', 'foreign-style');
  const bareBadge = oldPage.document.createElement('button');
  bareBadge.className = 'ghd-badge';
  oldPage.document.body.append(foreignStyle, bareBadge);

  const newPage = installPage(newSaved);
  newPage.document = oldPage.document;
  newPage.sandbox.document = oldPage.document;
  loadCopy(newPage.sandbox);
  await wait(400);

  const newId = newPage.sandbox.__GHD_INSTANCE__;
  assert.notEqual(newId, oldId);
  assert.equal(foreignStyle.isConnected, false);
  assert.equal(bareBadge.isConnected, false);
  assert.equal(oldHost.isConnected, false);

  const newHost = newPage.document.getElementById('ghd-widget-host');
  const newBadges = newPage.document.querySelectorAll('.ghd-badge');
  assert.equal(newHost?.getAttribute('data-ghd-instance'), newId);
  assert.equal(newHost.isConnected, true);
  assert.ok(newBadges.length >= 1);
  assert.ok(newBadges.every((badge) => badge.getAttribute('data-ghd-instance') === newId));
  assert.ok(newSaved.some((items) => items.ghd_current_job?.title === 'Beauty Advisor' && items.ghd_current_job?.company === 'Ulta Beauty'));
  assert.match(newHost.shadowRoot.querySelector('div').innerHTML, /Ghost Job Detector|Analyzing this job|Not yet checked/);
  const style = newHost.shadowRoot.children.find((node) => node.tagName === 'STYLE');
  assert.equal(style?.getAttribute('data-ghd-instance'), newId);

  const decoy = newPage.document.createElement('button');
  decoy.className = 'ghd-badge';
  decoy.setAttribute('data-ghd-instance', 'still-here');
  newPage.document.body.appendChild(decoy);

  oldPage.sandbox.chrome.runtime.id = undefined;
  await wait(2500);

  assert.equal(newPage.document.getElementById('ghd-widget-host'), newHost);
  assert.equal(newHost.isConnected, true);
  assert.equal(newHost.getAttribute('data-ghd-instance'), newId);
  assert.ok(newBadges.every((badge) => badge.isConnected));
  assert.equal(decoy.isConnected, true);

  const widget = newPage.sandbox.GhdWidget;
  vm.runInContext(widgetSource, newPage.sandbox);
  vm.runInContext(contentSource, newPage.sandbox);
  const hosts = newPage.document.querySelectorAll('#ghd-widget-host');
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0], newHost);
  assert.equal(newPage.sandbox.GhdWidget, widget);
});
