const API_BASE_KEY = 'ghd_api_base';
const STORAGE_VERSION = '1.1.10';

document.addEventListener('DOMContentLoaded', init);

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

function isAllowedApiBase(value) {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return url.protocol === 'https:' || (url.protocol === 'http:' && local);
  } catch {
    return false;
  }
}

async function init() {
  await migrateStorage();
  const input = document.getElementById('apiBaseInput');
  const status = document.getElementById('apiBaseStatus');
  const stored = await chrome.storage.local.get(API_BASE_KEY);
  input.value = stored[API_BASE_KEY] || '';

  document.getElementById('saveApiBase').addEventListener('click', async () => {
    const next = String(input.value || '').trim().replace(/\/$/, '');

    if (next && !isAllowedApiBase(next)) {
      status.textContent = 'Use an https URL, or http://localhost for local development.';
      return;
    }

    await chrome.storage.local.set({ [API_BASE_KEY]: next });
    status.textContent = next ? 'Saved. The job-page widget will use this backend.' : 'Cleared. The default backend will be used.';
  });
}
