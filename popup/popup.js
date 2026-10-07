import { GITHUB_URL, PRIVACY_URL, SUPPORT_EMAIL } from './config.js';

const API_BASE_KEY = 'ghd_api_base';
const STORAGE_VERSION = '1.1.10';

function filled(value) {
  return String(value || '').trim();
}

export function feedbackBody() {
  return [
    'What happened:',
    '',
    'Which site (LinkedIn or Workday):',
    '',
    'What you expected:',
    ''
  ].join('\n');
}

export function feedbackMailto(email, version) {
  const subject = `Ghost Job Detector feedback (v${version})`;
  const mailbox = filled(email).split('@').map((part) => encodeURIComponent(part)).join('@');
  return `mailto:${mailbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(feedbackBody())}`;
}

export function renderPopupLinks(root, { supportEmail = '', githubUrl = '', privacyUrl = '', version = '' } = {}) {
  const email = filled(supportEmail);
  const github = filled(githubUrl);
  const privacy = filled(privacyUrl);

  if (typeof root.replaceChildren === 'function') {
    root.replaceChildren();
  }

  if (email) {
    const link = document.createElement('a');
    link.href = feedbackMailto(email, version);
    link.textContent = 'Report a problem';
    const address = document.createElement('p');
    address.className = 'popup-address';
    address.textContent = email;
    root.append(link, address);
  }

  if (github) {
    const link = document.createElement('a');
    link.href = github;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'GitHub';
    root.append(link);
  }

  if (privacy) {
    const link = document.createElement('a');
    link.href = privacy;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Privacy policy';
    root.append(link);
  }
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version || '';
  } catch {
    return '';
  }
}

export const READY_ON_PAGE = 'Ready on this page';
export const OPEN_A_JOB = 'Open a LinkedIn or Workday job to see the widget.';

export function isSupportedJobPage(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();

  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    return url.pathname.includes('/jobs/');
  }

  return host.endsWith('.myworkdayjobs.com');
}

export function pageStatusText(rawUrl) {
  return isSupportedJobPage(rawUrl) ? READY_ON_PAGE : OPEN_A_JOB;
}

export function formatExtensionVersion(version) {
  const text = String(version || '').trim();
  return text ? `v${text}` : '';
}

export function normalizeApiBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

export function isAllowedApiBase(value) {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local);
  } catch {
    return false;
  }
}

export function apiBaseDecision(value) {
  const next = normalizeApiBase(value);

  if (!next) {
    return { action: 'clear', value: '' };
  }

  if (!isAllowedApiBase(next)) {
    return { action: 'reject', value: next };
  }

  return { action: 'save', value: next };
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

async function migrateStorage() {
  const stored = await chrome.storage.local.get(null);

  if (stored.ghd_storage_version === STORAGE_VERSION) {
    return;
  }

  const next = { ghd_storage_version: STORAGE_VERSION };

  if (stored[API_BASE_KEY]) {
    next[API_BASE_KEY] = stored[API_BASE_KEY];
  }

  if (stored.ghd_widget_pos) {
    next.ghd_widget_pos = stored.ghd_widget_pos;
  }

  for (const [key, value] of Object.entries(stored)) {
    if (/^ghd_(co|search|review|job|layoff|company|rate|repost):/.test(key) || key.startsWith('linkedin_repost_')) {
      next[key] = value;
    }
  }

  await chrome.storage.local.clear();
  await chrome.storage.local.set(next);
}

async function activeTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0]?.url || '';
  } catch {
    return '';
  }
}

async function init() {
  await migrateStorage();
  const input = document.getElementById('apiBaseInput');
  const status = document.getElementById('apiBaseStatus');
  const stored = await chrome.storage.local.get(API_BASE_KEY);
  input.value = stored[API_BASE_KEY] || '';
  document.getElementById('extensionVersion').textContent = formatExtensionVersion(extensionVersion());
  document.getElementById('pageStatus').textContent = pageStatusText(await activeTabUrl());

  renderPopupLinks(document.getElementById('popupLinks'), {
    supportEmail: SUPPORT_EMAIL,
    githubUrl: GITHUB_URL,
    privacyUrl: PRIVACY_URL,
    version: extensionVersion()
  });

  document.getElementById('saveApiBase').addEventListener('click', async () => {
    const decision = apiBaseDecision(input.value);

    if (decision.action === 'reject') {
      status.textContent = 'Use an https URL, or http://localhost for local development.';
      return;
    }

    await chrome.storage.local.set({ [API_BASE_KEY]: decision.value });
    status.textContent = decision.value ? 'Saved. The job-page widget will use this backend.' : 'Cleared. The default backend will be used.';
  });

  document.getElementById('resetApiBase').addEventListener('click', async () => {
    input.value = '';
    await chrome.storage.local.remove(API_BASE_KEY);
    status.textContent = 'Reset. The default backend will be used.';
  });
}
