import { GITHUB_URL, PRIVACY_URL, SUPPORT_EMAIL } from './config.js';

const STORAGE_VERSION = '1.1.10';

function apiBaseApi() {
  const api = globalThis.GhdApiBase;

  if (!api) {
    throw new Error('Backend URL checker is not loaded.');
  }

  return api;
}

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

export function apiBaseDecision(value, options) {
  return apiBaseApi().apiBaseDecision(value, options);
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

  const apiBaseKey = apiBaseApi().API_BASE_KEY;
  const developerModeKey = apiBaseApi().DEVELOPER_MODE_KEY;

  if (stored[apiBaseKey]) {
    next[apiBaseKey] = stored[apiBaseKey];
  }

  if (stored[developerModeKey] === true) {
    next[developerModeKey] = true;
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

function storagePort() {
  return {
    async set(values) {
      await chrome.storage.local.set(values);
    },
    async remove(key) {
      await chrome.storage.local.remove(key);
    }
  };
}

export async function init() {
  await migrateStorage();
  const api = apiBaseApi();
  const input = document.getElementById('apiBaseInput');
  const status = document.getElementById('apiBaseStatus');
  const developerMode = document.getElementById('developerMode');
  const stored = await chrome.storage.local.get([api.API_BASE_KEY, api.DEVELOPER_MODE_KEY]);
  input.value = stored[api.API_BASE_KEY] || '';
  developerMode.checked = stored[api.DEVELOPER_MODE_KEY] === true;
  document.getElementById('extensionVersion').textContent = formatExtensionVersion(extensionVersion());
  document.getElementById('pageStatus').textContent = pageStatusText(await activeTabUrl());

  const storedOrigin = api.acceptedApiOrigin(input.value, { developerMode: developerMode.checked });

  if (input.value && !storedOrigin) {
    status.textContent = api.apiBaseDecision(input.value, { developerMode: developerMode.checked }).message;
  }

  renderPopupLinks(document.getElementById('popupLinks'), {
    supportEmail: SUPPORT_EMAIL,
    githubUrl: GITHUB_URL,
    privacyUrl: PRIVACY_URL,
    version: extensionVersion()
  });

  document.getElementById('saveApiBase').addEventListener('click', async () => {
    const previousStored = await chrome.storage.local.get(api.API_BASE_KEY);
    const previous = api.acceptedApiOrigin(previousStored[api.API_BASE_KEY], { developerMode: true });
    const result = await api.applyApiBaseChoice(input.value, {
      developerMode: developerMode.checked,
      storage: storagePort(),
      requestPermission(permission) {
        return chrome.permissions.request(permission);
      }
    });

    if ((result.saved || result.requested) && previous && previous !== result.base && previous !== api.DEFAULT_API_ORIGIN && !api.isLocalOrigin(previous)) {
      try {
        await chrome.permissions.remove({ origins: [`${previous}/*`] });
      } catch {
        // The grant may already be gone.
      }
    }

    status.textContent = result.message;

    if (result.saved) {
      input.value = result.base;
    } else if (result.requested) {
      input.value = '';
    }
  });

  document.getElementById('resetApiBase').addEventListener('click', async () => {
    input.value = '';
    await chrome.storage.local.remove(api.API_BASE_KEY);
    status.textContent = 'Reset. The default backend will be used.';
  });
}
