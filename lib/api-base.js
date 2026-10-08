(function (root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.GhdApiBase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_API_BASE = 'https://ghost-job-detector-nine.vercel.app';
  const DEFAULT_API_ORIGIN = 'https://ghost-job-detector-nine.vercel.app';
  const API_BASE_KEY = 'ghd_api_base';
  const DEVELOPER_MODE_KEY = 'ghd_developer_mode';

  function isLocalHost(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1';
  }

  function isLocalOrigin(origin) {
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && isLocalHost(url.hostname);
    } catch {
      return false;
    }
  }

  function rejectionMessage(value, developerMode) {
    let url;

    try {
      url = new URL(String(value || '').trim());
    } catch {
      return 'That is not a valid URL. Use the default backend, http://localhost, or http://127.0.0.1.';
    }

    if (url.username || url.password) {
      return 'Remove the username and password from the URL.';
    }

    if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
      return 'http is only allowed for localhost and 127.0.0.1.';
    }

    if (url.protocol === 'https:' && url.origin !== DEFAULT_API_ORIGIN && !developerMode) {
      return 'That host is not the default backend. Turn on Developer mode to use another https server.';
    }

    return 'That URL cannot be used. Use the default backend, http://localhost, or http://127.0.0.1.';
  }

  // Origin of a backend the extension may call. Empty when the value is refused.
  function acceptedApiOrigin(value, options = {}) {
    const developerMode = options.developerMode === true;
    let url;

    try {
      url = new URL(String(value || '').trim());
    } catch {
      return '';
    }

    if (url.username || url.password) {
      return '';
    }

    if (url.origin === DEFAULT_API_ORIGIN && url.protocol === 'https:') {
      return url.origin;
    }

    if (url.protocol === 'http:' && isLocalHost(url.hostname)) {
      return url.origin;
    }

    if (developerMode && url.protocol === 'https:' && url.hostname) {
      return url.origin;
    }

    return '';
  }

  function apiBaseDecision(value, options = {}) {
    const developerMode = options.developerMode === true;
    const next = String(value || '').trim();

    if (!next) {
      return {
        action: 'clear',
        value: '',
        origin: '',
        needsPermission: false,
        message: ''
      };
    }

    const origin = acceptedApiOrigin(next, { developerMode });

    if (!origin) {
      return {
        action: 'reject',
        value: next,
        origin: '',
        needsPermission: false,
        message: rejectionMessage(next, developerMode)
      };
    }

    const needsPermission = origin !== DEFAULT_API_ORIGIN && !isLocalOrigin(origin);

    return {
      action: 'save',
      value: origin,
      origin,
      needsPermission,
      message: ''
    };
  }

  function resolveStoredApiBase(value, options = {}) {
    return acceptedApiOrigin(value, options) || DEFAULT_API_BASE;
  }

  async function applyApiBaseChoice(value, options = {}) {
    const developerMode = options.developerMode === true;
    const decision = apiBaseDecision(value, { developerMode });
    const storage = options.storage;

    if (decision.action === 'reject') {
      await storage.set({ [DEVELOPER_MODE_KEY]: developerMode });
      return { requested: false, saved: false, base: '', message: decision.message };
    }

    if (decision.action === 'clear') {
      await storage.remove(API_BASE_KEY);
      await storage.set({ [DEVELOPER_MODE_KEY]: developerMode });
      return {
        requested: false,
        saved: true,
        base: '',
        message: 'Cleared. The default backend will be used.'
      };
    }

    if (decision.needsPermission) {
      const granted = await options.requestPermission({ origins: [`${decision.origin}/*`] });

      if (granted !== true) {
        await storage.remove(API_BASE_KEY);
        await storage.set({ [DEVELOPER_MODE_KEY]: developerMode });
        return {
          requested: true,
          saved: false,
          base: DEFAULT_API_BASE,
          message: 'Permission was declined, so the default server is still in use'
        };
      }
    }

    await storage.set({
      [API_BASE_KEY]: decision.origin,
      [DEVELOPER_MODE_KEY]: developerMode
    });

    return {
      requested: decision.needsPermission,
      saved: true,
      base: decision.origin,
      message: decision.origin === DEFAULT_API_ORIGIN
        ? 'Saved. The job-page widget will use the default backend.'
        : 'Saved. The job-page widget will use this backend.'
    };
  }

  return {
    API_BASE_KEY,
    DEVELOPER_MODE_KEY,
    DEFAULT_API_BASE,
    DEFAULT_API_ORIGIN,
    acceptedApiOrigin,
    apiBaseDecision,
    applyApiBaseChoice,
    isLocalOrigin,
    resolveStoredApiBase
  };
});
