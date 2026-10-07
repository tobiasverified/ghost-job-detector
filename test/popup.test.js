import assert from 'node:assert/strict';
import test from 'node:test';
import { feedbackBody, feedbackMailto, renderPopupLinks } from '../popup/popup.js';

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
