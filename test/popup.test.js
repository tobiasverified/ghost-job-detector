import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  OPEN_A_JOB,
  READY_ON_PAGE,
  feedbackBody,
  feedbackMailto,
  formatExtensionVersion,
  init,
  pageStatusText,
  renderPopupLinks
} from '../popup/popup.js';

const require = createRequire(import.meta.url);
require('../lib/api-base.js');

function createElement(tag) {
  return {
    tag,
    children: [],
    attrs: {},
    className: '',
    textContent: '',
    href: '',
    target: '',
    rel: '',
    append(...nodes) {
      this.children.push(...nodes);
    }
  };
}

function createRoot() {
  const root = {
    children: [],
    replaceChildren() {
      this.children = [];
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    querySelectorAll(selector) {
      const found = [];

      function walk(node) {
        if (node.tag === selector) {
          found.push(node);
        }

        for (const child of node.children || []) {
          walk(child);
        }
      }

      for (const child of this.children) {
        walk(child);
      }

      return found;
    }
  };

  globalThis.document = { createElement };
  return root;
}

test('the popup renders no link for an empty constant', () => {
  const root = createRoot();

  renderPopupLinks(root, {
    supportEmail: '',
    githubUrl: '',
    privacyUrl: '',
    version: '1.1.10'
  });
  assert.equal(root.querySelectorAll('a').length, 0);

  renderPopupLinks(root, {
    supportEmail: 'help@example.com',
    githubUrl: '',
    privacyUrl: '',
    version: '1.1.10'
  });
  assert.deepEqual(root.querySelectorAll('a').map((link) => link.textContent), ['Report a problem']);
  assert.equal(root.children.some((node) => node.textContent === 'help@example.com'), true);

  renderPopupLinks(root, {
    supportEmail: '',
    githubUrl: 'https://github.com/example/ghost-job-detector',
    privacyUrl: '',
    version: '1.1.10'
  });
  const github = root.querySelectorAll('a');
  assert.deepEqual(github.map((link) => link.textContent), ['GitHub']);
  assert.equal(github[0].target, '_blank');
  assert.equal(github[0].rel, 'noopener');

  renderPopupLinks(root, {
    supportEmail: '',
    githubUrl: '',
    privacyUrl: 'https://example.com/privacy',
    version: '1.1.10'
  });
  const privacy = root.querySelectorAll('a');
  assert.deepEqual(privacy.map((link) => link.textContent), ['Privacy policy']);
  assert.equal(privacy[0].target, '_blank');
  assert.equal(privacy[0].rel, 'noopener');
});

test('the report link is a static feedback template', () => {
  const href = feedbackMailto('help@example.com', '1.1.10');
  const parsed = new URL(href);

  assert.equal(parsed.protocol, 'mailto:');
  assert.equal(parsed.pathname, 'help@example.com');
  assert.equal(parsed.searchParams.get('subject'), 'Ghost Job Detector feedback (v1.1.10)');
  assert.equal(parsed.searchParams.get('body'), feedbackBody());
  assert.equal(feedbackBody().includes('What happened:'), true);
  assert.equal(feedbackBody().includes('Which site (LinkedIn or Workday):'), true);
  assert.equal(feedbackBody().includes('What you expected:'), true);
  assert.equal(/https?:|linkedin\.com\/jobs|myworkdayjobs/i.test(feedbackBody()), false);
});

test('the popup explains the check and hides the backend until Advanced is opened', () => {
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const advanced = html.slice(html.indexOf('<summary>Advanced</summary>'), html.indexOf('</details>', html.indexOf('<summary>Advanced</summary>')));

  assert.match(html, /<img class="app-icon" src="\.\.\/icons\/icon48\.png"/);
  assert.equal(html.includes('👻'), false);
  assert.match(html, /<h1 class="app-title">Ghost Job Detector<\/h1>/);
  assert.match(html, /id="extensionVersion"/);
  assert.equal(html.includes('Shows warning signs, not proof. A clean result can\'t confirm a role is real.'), true);
  assert.equal(html.includes('Sends the job title, company, location and description text to our server to run checks.'), true);
  assert.deepEqual(html.match(/<details\b[^>]*>/g), [
    '<details class="popup-details">',
    '<details class="popup-details">'
  ]);
  assert.deepEqual(
    ['Reposts', 'Layoffs coverage', 'Glassdoor rating', 'Description clarity'].map((item) => html.includes(`<li>${item}</li>`)),
    [true, true, true, true]
  );
  assert.equal(advanced.includes('Backend URL'), true);
  assert.equal(advanced.includes('Developer mode'), true);
  assert.equal(advanced.includes('id="developerMode"'), true);
  assert.equal(advanced.includes('Job text will be sent to that server.'), true);
  assert.equal(advanced.includes('Reset to default'), true);
  assert.equal(html.indexOf('Backend URL') > html.indexOf('<summary>Advanced</summary>'), true);
  assert.equal(/<button\b[^>]*>[^<]*run check/i.test(html), false);
  assert.equal(html.includes('ghostScore'), false);
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(source), false);
});

test('the status line follows the active tab', () => {
  assert.equal(pageStatusText('https://www.linkedin.com/jobs/view/4476508048'), READY_ON_PAGE);
  assert.equal(pageStatusText('https://www.linkedin.com/jobs/search?currentJobId=4476508048'), READY_ON_PAGE);
  assert.equal(pageStatusText('https://linkedin.com/jobs/view/1'), READY_ON_PAGE);
  assert.equal(pageStatusText('https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/Role_1'), READY_ON_PAGE);
  assert.equal(pageStatusText('https://www.linkedin.com/company/acme'), OPEN_A_JOB);
  assert.equal(pageStatusText('https://www.linkedin.com/feed/'), OPEN_A_JOB);
  assert.equal(pageStatusText('https://example.com/jobs/1'), OPEN_A_JOB);
  assert.equal(pageStatusText(''), OPEN_A_JOB);
});

test('the version line is the manifest version', () => {
  assert.equal(formatExtensionVersion('1.1.10'), 'v1.1.10');
  assert.equal(formatExtensionVersion(''), '');
});

test('a declined backend permission says the default server is still in use', async () => {
  const elements = {};

  function element(id) {
    const node = {
      id,
      value: '',
      textContent: '',
      checked: false,
      children: [],
      replaceChildren() {
        this.children = [];
      },
      append() {},
      addEventListener(type, fn) {
        node[type] = fn;
      }
    };
    elements[id] = node;
    return node;
  }

  for (const id of ['apiBaseInput', 'apiBaseStatus', 'developerMode', 'extensionVersion', 'pageStatus', 'popupLinks', 'saveApiBase', 'resetApiBase']) {
    element(id);
  }

  const stored = { ghd_api_base: 'https://jobs.example.com', ghd_developer_mode: true, ghd_storage_version: '1.1.10' };

  globalThis.document = {
    getElementById(id) {
      return elements[id];
    },
    createElement
  };
  globalThis.chrome = {
    runtime: {
      getManifest() {
        return { version: '1.1.10' };
      }
    },
    tabs: {
      async query() {
        return [];
      }
    },
    storage: {
      local: {
        async get() {
          return stored;
        },
        async set(values) {
          Object.assign(stored, values);
        },
        async remove(key) {
          delete stored[key];
        },
        async clear() {}
      }
    },
    permissions: {
      async request() {
        return false;
      },
      async remove() {}
    }
  };

  await init();
  elements.developerMode.checked = true;
  elements.apiBaseInput.value = 'https://other.example.com';
  await elements.saveApiBase.click();

  assert.equal(elements.apiBaseStatus.textContent, 'Permission was declined, so the default server is still in use');
  assert.equal(elements.apiBaseInput.value, '');
  assert.equal(Object.hasOwn(stored, 'ghd_api_base'), false);
});
