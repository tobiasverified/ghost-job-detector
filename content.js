(() => {
  'use strict';

  if (globalThis.__GHD_LINKEDIN__) {
    return;
  }

  globalThis.__GHD_LINKEDIN__ = true;

  const STORAGE_KEY = 'ghd_current_job';
  const platform = 'LINKEDIN';
  const pageApi = globalThis.GhdPage;

  const RETRY_DELAYS = [200, 400, 700, 1200, 2000, 3000, 5000, 8000, 12000];
  const PLATFORM_SELECTORS = [
    '#job-details',
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.show-more-less-html__markup',
    '.jobs-box__html-content',
    '[class*="jobs-box__html"]',
    ...pageApi.LINKEDIN_DETAIL_SELECTORS
  ];
  const RAIL_SELECTORS = [
    '.scaffold-layout__detail',
    '[class*="scaffold-layout__detail"]',
    '.jobs-search__right-rail',
    '[class*="jobs-search__right"]',
    '[class*="jobs-unified-top-card"]'
  ];
  const ARTICLE_SELECTORS = [
    'main article',
    'main [role="document"]',
    '[role="main"] article',
    'article'
  ];

  let lastUrl = location.href;
  let lastJobId = pageApi.parseJobPage(location.href).jobId || '';
  let retryTimers = [];
  let badgeTimer = null;
  let listObserver = null;
  let detailObserver = null;
  let detailObserverTimer = null;
  let urlTimer = null;
  let lastAnalyzedKey = '';
  let lastDescriptionLength = 0;
  let lastSalaryLength = 0;
  let identityKey = '';
  // A reload or update leaves this script running after chrome.* starts failing.
  const CONTEXT_CHECK_MS = 2000;
  let contextTornDown = false;
  const pendingTimers = new Set();
  const observers = new Set();
  const removeListeners = [];
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeSetInterval = globalThis.setInterval.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
  const NativeMutationObserver = globalThis.MutationObserver;

  function extensionContextInvalidated(error) {
    return /extension context invalidated/i.test(String(error?.message || error || ''));
  }

  function extensionContextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function setTimeout(fn, delay, ...args) {
    if (contextTornDown) {
      return 0;
    }

    const id = nativeSetTimeout(() => {
      pendingTimers.delete(id);

      if (!contextTornDown) {
        fn(...args);
      }
    }, delay);
    pendingTimers.add(id);

    if (typeof id?.unref === 'function') {
      id.unref();
    }

    return id;
  }

  function clearTimeout(id) {
    pendingTimers.delete(id);

    try {
      nativeClearTimeout(id);
    } catch {
      // The timer already fired.
    }
  }

  function setInterval(fn, delay, ...args) {
    if (contextTornDown) {
      return 0;
    }

    const id = nativeSetInterval(() => {
      if (!contextTornDown) {
        fn(...args);
      }
    }, delay);
    pendingTimers.add(id);

    if (typeof id?.unref === 'function') {
      id.unref();
    }

    return id;
  }

  function clearInterval(id) {
    pendingTimers.delete(id);

    try {
      nativeClearInterval(id);
    } catch {
      // The timer is already cleared.
    }
  }

  function MutationObserver(callback) {
    const observer = new NativeMutationObserver((...args) => {
      if (!contextTornDown) {
        callback(...args);
      }
    });
    observers.add(observer);
    return observer;
  }

  function listen(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function' || contextTornDown) {
      return;
    }

    try {
      target.addEventListener(type, handler, options);
      removeListeners.push(() => {
        try {
          target.removeEventListener(type, handler, options);
        } catch {
          // The node is already gone.
        }
      });
    } catch {
      // The page still works without this listener.
    }
  }

  function removeNodes(selector) {
    let nodes = [];

    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      return;
    }

    for (const node of nodes) {
      try {
        node.remove();
      } catch {
        // Already detached.
      }
    }
  }

  function teardownExtensionContext() {
    if (contextTornDown) {
      return;
    }

    contextTornDown = true;

    try {
      removeNodes('#ghd-widget-host');
      removeNodes('.ghd-badge');
    } catch {
      // Removal is best-effort.
    }

    try {
      for (const id of [...pendingTimers]) {
        try {
          nativeClearTimeout(id);
        } catch {
          // Not a timeout.
        }

        try {
          nativeClearInterval(id);
        } catch {
          // Not an interval.
        }
      }

      pendingTimers.clear();
    } catch {
      // Timers are abandoned with the dead context.
    }

    try {
      for (const observer of [...observers]) {
        try {
          observer.disconnect();
        } catch {
          // Already disconnected.
        }
      }

      observers.clear();
    } catch {
      // Observers are abandoned with the dead context.
    }

    try {
      for (const remove of [...removeListeners]) {
        try {
          remove();
        } catch {
          // The listener is already gone.
        }
      }

      removeListeners.length = 0;
    } catch {
      // Listeners are abandoned with the dead context.
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
            }

            throw error;
          }
        );
      }

      return result;
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        teardownExtensionContext();
      }

      throw error;
    }
  }

  function watchExtensionContext() {
    setInterval(() => {
      if (!extensionContextAlive()) {
        teardownExtensionContext();
      }
    }, CONTEXT_CHECK_MS);
  }

  function cleanText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function pageInfo() {
    return pageApi.parseJobPage(location.href);
  }

  function getJobIdFromHref(href) {
    if (!href) {
      return null;
    }

    return pageApi.parseJobPage(href).jobId;
  }

  function getSearchCards() {
    const selector = [
      'li[data-occludable-job-id]',
      'li.jobs-search-results__list-item',
      'li.scaffold-layout__list-item',
      'div.job-card-container',
      'div.base-card',
      '[data-occludable-job-id]',
      '[data-job-id]'
    ].join(',');
    const list = document.querySelector(
      '.scaffold-layout__list, .jobs-search-results-list, [class*="jobs-search-results"]'
    ) || document;
    const fromLinks = [...list.querySelectorAll('a[href*="/jobs/view/"]')].map((link) => {
      return link.closest('li, div.job-card-container, div.base-card, article') || link;
    });
    const nodes = [...list.querySelectorAll(selector), ...fromLinks];

    return nodes.filter((node) => {
      return !nodes.some((other) => other !== node && other.contains(node));
    });
  }

  function cardJobId(card) {
    return (
      card.getAttribute('data-occludable-job-id') ||
      card.getAttribute('data-job-id') ||
      card.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') ||
      card.querySelector('[data-job-id]')?.getAttribute('data-job-id') ||
      pageApi.jobIdFromEntityUrn(card.getAttribute('data-entity-urn')) ||
      pageApi.jobIdFromEntityUrn(card.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn')) ||
      getJobIdFromHref(card.querySelector('a[href*="/jobs/view/"]')?.href)
    );
  }

  function normalizeCompanyName(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function linkedInCompanyId(root = document) {
    const link = root.querySelector?.('a[href*="/company/"]') || document.querySelector('a[href*="/company/"]');
    const numeric = String(link?.href || '').match(/\/company\/(\d+)(?:\/|[?#]|$)/);

    if (numeric) {
      return numeric[1];
    }

    const urn = document.querySelector('[data-entity-urn*="company:"]')?.getAttribute('data-entity-urn') || '';
    return (urn.match(/company:(\d+)/) || [])[1] || '';
  }

  function observeScopedOpenJobs(company) {
    const pageUrl = location.href;
    const companyId = linkedInCompanyId();
    const cards = getSearchCards().map((card) => extractCardJob(card)).filter(Boolean);
    const key = normalizeCompanyName(company);
    const allResultsMatch = cards.length > 0 && cards.every((card) => normalizeCompanyName(card.company) === key);
    const scoped = pageApi.linkedInOpenJobsScoped?.(pageUrl, {
      company,
      companyId,
      allResultsMatch
    }) === true;

    if (!scoped) {
      console.info('[GHD] open jobs page skipped', {
        company,
        reason: 'not company scoped',
        url: pageUrl
      });
    }

    return {
      openJobsCount: scoped ? getObservedOpenJobsCount(company) : null,
      openJobsPageUrl: pageUrl,
      openJobsCompanyId: companyId,
      openJobsAllMatch: allResultsMatch
    };
  }

  function withSearchOpenJobs(job) {
    if (!job || pageInfo().kind !== 'search') {
      return job;
    }

    const observed = observeScopedOpenJobs(job.company);

    return {
      ...enrichJobWithCompanyMetrics(job, observed.openJobsCount),
      openJobsPageUrl: observed.openJobsPageUrl,
      openJobsCompanyId: observed.openJobsCompanyId,
      openJobsAllMatch: observed.openJobsAllMatch
    };
  }

  function getObservedOpenJobsCount(company) {
    if (!company) {
      return null;
    }

    const companyKey = normalizeCompanyName(company);
    const jobIds = new Set();

    for (const card of getSearchCards()) {
      const job = extractCardJob(card);

      if (!job || normalizeCompanyName(job.company) !== companyKey) {
        continue;
      }

      const identifier = job.jobId || job.url;

      if (identifier) {
        jobIds.add(String(identifier));
      }
    }

    return jobIds.size || null;
  }

  function parseEmployeeCount(value) {
    const text = cleanText(value);

    if (!text) {
      return null;
    }

    const rangeMatch = text.match(
      /(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*employees?/i
    );

    if (rangeMatch) {
      const minimum = Number(rangeMatch[1].replace(/,/g, ''));
      const maximum = Number(rangeMatch[2].replace(/,/g, ''));

      return {
        label: `${rangeMatch[1]}-${rangeMatch[2]} employees`,
        minimum,
        maximum,
        estimate: Math.round((minimum + maximum) / 2)
      };
    }

    const plusMatch = text.match(/(\d[\d,]*)\s*\+\s*employees?/i);

    if (plusMatch) {
      const minimum = Number(plusMatch[1].replace(/,/g, ''));

      return {
        label: `${plusMatch[1]}+ employees`,
        minimum,
        maximum: null,
        estimate: minimum
      };
    }

    const singleMatch = text.match(/(\d[\d,]*)\s*employees?/i);

    if (singleMatch) {
      const count = Number(singleMatch[1].replace(/,/g, ''));

      return {
        label: `${count} employees`,
        minimum: count,
        maximum: count,
        estimate: count
      };
    }

    return null;
  }

  function extractEmployeeData() {
    const jsonLdJob = getJsonLdJob();
    const jsonLdEmployees = jsonLdJob?.hiringOrganization?.numberOfEmployees;

    if (jsonLdEmployees) {
      const jsonValue =
        typeof jsonLdEmployees === 'object'
          ? `${jsonLdEmployees.minValue || ''}-${jsonLdEmployees.maxValue || ''} employees`
          : String(jsonLdEmployees);
      const parsedJsonValue = parseEmployeeCount(jsonValue);

      if (parsedJsonValue) {
        return { ...parsedJsonValue, source: 'JSON-LD' };
      }
    }

    const selectors = [
      '[data-test-id*="company-size"]',
      '[data-test-id*="employees"]',
      '[class*="company-size"]',
      '[class*="employee-count"]',
      '.org-about-company-module__company-size-definition'
    ];

    for (const selector of selectors) {
      const parsed = parseEmployeeCount(document.querySelector(selector)?.textContent);

      if (parsed) {
        return { ...parsed, source: 'PAGE' };
      }
    }

    for (const dt of document.querySelectorAll('dt')) {
      if (!/employees|company size/i.test(dt.textContent || '')) {
        continue;
      }

      const parsed = parseEmployeeCount(
        [dt.textContent, dt.nextElementSibling?.textContent].join(' ')
      );

      if (parsed) {
        return { ...parsed, source: 'PAGE' };
      }
    }

    return {
      label: 'Unavailable',
      minimum: null,
      maximum: null,
      estimate: null,
      source: null
    };
  }

  function enrichJobWithCompanyMetrics(job, openJobsCount = null) {
    const employeeData = extractEmployeeData();

    return {
      ...job,
      employeeCountLabel: employeeData.label,
      employeeCountMinimum: employeeData.minimum,
      employeeCountMaximum: employeeData.maximum,
      employeeCountEstimate: employeeData.estimate,
      employeeCountSource: employeeData.source,
      openJobsCount,
      openJobsCountSource: openJobsCount ? 'VISIBLE_SEARCH_RESULTS' : null
    };
  }

  function looksLikePay(text) {
    const value = cleanText(text);

    if (!value || value.length > 500) {
      return false;
    }

    return /(?:[$£€¥₹]|\b(?:USD|GBP|EUR|CAD|AUD)\s+)\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:[kK]\b|(?:\/|per)\s*(?:hr|hour))/i.test(value);
  }

  function insideDescription(element) {
    return Boolean(element?.closest?.('.show-more-less-html__markup, .jobs-description-content__text, .jobs-box__html-content'));
  }

  function salaryFromJsonLd(job) {
    const salary = job?.baseSalary;

    if (!salary || typeof salary !== 'object') {
      return '';
    }

    const value = salary.value && typeof salary.value === 'object' ? salary.value : salary;
    const min = value.minValue ?? value.value;

    if (min == null || min === '') {
      return '';
    }

    const max = value.maxValue;
    const unit = String(value.unitText || '').toUpperCase();
    const suffix = unit.includes('HOUR') ? '/hr' : unit.includes('YEAR') ? '/yr' : '';
    const currency = String(salary.currency || 'USD').toUpperCase();
    const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'JPY' ? '¥' : '$';
    const left = `${symbol}${min}${suffix}`;

    if (max != null && String(max) !== String(min)) {
      return `${left} - ${symbol}${max}${suffix}`;
    }

    return left;
  }

  // LinkedIn's "{company} provided pay range" card sits above the description.
  // readDescription stops at .show-more-less-html__markup, which does not
  // include that card or the top-card pay insight.
  function readPayRange(root, jsonLdJob) {
    const scopes = [];
    let current = root;

    for (let depth = 0; depth < 6 && current; depth += 1) {
      scopes.push(current);
      const host = current.getRootNode?.();
      current = current.parentElement || (host instanceof ShadowRoot ? host.host : null);
    }

    for (const scope of scopes) {
      let headings = [];

      try {
        headings = scope.querySelectorAll?.('h1, h2, h3, h4') || [];
      } catch {
        headings = [];
      }

      for (const heading of headings) {
        if (insideDescription(heading)) {
          continue;
        }

        const label = cleanText(heading.textContent);

        if (!/pay range|base pay|compensation/i.test(label)) {
          continue;
        }

        const parentText = cleanText(heading.parentElement?.innerText || heading.parentElement?.textContent);
        const nextText = cleanText(heading.nextElementSibling?.innerText || heading.nextElementSibling?.textContent);
        const text = parentText.length > 0 && parentText.length <= 400 && looksLikePay(parentText)
          ? parentText
          : cleanText(`${label} ${nextText}`);

        if (looksLikePay(text)) {
          return { text: text.slice(0, 400), source: 'pay-range-heading' };
        }
      }
    }

    const selectors = [
      '.compensation__salary',
      '.job-details-salary',
      '[class*="compensation__salary"]',
      '[class*="job-details-salary"]',
      '.job-details-jobs-unified-top-card__job-insight',
      '.jobs-unified-top-card__job-insight'
    ];

    for (const scope of scopes) {
      for (const selector of selectors) {
        let elements = [];

        try {
          elements = scope.querySelectorAll?.(selector) || [];
        } catch {
          elements = [];
        }

        for (const element of elements) {
          if (insideDescription(element)) {
            continue;
          }

          const text = cleanText(element.innerText || element.textContent);

          if (looksLikePay(text) && text.length <= 180) {
            return { text, source: selector };
          }
        }
      }
    }

    const fromLd = salaryFromJsonLd(jsonLdJob);

    if (fromLd) {
      return { text: fromLd, source: 'json-ld' };
    }

    return { text: '', source: '' };
  }

  function readDescription(root, jsonLdJob) {
    const selectors = [
      '.show-more-less-html__markup',
      '.jobs-description-content__text',
      '.jobs-description__content',
      '.jobs-box__html-content',
      '#job-details'
    ];

    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = cleanText(element?.innerText || element?.textContent);

      if (text.length > 1) {
        const className = element.className;
        return {
          text,
          source: `${selector} ${typeof className === 'string' ? className : (className?.baseVal || '')}`.trim()
        };
      }
    }

    return {
      text: stripHtml(jsonLdJob?.description),
      source: 'json-ld'
    };
  }

  function getFirstText(selectors, root = document) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const text = cleanText(element?.innerText || element?.textContent);

      if (text.length > 1) {
        return text;
      }
    }

    return '';
  }

  function getJsonLdJob() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');

    for (const script of scripts) {
      try {
        const parsed = JSON.parse(script.textContent);
        const values = Array.isArray(parsed) ? parsed : parsed?.['@graph'] || [parsed];
        const jobPosting = values.find((item) => {
          const type = item?.['@type'];
          return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
        });

        if (jobPosting) {
          return jobPosting;
        }
      } catch {
        // Ignore invalid JSON-LD blocks.
      }
    }

    return null;
  }

  function stripHtml(value) {
    if (!value) {
      return '';
    }

    const element = document.createElement('div');
    element.innerHTML = String(value);
    return cleanText(element.innerText || element.textContent);
  }

  function shadowOf(element) {
    try {
      const opener = chrome?.dom?.openOrClosedShadowRoot;

      if (typeof opener === 'function') {
        const opened = opener(element);

        if (opened) {
          return opened;
        }
      }
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        teardownExtensionContext();
      }
      // Closed roots are skipped when the API is unavailable.
    }

    return element.shadowRoot || null;
  }

  function collectRoots() {
    const roots = [document];
    const seen = new Set();

    function walk(node, depth) {
      if (!node?.querySelectorAll || depth > 4) {
        return;
      }

      for (const element of node.querySelectorAll('*')) {
        if (element.id === 'ghd-widget-host' || seen.has(element)) {
          continue;
        }

        seen.add(element);
        const shadow = shadowOf(element);

        if (shadow && !seen.has(shadow)) {
          seen.add(shadow);
          roots.push(shadow);
          walk(shadow, depth + 1);
        }
      }
    }

    walk(document, 0);
    return roots;
  }

  function queryAllDeep(selector) {
    const found = [];

    for (const root of collectRoots()) {
      try {
        for (const element of root.querySelectorAll(selector)) {
          if (element.id !== 'ghd-widget-host') {
            found.push(element);
          }
        }
      } catch {
        // Ignore a selector the root cannot evaluate.
      }
    }

    return found;
  }

  function wordCount(element) {
    return String(element?.innerText || element?.textContent || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .length;
  }

  function firstWithText(selectors, minimumWords) {
    for (const selector of selectors) {
      for (const element of queryAllDeep(selector)) {
        if (wordCount(element) >= minimumWords) {
          return element;
        }
      }
    }

    return null;
  }

  let lastClimb = 0;
  let climbCapped = false;

  function climbToHeading(node) {
    const info = pageInfo();
    let current = node;
    lastClimb = 0;
    climbCapped = false;

    for (let depth = 0; depth < 8 && current; depth += 1) {
      lastClimb = depth;
      const heading = current.querySelector?.('h1, h2, [class*="job-title"]');
      const hasJobLink = !!current.querySelector?.('a[href*="/jobs/view/"]');
      const hasCurrentId = info.jobId && current.innerHTML?.includes(String(info.jobId));

      if (heading && wordCount(current) >= 20 && (hasJobLink || hasCurrentId || info.kind !== 'search')) {
        return current;
      }

      const root = current.getRootNode?.();
      current = current.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }

    climbCapped = true;
    return node;
  }

  function densestBlock() {
    const root = document.querySelector('main') || document.body;

    function dive(element, depth) {
      if (!element || depth > 12) {
        return element;
      }

      let winner = null;
      let words = 0;

      for (const child of element.children || []) {
        if (child.id === 'ghd-widget-host') {
          continue;
        }

        const count = wordCount(child);

        if (count >= 50 && count > words) {
          winner = child;
          words = count;
        }
      }

      return winner ? dive(winner, depth + 1) : element;
    }

    const found = dive(root, 0);
    return found && found !== root && found !== document.body ? found : null;
  }

  function logDetailRoot(tier, element) {
    if (pageInfo().kind !== 'search') {
      return element;
    }

    const className = element?.className;
    console.info('[GHD] detailRoot', {
      tier,
      climbs: lastClimb,
      capped: climbCapped,
      tagName: element?.tagName || null,
      className: typeof className === 'string' ? className : (className?.baseVal || null)
    });
    return element;
  }

  function detailRoot() {
    const platform = firstWithText(PLATFORM_SELECTORS, 30);

    if (platform) {
      return logDetailRoot('platform', climbToHeading(platform));
    }

    const rail = firstWithText(RAIL_SELECTORS, 30);

    if (rail) {
      return logDetailRoot('rail', rail);
    }

    const article = firstWithText(ARTICLE_SELECTORS, 40);

    if (article) {
      return logDetailRoot('article', article);
    }

    const dense = densestBlock();

    if (dense) {
      return logDetailRoot('densestBlock', dense);
    }

    const fallback = document.querySelector(pageApi.LINKEDIN_DETAIL_SELECTORS.join(','));
    return logDetailRoot(fallback ? 'lightDom' : 'none', fallback);
  }

  function extractDetailJob() {
    const info = pageInfo();
    const root = detailRoot() || (info.kind === 'detail' ? document : null);

    if (!root) {
      return null;
    }

    const jsonLdJob = getJsonLdJob();
    const title =
      getFirstText([
        'h1.top-card-layout__title',
        'h1.jobs-unified-top-card__job-title',
        'h2.jobs-unified-top-card__job-title',
        'h1.job-details-jobs-unified-top-card__job-title',
        'h2.job-details-jobs-unified-top-card__job-title',
        '.jobs-unified-top-card h1',
        '.jobs-unified-top-card h2',
        'h1[class*="job-title"]',
        'h2[class*="job-title"]',
        'h1',
        'h2'
      ], root) || cleanText(jsonLdJob?.title);
    const company =
      pageApi.companyFromPrimary(getFirstText([
        '.top-card-layout__second-subline a[href*="/company/"]',
        '.top-card-layout__card a[href*="/company/"]',
        '.jobs-unified-top-card__company-name a',
        '.jobs-unified-top-card__company-name',
        '.job-details-jobs-unified-top-card__company-name a',
        '.job-details-jobs-unified-top-card__company-name',
        '.job-details-jobs-unified-top-card__primary-description a',
        'a[data-tracking-control-name*="org-name"]',
        'a[href*="/company/"]'
      ], root)) ||
      cleanText(
        typeof jsonLdJob?.hiringOrganization === 'string'
          ? jsonLdJob.hiringOrganization
          : jsonLdJob?.hiringOrganization?.name
      );
    const descriptionRead = readDescription(root, jsonLdJob);
    const description = descriptionRead.text;
    const pay = readPayRange(root, jsonLdJob);
    console.info('[GHD] pay range', {
      source: pay.source,
      text: pay.text,
      inDescription: description.includes(pay.text) && pay.text.length > 0
    });

    if (!title || !company) {
      return null;
    }

    const paneLink = root.querySelector('a[href*="/jobs/view/"]');
    const pageId = info.jobId ? String(info.jobId) : '';
    const linkId = String(getJobIdFromHref(paneLink?.href) || '');
    // The page URL is the posting on screen. The first view link in the
    // pane can be a different job, so it only fills in when the URL has no id.
    const jobId = pageId || linkId;

    if (info.kind === 'search' && title && company && !jobId) {
      console.info('[GHD] extractDetailJob', {
        title,
        company,
        jobId,
        urlJobId: info.jobId,
        hadPaneLink: !!paneLink
      });
    }

    const pageText = root.innerText || root.textContent || '';

    const url = (linkId && linkId === String(jobId) && paneLink?.href)
      || (pageId && info.kind === 'detail' ? location.href : '')
      || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}` : location.href);

    return withLocation(enrichJobWithCompanyMetrics({
      title,
      company,
      description,
      descriptionSource: descriptionRead.source,
      salary: pay.text,
      salarySource: pay.source,
      companySlug: companySlug(root),
      url,
      jobId,
      platform,
      postedLabel: postedLabelFrom(pageText),
      jobLocation: '',
      source: info.kind === 'search' ? 'SEARCH_DETAIL' : 'DETAIL_PAGE',
      timestamp: Date.now()
    }), pageText);
  }

  function postedLabelFrom(text) {
    const match = String(text || '').match(/\b\d+\s+(?:hour|day|week|month|year)s?\s+ago\b/i);
    return match ? match[0] : '';
  }

  function withLocation(job, text) {
    const raw = pageApi.readJobLocation(text, job.company) || job.jobLocation || '';
    const location = pageApi.normalizeJobLocation(raw, job.company);

    return {
      ...job,
      jobLocation: location.raw,
      locationNormalized: location.normalized
    };
  }

  function detailMatchesSelection(job) {
    const info = pageInfo();

    if (info.kind !== 'search' || !info.jobId || !job) {
      return Boolean(job);
    }

    const matches = Boolean(job.jobId && String(job.jobId) === String(info.jobId));

    if (!matches) {
      console.info('[GHD] detailMatchesSelection', {
        jobId: job.jobId ?? null,
        urlJobId: info.jobId
      });
    }

    return matches;
  }

  function looksLikeCompany(value) {
    const text = cleanText(value);

    if (!text || text.length > 120) {
      return false;
    }

    return !/^(promoted|actively recruiting|easy apply|be an early applicant)$/i.test(text);
  }

  function getFirstCardText(card, selectors) {
    for (const selector of selectors) {
      const element = card.querySelector(selector);
      const text = cleanText(element?.textContent);

      if (text.length > 1) {
        return text;
      }
    }

    return '';
  }

  function extractCardJob(card) {
    const link = card.querySelector('a[href*="/jobs/view/"]');
    const ariaLabel = cleanText(link?.getAttribute('aria-label'));
    const atMatch = ariaLabel.match(/^(.+?)\s+at\s+(.+)$/i);
    let title = getFirstCardText(card, [
      '.job-card-list__title',
      '.job-card-container__link strong',
      '.job-card-container__link',
      '.artdeco-entity-lockup__title',
      'h3 a[href*="/jobs/view/"]',
      '[class*="job-card-title"]',
      'h3',
      'h4'
    ]);
    let company = pageApi.companyFromPrimary(getFirstCardText(card, [
      '.job-card-container__primary-description',
      '.artdeco-entity-lockup__subtitle',
      '.job-card-container__company-name',
      '[class*="entity-result__primary-subtitle"]'
    ]));

    if (!title && atMatch) {
      title = cleanText(atMatch[1]);
    }

    if (!title) {
      title = ariaLabel;
    }

    if (!company && atMatch) {
      company = pageApi.companyFromPrimary(atMatch[2]);
    }

    if (!company) {
      const alt = cleanText(card.querySelector('img[alt]')?.alt).replace(/\s+logo$/i, '');

      if (looksLikeCompany(alt) && normalizeCompanyName(alt) !== normalizeCompanyName(title)) {
        company = alt;
      }
    }

    if (!looksLikeCompany(company)) {
      company = '';
    }

    if (!title || !company) {
      const parsed = pageApi.parseLinkedInCardText(card.innerText || card.textContent || '');
      title = title || parsed.title;
      company = company || parsed.company;
    }

    const jobId = cardJobId(card) || getJobIdFromHref(link?.href);

    if (!title || !company || !jobId) {
      return null;
    }

    const cardText = card.innerText || card.textContent || '';

    return withLocation({
      title,
      company,
      description: '',
      url: link?.href || `https://www.linkedin.com/jobs/view/${jobId}`,
      jobId,
      platform,
      postedLabel: postedLabelFrom(cardText),
      jobLocation: '',
      source: 'SEARCH_CARD',
      timestamp: Date.now()
    }, cardText);
  }

  async function rememberJobAge(job) {
    const api = globalThis.GhostJobHeuristics;

    if (!job?.jobId || !job?.postedLabel || !api?.rememberJobAge) {
      return;
    }

    const key = 'ghd_job_id_ages';

    try {
      const stored = await callChrome(() => chrome.storage.local.get(key));
      const pairs = api.rememberJobAge(stored?.[key], job.jobId, job.postedLabel, Date.now());
      await callChrome(() => chrome.storage.local.set({ [key]: pairs }));
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        teardownExtensionContext();
        return;
      }

      throw error;
    }
  }

  async function saveJob(job) {
    await rememberJobAge(job);
    try {
      await callChrome(() => chrome.storage.local.set({
        [STORAGE_KEY]: job,
        ghd_timestamp: Date.now()
      }));
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        teardownExtensionContext();
      }

      throw error;
    }

    try {
      await callChrome(() => chrome.runtime.sendMessage({
        type: 'JOB_DATA_AVAILABLE',
        job
      }));
    } catch (error) {
      if (extensionContextInvalidated(error)) {
        teardownExtensionContext();
      }

      console.warn('[GHD] Background message failed:', error);
    }

    return job;
  }

  function extractSelectedSearchJob(requestedJobId) {
    const wantedId = String(requestedJobId || pageInfo().jobId || '');

    if (!wantedId) {
      return null;
    }

    for (const card of getSearchCards()) {
      if (String(cardJobId(card) || '') !== wantedId) {
        continue;
      }

      const job = extractCardJob(card);

      if (!job) {
        return null;
      }

      return withSearchOpenJobs(job);
    }

    return null;
  }

  function clearRetries() {
    retryTimers.forEach((timer) => clearTimeout(timer));
    retryTimers = [];
  }

  function analysisKey(job) {
    return [job?.jobId || job?.url || '', job?.title || '', job?.company || ''].join('|');
  }

  function companySlug(root = document) {
    const link = root.querySelector('a[href*="/company/"]') || document.querySelector('a[href*="/company/"]');
    const match = String(link?.href || '').match(/\/company\/([^/?#]+)/i);

    if (!match) {
      return '';
    }

    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function linkedInIdentitySignals(fallbackCompany) {
    const job = extractDetailJob();

    return {
      rawName: job?.company || fallbackCompany || '',
      company: job?.company || fallbackCompany || '',
      description: job?.description || '',
      hostname: location.hostname,
      platform: 'LINKEDIN',
      slug: companySlug()
    };
  }

  function settleIdentity(job, company) {
    console.info('[GHD] company identity resolved', String(company), {
      hostname: location.hostname,
      company,
      previous: job.company
    });

    if (!company || company === job.company) {
      return;
    }

    const updated = { ...job, company };
    saveJob(updated);
    globalThis.GhdWidget?.setCompany(company);
  }

  function startCompanyIdentity(job) {
    const key = `${job?.jobId || ''}|${job?.company || ''}`;

    if (!job?.company || key === identityKey || pageApi.isNormalCompanyName?.(job.company)) {
      return;
    }

    if (typeof pageApi.resolveCompanyIdentityWhenReady !== 'function') {
      console.info('[GHD] company identity error', 'globalThis.GhdPage.resolveCompanyIdentityWhenReady is undefined');
      return;
    }

    identityKey = key;
    const flight = pageApi.resolveCompanyIdentityWhenReady(() => linkedInIdentitySignals(job.company), {
      resolve(signals) {
        const description = String(signals?.description || '');
        const windowText = description.replace(/\s+/g, ' ').trim().slice(0, 800);
        const candidates = pageApi.extractDescriptionCandidates?.(description) || [];
        console.info('[GHD] company identity starting', job.company, {
          hostname: location.hostname,
          company: job.company,
          descriptionLength: description.length,
          descriptionSource: job.descriptionSource || '',
          groupHoldingsIndex: description.indexOf('Group Holdings'),
          inFirst800: windowText.includes('TKO Group Holdings'),
          window: windowText,
          candidates
        });
        return pageApi.requestCompanyIdentity(signals);
      }
    });
    globalThis.GhdWidget?.trackIdentity?.(flight);
    flight.then((result) => {
      if (!result?.ready) {
        console.info('[GHD] company identity kept', String(result?.company || job.company));
        return;
      }

      settleIdentity(job, result.company);
    }).catch((error) => {
      console.info('[GHD] company identity error', error?.message || String(error), {
        name: error?.name || null
      });
    });
  }

  async function publishJob(job, finalAttempt) {
    const next = pageInfo().kind === 'search' ? withSearchOpenJobs(job) : job;
    const description = String(next.description || '').trim();
    const salary = String(next.salary || '').trim();
    const ready = pageApi.descriptionReadyForVagueness?.(description) === true;
    await saveJob(next);
    startCompanyIdentity(next);

    const key = analysisKey(next);

    if (key === lastAnalyzedKey && description.length <= lastDescriptionLength && salary.length <= lastSalaryLength) {
      return;
    }

    if (!ready) {
      if (!finalAttempt) {
        return;
      }

      console.info('[GHD] vagueness withheld', {
        descriptionLength: description.length,
        descriptionSource: next.descriptionSource || '',
        reason: 'description below readiness bar'
      });
      lastAnalyzedKey = key;
      lastDescriptionLength = description.length;
      lastSalaryLength = salary.length;
      clearRetries();
      globalThis.GhdWidget?.analyze({ ...next, description: '' });
      return;
    }

    const scored = globalThis.GhostJobHeuristics?.analyzeVagueness?.(description, next.title || '', salary);

    if (scored) {
      console.info('[GHD] vagueness text', {
        label: scored.label,
        score: scored.score,
        descriptionLength: description.length,
        wordCount: scored.raw?.wordCount ?? null,
        descriptionSource: next.descriptionSource || '',
        salarySource: next.salarySource || '',
        salary: salary.slice(0, 200),
        factors: scored.factors,
        raw: scored.raw,
        text: description.slice(0, 800)
      });
    }

    lastAnalyzedKey = key;
    lastDescriptionLength = description.length;
    lastSalaryLength = salary.length;
    clearRetries();
    globalThis.GhdWidget?.analyze(next);
  }

  function extractDetailWithRetry() {
    clearRetries();

    const attempt = async (finalAttempt) => {
      const job = extractDetailJob();

      if (job && detailMatchesSelection(job)) {
        await publishJob(job, finalAttempt);
      }
    };

    attempt(false);
    RETRY_DELAYS.forEach((delay, index) => {
      const timer = setTimeout(() => {
        attempt(index === RETRY_DELAYS.length - 1);
      }, delay);
      retryTimers.push(timer);
    });
  }

  function watchJobDetail() {
    detailObserver?.disconnect();
    detailObserver = new MutationObserver(() => {
      clearTimeout(detailObserverTimer);
      detailObserverTimer = setTimeout(() => {
        const job = extractDetailJob();

        if (job && detailMatchesSelection(job)) {
          publishJob(job, false);
        }
      }, 200);
    });
    detailObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function badgeHost(card) {
    return card.querySelector(':scope > .job-card-container, :scope > .base-card') || card;
  }

  function injectSearchBadges() {
    if (pageInfo().kind !== 'search') {
      return;
    }

    const currentJobId = pageInfo().jobId;

    getSearchCards().forEach((card) => {
      const job = extractCardJob(card);
      const jobId = job?.jobId || cardJobId(card);

      if (!job || !jobId) {
        return;
      }

      const host = badgeHost(card);

      if (host.dataset.ghdJobId === String(jobId) && host.querySelector(':scope > .ghd-badge')) {
        return;
      }

      host.dataset.ghdJobId = String(jobId);
      host.querySelector(':scope > .ghd-badge')?.remove();

      if (currentJobId && String(currentJobId) === String(jobId)) {
        saveJob(withSearchOpenJobs(job));
      }

      const badge = document.createElement('button');
      badge.className = 'ghd-badge';
      badge.type = 'button';
      badge.textContent = '👻';
      badge.title = 'Save this job for Ghost Job Detector';
      badge.style.cssText = [
        'position:absolute',
        'top:8px',
        'left:8px',
        'z-index:2147483646',
        'width:32px',
        'height:32px',
        'border:0',
        'border-radius:50%',
        'cursor:pointer',
        'background:#6d4aff',
        'color:white',
        'font-size:16px',
        'line-height:32px',
        'padding:0',
        'pointer-events:auto'
      ].join(';');

      const computed = window.getComputedStyle(host);

      if (computed.position === 'static') {
        host.style.position = 'relative';
      }

      host.style.overflow = 'visible';

      listen(badge, 'click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveJob(withSearchOpenJobs(job));
      });

      host.appendChild(badge);
    });
  }

  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(injectSearchBadges, 150);
  }

  function watchSearchResults() {
    if (pageInfo().kind !== 'search') {
      return;
    }

    if (listObserver) {
      listObserver.disconnect();
    }

    listObserver = new MutationObserver(scheduleBadges);
    listObserver.observe(document.documentElement, { childList: true, subtree: true });
    scheduleBadges();
  }

  function processPage() {
    const info = pageInfo();
    watchJobDetail();

    if (info.kind === 'search') {
      watchSearchResults();
      extractDetailWithRetry();
      return;
    }

    if (info.kind === 'detail') {
      extractDetailWithRetry();
    }
  }

  function respondWithJob(job, sendResponse) {
    if (!job?.title || !job?.company) {
      sendResponse({
        success: false,
        error: 'Job details are not ready yet'
      });
      return;
    }

    saveJob(job)
      .then(() => sendResponse({ success: true, job }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message.type !== 'REQUEST_CURRENT_JOB') {
      return false;
    }

    const info = pageInfo();
    const requestedJobId = message.jobId || info.jobId;

    if (info.kind === 'detail') {
      respondWithJob(extractDetailJob(), sendResponse);
      return true;
    }

    if (info.kind === 'search') {
      const detail = extractDetailJob();
      const job = detail && detailMatchesSelection(detail)
        ? detail
        : extractSelectedSearchJob(requestedJobId);

      if (job && pageInfo().kind === 'search') {
        respondWithJob(withSearchOpenJobs(job), sendResponse);
      } else {
        respondWithJob(job, sendResponse);
      }

      return true;
    }

    sendResponse({ success: false, error: 'Unsupported LinkedIn page' });
    return true;
  }

  try {
    callChrome(() => chrome.runtime.onMessage.addListener(onRuntimeMessage));
    removeListeners.push(() => {
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      } catch {
        // The context is already gone.
      }
    });
  } catch {
    // No listener once the extension context is dead.
  }

  listen(document, 'scroll', (event) => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest('.scaffold-layout__list, .jobs-search-results-list, .jobs-search-results')) {
      scheduleBadges();
    }
  }, true);

  setInterval(() => {
    const info = pageInfo();
    const href = location.href;
    const jobId = info.jobId || '';

    if (href === lastUrl && jobId === lastJobId) {
      if (info.kind === 'search') {
        scheduleBadges();
      }
      return;
    }

    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      lastUrl = location.href;
      lastJobId = pageInfo().jobId || '';
      lastAnalyzedKey = '';
      lastDescriptionLength = 0;
      identityKey = '';
      processPage();
    }, 600);
  }, 600);

  watchExtensionContext();
  processPage();
})();
