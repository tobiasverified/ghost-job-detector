(() => {
  'use strict';

  if (globalThis.__GHD_WORKDAY__) {
    return;
  }

  globalThis.__GHD_WORKDAY__ = true;

  const STORAGE_KEY = 'ghd_current_job';
  const platform = 'WORKDAY';
  let lastUrl = location.href;
  let extractionTimer = null;
  let badgeTimer = null;

  function cleanText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function textFrom(selectors, root = document) {
    for (const selector of selectors) {
      const text = cleanText(root.querySelector(selector)?.innerText);

      if (text.length > 1) {
        return text;
      }
    }

    return '';
  }

  function decodeHtml(value) {
    return cleanText(String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'));
  }

  function readJsonLdJob() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        const posting = values.find((item) => item?.['@type'] === 'JobPosting');

        if (posting) {
          return posting;
        }
      } catch {
        // Ignore invalid JSON-LD.
      }
    }

    return null;
  }

  function readSiteId() {
    for (const script of document.scripts) {
      const match = String(script.textContent || '').match(/siteId:\s*"([^"]+)"/);

      if (match) {
        return match[1];
      }
    }

    return '';
  }

  function companyName(title, description) {
    const posting = readJsonLdJob();
    const organizationName = typeof posting?.hiringOrganization === 'object'
      ? posting.hiringOrganization.name
      : '';
    const descriptionText = description || decodeHtml(posting?.description) || document.querySelector('meta[property="og:description"]')?.content;
    const siteName = String(readSiteId() || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b(careers?|jobs?|external|site)\b/ig, ' ');
    const pathSegment = String(location.pathname || '')
      .split('/')
      .filter(Boolean)
      .map((part) => part.replace(/[_-]+/g, ' '))
      .find((part) => /career|job/i.test(part) && !/^[a-z]{2}\s[a-z]{2}$/i.test(part));
    const host = String(location.hostname || '').match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
    const titleParts = String(document.title || '').split('|').map((part) => part.trim());
    const signals = {
      jobTitle: title,
      descriptionLead: String(descriptionText || '').split('|')[0],
      organization: String(organizationName || '').replace(/^\d+\s+/, ''),
      siteName,
      pathSegment,
      hostMatch: host ? host[1].replace(/[-_]+/g, ' ') : '',
      domCompany: textFrom([
        '[data-automation-id="jobPostingCompanyName"]',
        '[data-automation-id="company"]'
      ]),
      titleSuffix: titleParts.length > 1 ? titleParts[titleParts.length - 1] : ''
    };
    const winner = globalThis.GhdPage.companyFromWorkdaySignals({
      jobTitle: title,
      description: descriptionText,
      organization: organizationName,
      siteId: readSiteId(),
      pathname: location.pathname,
      hostname: location.hostname,
      domCompany: signals.domCompany,
      documentTitle: document.title
    });

    console.info('[GHD] workday company', { ...signals, winner });
    return winner;
  }

  function extractDetailJob() {
    const posting = readJsonLdJob();
    const title = textFrom([
      '[data-automation-id="jobPostingHeader"]',
      'h2[data-automation-id="jobPostingHeader"]'
    ]) || decodeHtml(posting?.title) || decodeHtml(document.querySelector('meta[property="og:title"]')?.content);
    const description = readDetailDescription(posting);
    const company = companyName(title, description);

    if (!title || !company || /^(workday|careers home)$/i.test(title)) {
      return null;
    }

    const place = posting?.jobLocation?.address;
    const rawLocation = [place?.addressLocality, place?.addressRegion].filter(Boolean).join(', ');
    const jobPlace = globalThis.GhdPage.normalizeJobLocation(rawLocation);

    return withOpenJobs({
      title,
      company,
      description,
      url: globalThis.location.href,
      jobId: null,
      platform,
      jobLocation: jobPlace.raw,
      locationNormalized: jobPlace.normalized,
      source: 'WORKDAY_DETAIL',
      timestamp: Date.now()
    });
  }

  function getObservedOpenJobsCount() {
    const entries = [...document.querySelectorAll('[data-automation-id="jobTitle"]')].map((node) => ({
      href: node.closest('a')?.href || node.href || '',
      text: cleanText(node.innerText || node.textContent)
    }));

    return globalThis.GhdPage?.countWorkdayOpenings?.(entries) || null;
  }

  function withOpenJobs(job) {
    const openJobsCount = getObservedOpenJobsCount();

    return {
      ...job,
      openJobsCount,
      openJobsCountSource: openJobsCount ? 'VISIBLE_SEARCH_RESULTS' : null
    };
  }

  async function saveJob(job) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: job,
      ghd_timestamp: Date.now()
    });

    try {
      await chrome.runtime.sendMessage({
        type: 'JOB_DATA_AVAILABLE',
        job
      });
    } catch (error) {
      console.warn('[GHD] Background message failed:', error);
    }

    return job;
  }

  function readDetailDescription(posting = readJsonLdJob()) {
    return textFrom([
      '[data-automation-id="jobPostingDescription"]',
      '[data-automation-id="job-posting-description"]'
    ]) || decodeHtml(posting?.description) || decodeHtml(document.querySelector('meta[property="og:description"]')?.content);
  }

  function identitySignalsFor(company) {
    const posting = readJsonLdJob();

    return {
      jobTitle: textFrom([
        '[data-automation-id="jobPostingHeader"]',
        'h2[data-automation-id="jobPostingHeader"]'
      ]) || decodeHtml(posting?.title) || decodeHtml(document.querySelector('meta[property="og:title"]')?.content),
      description: readDetailDescription(posting),
      organization: typeof posting?.hiringOrganization === 'object'
        ? posting.hiringOrganization.name
        : '',
      siteId: readSiteId(),
      pathname: location.pathname,
      hostname: location.hostname,
      domCompany: textFrom([
        '[data-automation-id="jobPostingCompanyName"]',
        '[data-automation-id="company"]'
      ]),
      documentTitle: document.title,
      company
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
    const pages = globalThis.GhdPage;

    if (typeof pages?.resolveCompanyIdentityWhenReady !== 'function') {
      console.info('[GHD] company identity error', 'globalThis.GhdPage.resolveCompanyIdentityWhenReady is undefined');
      return;
    }

    const flight = pages.resolveCompanyIdentityWhenReady(() => identitySignalsFor(job.company), {
      resolve(signals) {
        console.info('[GHD] company identity starting', job.company, {
          hostname: location.hostname,
          company: job.company,
          descriptionLength: String(signals?.description || '').length,
          hasResolver: typeof pages.resolveCompanyIdentity === 'function'
        });

        if (typeof pages.resolveCompanyIdentity !== 'function') {
          throw new Error('globalThis.GhdPage.resolveCompanyIdentity is undefined');
        }

        return pages.resolveCompanyIdentity(signals).then((company) => {
          if (pages.isNormalCompanyName?.(company)) {
            return company;
          }

          return pages.requestCompanyIdentity({
            ...signals,
            rawName: company || signals.company,
            company: company || signals.company,
            platform: 'WORKDAY'
          });
        });
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

  function extractDetailWithRetry() {
    if (!/\/(?:job|details)\//.test(location.pathname)) {
      return;
    }

    if (extractionTimer) {
      clearInterval(extractionTimer);
    }

    let attempts = 0;

    extractionTimer = setInterval(async () => {
      attempts += 1;
      const job = extractDetailJob();

      if (job) {
        const description = String(job.description || '').trim();
        const ready = globalThis.GhdPage.descriptionReadyForVagueness?.(description) === true;

        if (!ready && attempts < 30) {
          return;
        }

        clearInterval(extractionTimer);
        extractionTimer = null;
        await saveJob(job);

        if (!ready) {
          console.info('[GHD] vagueness withheld', {
            descriptionLength: description.length,
            platform: 'WORKDAY',
            reason: 'description below readiness bar'
          });
          globalThis.GhdWidget?.analyze({ ...job, description: '' });
        } else {
          const scored = globalThis.GhostJobHeuristics?.analyzeVagueness?.(description, job.title || '');

          if (scored) {
            console.info('[GHD] vagueness text', {
              label: scored.label,
              score: scored.score,
              descriptionLength: description.length,
              wordCount: scored.raw?.wordCount ?? null,
              platform: 'WORKDAY',
              factors: scored.factors,
              raw: scored.raw,
              text: description.slice(0, 800)
            });
          }

          globalThis.GhdWidget?.analyze(job);
        }

        startCompanyIdentity(job);
        return;
      }

      if (attempts >= 30) {
        clearInterval(extractionTimer);
        extractionTimer = null;
      }
    }, 500);
  }

  function injectListBadges() {
    const titles = document.querySelectorAll('[data-automation-id="jobTitle"]');

    titles.forEach((titleNode) => {
      const card = titleNode.closest('li') || titleNode.parentElement;

      if (!card) {
        return;
      }

      const title = cleanText(titleNode.innerText);
      const href = titleNode.closest('a')?.href || titleNode.querySelector('a')?.href || '';
      const marker = href || title;

      if (!title || card.dataset.ghdJobId === marker) {
        return;
      }

      card.dataset.ghdJobId = marker;
      card.querySelector(':scope > .ghd-badge')?.remove();

      const company = companyName();

      if (!company) {
        return;
      }

      const badge = document.createElement('button');
      badge.className = 'ghd-badge';
      badge.type = 'button';
      badge.textContent = '👻';
      badge.title = 'Save this job for Ghost Job Detector';
      badge.style.cssText = [
        'margin-left:8px',
        'width:28px',
        'height:28px',
        'border:0',
        'border-radius:50%',
        'cursor:pointer',
        'background:#6d4aff',
        'color:white',
        'font-size:14px'
      ].join(';');

      badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveJob(withOpenJobs({
          title,
          company,
          description: '',
          url: href || location.href,
          jobId: null,
          platform,
          source: 'WORKDAY_LIST',
          timestamp: Date.now()
        }));
      });

      card.appendChild(badge);
    });
  }

  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(injectListBadges, 200);
  }

  function processPage() {
    extractDetailWithRetry();
    scheduleBadges();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'REQUEST_CURRENT_JOB') {
      return false;
    }

    const job = extractDetailJob();

    if (!job) {
      sendResponse({
        success: false,
        error: 'Open a Workday job posting and try again.'
      });
      return true;
    }

    saveJob(job)
      .then(() => sendResponse({ success: true, job }))
      .catch((error) => sendResponse({ success: false, error: error.message }));

    return true;
  });

  const observer = new MutationObserver(scheduleBadges);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      processPage();
    }
  }, 500);

  processPage();
})();
