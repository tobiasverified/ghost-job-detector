(function (root, factory) {
  // LinkedIn and Workday re-inject this file on every in-page job change.
  // Keep the panel that is already open so a second one does not stack on it.
  // That panel is replaced only when the next job is analyzed.
  if (root.GhdWidget?.analyze) {
    const nodes = typeof document !== 'undefined'
      ? [...document.querySelectorAll('#ghd-widget-host')]
      : [];
    const live = nodes.at(-1) || null;

    nodes.forEach((node) => {
      if (node !== live) {
        node.remove();
      }
    });

    if (live) {
      return;
    }
  }

  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.GhdWidget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const POSITION_KEY = 'ghd_widget_pos';
  const EXPANDED_KEY = 'ghd_widget_expanded';
  const JOB_AGE_KEY = 'ghd_job_id_ages';
  // Main check. analyze-job starts immediately and aborts at 12s. vercel.json
  // maxDuration is 15s, above that abort. Reposts are a second request: up to
  // 4s of DuckDuckGo HTML, then job-reposts aborts at 10s.
  const ENRICH_WAIT_MS = 18000;
  const REPOST_WAIT_MS = 16000;
  // Layoffs, reviews, workforce, and reposts. Description Clarity is always
  // local and does not count. Fewer than this and the number is withheld.
  const MIN_INFORMATIVE_FACTORS = 2;
  const IDENTITY_WAIT_MS = 10000;
  let host = null;
  let shadow = null;
  let requestId = 0;
  let expanded = true;
  let expandedTouched = false;
  let shown = '';
  let latest = null;
  let checking = false;
  let localJob = null;
  let pendingCompany = '';
  let identityFlight = null;
  let localRequest = 0;
  let localNote = '';
  // Full checks by job, so moving to another posting does not throw away a
  // check that is still running; its result is shown on coming back.
  const CHECKS_KEPT = 30;
  const checks = new Map();
  let currentKey = '';

  function jobKey(job) {
    return String(job?.jobId || job?.url || `${job?.title || ''}|${job?.company || ''}`);
  }

  function rememberCheck(key, entry) {
    checks.delete(key);
    checks.set(key, entry);

    while (checks.size > CHECKS_KEPT) {
      checks.delete(checks.keys().next().value);
    }
  }

  function heuristics() {
    return globalThis.GhostJobHeuristics;
  }

  function positiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? count : null;
  }

  function selectWorkforce(remoteHiring, localWorkforce) {
    const remote = remoteHiring || {};
    const local = localWorkforce || {};
    const employees = positiveCount(remote.employees) || positiveCount(local.employees);
    const openRoles = positiveCount(local.openRoles) || positiveCount(remote.openRoles);
    const source = positiveCount(remote.employees) ? (remote.employeeSource || 'search') : (local.employeeSource || null);

    if (remote.available !== true && remote.openRoles == null && remote.label && remote.label !== 'Unavailable') {
      return { ...remote, score: 0 };
    }

    if (!positiveCount(local.openRoles) && remote.openJobsLowerBound && employees && openRoles) {
      return {
        available: true,
        score: 0,
        ratio: remote.ratio ?? null,
        employees,
        openRoles,
        label: remote.label || '',
        detail: remote.detail || '',
        tooltip: remote.tooltip || remote.detail || '',
        lowerBound: Boolean(remote.lowerBound),
        openJobsLowerBound: true,
        estimated: Boolean(remote.estimated),
        employeeLabel: remote.employeeLabel || null,
        employeeSource: remote.employeeSource || source,
        openJobsEstimated: Boolean(remote.openJobsEstimated),
        openJobsSourceUrl: remote.openJobsSourceUrl || '',
        employeeDiscrepancy: remote.employeeDiscrepancy || '',
        employeeSourceUrl: remote.employeeSourceUrl || ''
      };
    }

    if (employees && openRoles) {
      const signal = heuristics().analyzeWorkforceSignal({
        employeeCountEstimate: employees,
        openJobsCount: openRoles,
        employeeSource: source,
        employeeLabel: remote.employeeLabel,
        employeesLowerBound: remote.employeeSource === 'wikidata'
          ? false
          : Boolean(remote.employeesLowerBound || remote.lowerBound)
      });
      const label = remote.openJobsEstimated
        ? String(signal.label || '').replace(' open roles', ' open roles (estimated)')
        : signal.label;

      return {
        ...signal,
        label,
        estimated: remote.employeeSource === 'wikidata' ? false : Boolean(remote.estimated),
        employeeLabel: remote.employeeLabel || null,
        employeeSource: remote.employeeSource || source,
        openJobsEstimated: Boolean(remote.openJobsEstimated),
        openJobsSourceUrl: remote.openJobsSourceUrl || '',
        employeeDiscrepancy: remote.employeeDiscrepancy || '',
        employeeSourceUrl: remote.employeeSourceUrl || ''
      };
    }

    if (local.available) {
      return local;
    }

    return remote.employees ? remote : local;
  }

  async function jobAgePairs(job) {
    const stored = await storageGet([JOB_AGE_KEY]);
    const saved = Array.isArray(stored?.[JOB_AGE_KEY]) ? stored[JOB_AGE_KEY] : [];
    const api = heuristics();

    if (!api?.rememberJobAge || !job?.jobId || !job?.postedLabel) {
      return saved;
    }

    const next = api.rememberJobAge(saved, job.jobId, job.postedLabel, Date.now());

    try {
      await chrome.storage.local.set({ [JOB_AGE_KEY]: next });
    } catch {
      // The row can still use the in-memory pairs.
    }

    return next;
  }

  // A factor the deadline cut off is shown as unavailable, with the server's
  // own explanation. It is not fed into a local score.
  function timedOutFactor(factor) {
    if (!factor?.timedOut) {
      return factor;
    }

    return {
      ...factor,
      unavailable: true,
      available: false,
      detected: false,
      pending: false,
      score: 0,
      employees: null,
      openRoles: null,
      ratio: null,
      rating: null,
      detail: factor.detail || ''
    };
  }

  const CHECKING_ROWS = [
    ['layoffs', 'Recent Layoffs'],
    ['reviews', 'Company Reviews'],
    ['hiringRatio', 'Company size'],
    ['reposts', 'Reposts']
  ];

  function markStillCheckingRows(factors, remote) {
    const pending = new Set(
      CHECKING_ROWS
        .filter(([key]) => remote?.factors?.[key]?.timedOut)
        .map(([, label]) => label)
    );

    return (factors || []).map((factor) => (pending.has(factor.label)
      ? { ...factor, value: 'Still checking, try again in a few seconds', detail: '', entries: [], href: '', indicator: null }
      : factor));
  }

  function mergeRemote(local, remote, idDates, job) {
    const withheld = remote.scoreWithheld === true;
    const partial = remote.partial === true;
    const vagueness = remote.factors?.vagueness || local.evidence.vagueness;
    const layoffRaw = remote.factors?.layoffs || local.evidence.layoff;
    const reviewsRaw = remote.factors?.reviews || local.evidence.reviews;
    const repostsRaw = heuristics().withoutSelfMatches({
      ...(remote.factors?.reposts || local.evidence.reposts),
      idDates: Array.isArray(idDates) ? idDates : [],
      jobId: job?.jobId || '',
      url: job?.url || ''
    });
    const hiring = remote.factors?.hiringRatio;
    const workforceRaw = selectWorkforce(hiring, local.evidence?.workforce);
    const serverScore = Number(remote.ghostScore);
    const scoredPartial = partial && !withheld && Number.isFinite(serverScore);
    const blankUnfinished = withheld || (partial && !scoredPartial);
    const layoff = blankUnfinished ? timedOutFactor(layoffRaw) : layoffRaw;
    const reviews = blankUnfinished ? timedOutFactor(reviewsRaw) : reviewsRaw;
    const reposts = blankUnfinished ? timedOutFactor(repostsRaw) : repostsRaw;
    const workforce = blankUnfinished && hiring?.timedOut
      ? timedOutFactor({ ...workforceRaw, timedOut: true, detail: hiring.detail || workforceRaw?.detail || '' })
      : workforceRaw;
    // A withheld check has no score. A partial check shows the server's number.
    // Neither one is rebuilt from the factors that happened to arrive.
    const score = withheld
      ? { score: null, label: '' }
      : partial
        ? {
          score: Number.isFinite(serverScore) ? serverScore : null,
          label: Number.isFinite(serverScore) ? heuristics().classifyScore(serverScore).label : (remote.label || '')
        }
        : heuristics().calculateGhostScore({
          vagueness,
          layoff,
          workforce,
          reviews,
          reposts
        });
    const built = heuristics().buildFactors(vagueness, layoff, workforce, reviews, reposts);
    const rows = scoredPartial ? markStillCheckingRows(built, remote) : built;

    return {
      score,
      scoreWithheld: withheld,
      partial,
      informativeCount: heuristics().informativeFactorCount({ layoff, reviews, workforce, reposts }),
      factors: remote.payCompareEnabled === true
        ? appendPay(rows, job)
        : rows.filter((factor) => factor.label !== 'Pay vs market'),
      payCompareEnabled: remote.payCompareEnabled === true,
      careers: remote.careers?.show ? remote.careers : null,
      careersChecked: remote.careersChecked !== false
    };
  }

  function colorFor(score) {
    if (score <= 34) return '#10b981';
    if (score <= 49) return '#f59e0b';
    return '#ef4444';
  }

  function ensureHost() {
    if (host?.isConnected) {
      document.querySelectorAll('#ghd-widget-host').forEach((node) => {
        if (node !== host) {
          node.remove();
        }
      });
      return;
    }

    document.querySelectorAll('#ghd-widget-host').forEach((node) => node.remove());

    host = document.createElement('div');
    host.id = 'ghd-widget-host';
    Object.assign(host.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '999999',
      width: '280px'
    });
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .panel {
        font: 13px/1.4 system-ui, sans-serif;
        color: #e2e8f0;
        background: #1e293b;
        border: 1px solid #334155;
        border-radius: 12px;
        padding: 12px;
        max-height: 70vh;
        overflow-y: auto;
      }
      .bar { display: flex; align-items: center; gap: 8px; cursor: grab; }
      .title { font-weight: 650; flex: 1; }
      a { color: #93c5fd; }
      button {
        font: inherit;
        color: #e2e8f0;
        background: #334155;
        border: 0;
        border-radius: 8px;
        padding: 4px 8px;
        cursor: pointer;
      }
      .score-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
      .note { display: block; color: #94a3b8; font-size: 12px; margin-top: 2px; }
      .pending { color: #94a3b8; }
      .ring { width: 72px; height: 72px; }
      .number { font-size: 22px; font-weight: 700; }
      .label { color: #94a3b8; }
      .repost-ages, .repost-note { display: block; }
      .spinner {
        width: 22px; height: 22px; margin: 12px auto;
        border: 3px solid #334155; border-top-color: #94a3b8;
        border-radius: 50%; animation: spin .8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      ul { list-style: none; margin: 10px 0 0; padding: 0; }
      li { padding: 6px 0; border-top: 1px solid #334155; }
      .factor-label { display: block; color: #94a3b8; }
      .factor-head { display: flex; align-items: flex-start; gap: 8px; }
      .factor-head > span { flex: 1; }
      .why { margin-left: auto; background: transparent; color: #94a3b8; padding: 0 2px; }
      .explain { display: none; }
      .explain.open { display: block; }
      .explain .label { display: block; }
    `;
    shadow.append(style, document.createElement('div'));
    document.documentElement.appendChild(host);
    setupDrag();
    loadPosition();
  }

  function panel() {
    return shadow.querySelector('div');
  }

  function rememberExpanded(next) {
    expanded = next;
    expandedTouched = true;

    try {
      const write = chrome.storage.local.set({ [EXPANDED_KEY]: expanded });

      if (write && typeof write.catch === 'function') {
        write.catch(() => {});
      }
    } catch {
      // The choice still applies for this page view.
    }
  }

  async function loadPosition() {
    try {
      const stored = await chrome.storage.local.get([POSITION_KEY, EXPANDED_KEY]);
      const pos = stored[POSITION_KEY];

      if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
        host.style.left = `${pos.left}px`;
        host.style.top = `${pos.top}px`;
        host.style.right = 'auto';
        host.style.bottom = 'auto';
      }

      if (!expandedTouched && typeof stored[EXPANDED_KEY] === 'boolean' && stored[EXPANDED_KEY] !== expanded) {
        expanded = stored[EXPANDED_KEY];

        if (shown === 'score') {
          renderScore(latest);
        } else if (shown === 'local') {
          renderLocal(localJob, latest, localRequest, localNote);
        }
      }
    } catch {
      // The widget still opens at the default corner, expanded.
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setupDrag() {
    let origin = null;

    host.addEventListener('pointerdown', (event) => {
      const path = event.composedPath();

      if (!path.some((node) => node?.classList?.contains('bar'))) {
        return;
      }

      const rect = host.getBoundingClientRect();
      origin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      host.setPointerCapture(event.pointerId);
    });

    host.addEventListener('pointermove', (event) => {
      if (!origin) {
        return;
      }

      host.style.left = `${origin.left + event.clientX - origin.x}px`;
      host.style.top = `${origin.top + event.clientY - origin.y}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });

    host.addEventListener('pointerup', async () => {
      if (!origin) {
        return;
      }

      origin = null;
      const rect = host.getBoundingClientRect();

      try {
        await chrome.storage.local.set({
          [POSITION_KEY]: { left: rect.left, top: rect.top }
        });
      } catch {
        // Position is kept for this page view.
      }
    });
  }

  function renderLoading() {
    ensureHost();
    shown = 'loading';
    panel().innerHTML = `
      <div class="panel">
        <div class="bar"><span class="title">Ghost Job Detector</span></div>
        <div class="spinner" role="status" aria-label="Analyzing this job"></div>
        <p class="label">Analyzing this job…</p>
      </div>
    `;
  }

  function explainLines(factor) {
    return (Array.isArray(factor?.explain) ? factor.explain : []).filter(Boolean).slice(0, 3);
  }

  function whyControl(lines) {
    if (!lines.length) {
      return { button: '', notes: '' };
    }

    return {
      button: '<button type="button" class="why" id="ghd-why" aria-expanded="false" aria-label="Why this description score">▸</button>',
      notes: `<div class="explain">${lines.map((line) => `<span class="label">${escapeHtml(line)}</span>`).join('')}</div>`
    };
  }

  function bindWhy() {
    shadow.getElementById('ghd-why')?.addEventListener('click', (event) => {
      const button = event.currentTarget;
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.textContent = open ? '▾' : '▸';
      button.parentElement?.nextElementSibling?.classList.toggle('open', open);
    });
  }

  function factorMarkup(factor) {
    const tooltip = factor.tooltip ? ` title="${escapeHtml(factor.tooltip)}"` : '';
    const entries = Array.isArray(factor.entries) ? factor.entries : [];
    const entryMarkup = entries.length
      ? `<span class="label repost-ages">${entries.map((entry) => {
        const link = entry.href
          ? ` <a href="${escapeHtml(entry.href)}" target="_blank" rel="noreferrer" title="${escapeHtml(entry.title || 'This posting may have been removed.')}">${escapeHtml(entry.linkLabel || 'source')}</a>`
          : '';

        return `${escapeHtml(entry.text || '')}${link}`;
      }).join(', ')}</span>`
      : '';
    const detail = factor.detail
      ? `<span class="label repost-note">${escapeHtml(factor.detail)}</span>`
      : '';
    const link = !entries.length && factor.href
      ? ` <a href="${escapeHtml(factor.href)}" target="_blank" rel="noreferrer">${escapeHtml(factor.linkLabel || 'source')}</a>`
      : '';
    const why = whyControl(explainLines(factor));

    return `<li${tooltip}><div class="factor-head"><span><span class="factor-label">${escapeHtml(factor.label)}</span>${escapeHtml(factor.value || '')}${entryMarkup}${detail}${link}</span>${why.button}</div>${why.notes}</li>`;
  }

  function scoreMarkup(analysis, { note = '', action = '' } = {}) {
    const rawScore = Number(analysis?.score?.score);
    const score = Number.isFinite(rawScore) ? rawScore : 0;
    const classified = Number.isFinite(rawScore) ? heuristics().classifyScore(score) : null;
    const label = String(classified?.label || analysis?.score?.label || '').split(': ').pop();
    const color = colorFor(score);
    const radius = 28;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;
    const counted = Number(analysis?.informativeCount);
    const withheld = analysis?.scoreWithheld === true;
    const waiting = analysis?.scorePending === true;
    const serverScore = !withheld && analysis?.partial === true && Number.isFinite(Number(analysis?.score?.score));
    const enough = serverScore || (!waiting && !withheld && Number.isFinite(counted) && counted >= MIN_INFORMATIVE_FACTORS);
    const careers = analysis?.careers?.show
      ? `<li title="${escapeHtml(analysis.careers.tooltip || '')}"><div class="factor-head"><span>${escapeHtml(analysis.careers.text || '⚠️ Not found on the company\'s careers board')}</span></div></li>`
      : '';
    const factors = expanded
      ? `<ul>${(analysis.factors || []).map(factorMarkup).join('')}${careers}</ul>`
      : '';
    const ring = enough
      ? `<circle cx="36" cy="36" r="${radius}" fill="none" stroke="#334155" stroke-width="6"></circle>
            <circle cx="36" cy="36" r="${radius}" fill="none" stroke="${color}" stroke-width="6"
              stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
              stroke-linecap="round" transform="rotate(-90 36 36)"></circle>`
      : '<circle cx="36" cy="36" r="28" fill="none" stroke="#334155" stroke-width="6"></circle>';
    const scoreLine = `<div class="number">${score}</div><div class="label">${escapeHtml(label)}</div>`;
    const readout = withheld
      ? '<div class="label">Some checks took too long</div>'
      : waiting
        ? '<div class="label">Checking...</div>'
        : enough
          ? scoreLine
          : '<div class="label">Not enough data to score</div>';
    const retry = (withheld || analysis?.partial === true) && !waiting && !analysis?.retrying
      ? '<button type="button" id="ghd-retry">Try again</button>'
      : '';

    return `
      <div class="panel">
        <div class="bar"><span class="title">Ghost Job Detector</span></div>
        <div class="score-row">
          <svg class="ring" viewBox="0 0 72 72" aria-hidden="true">
            ${ring}
          </svg>
          <div>
            ${readout}
            ${note}
          </div>
          <button type="button" id="ghd-expand">${expanded ? 'Hide' : 'Expand'}</button>
          ${retry}
          ${action}
        </div>
        ${factors}
      </div>
    `;
  }

  function renderUnread() {
    ensureHost();
    shown = 'unread';
    latest = null;
    panel().innerHTML = `
      <div class="panel">
        <div class="bar"><span class="title">Ghost Job Detector</span></div>
        <p class="label">Unable to read this posting</p>
      </div>
    `;
  }

  function renderScore(analysis) {
    ensureHost();
    shown = 'score';
    checking = analysis?.scorePending === true || analysis?.retrying === true;
    latest = analysis;
    panel().innerHTML = scoreMarkup(analysis);
    bindWhy();
    shadow.getElementById('ghd-expand')?.addEventListener('click', () => {
      rememberExpanded(!expanded);
      renderScore(latest);
    });
    shadow.getElementById('ghd-retry')?.addEventListener('click', () => {
      const state = checks.get(currentKey);

      if (!state?.job || state.analysis?.retrying || state.analysis?.scorePending) {
        return;
      }

      const next = { ...state.analysis, retrying: true };
      rememberCheck(currentKey, { ...state, analysis: next });
      renderScore(next);
      runFullCheck(state.job, state.local, true);
    });
  }

  function factorItem(label, value, detail, pending, tooltip = '', explain = []) {
    const title = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
    const extra = detail ? ` <span class="label">${escapeHtml(detail)}</span>` : '';
    const why = whyControl(explainLines({ explain }));
    return `<li class="${pending ? 'pending' : ''}"${title}><div class="factor-head"><span><span class="factor-label">${escapeHtml(label)}</span>${escapeHtml(value)}${extra}</span>${why.button}</div>${why.notes}</li>`;
  }

  function readPostedPay(job) {
    const snippet = heuristics()?.salarySnippet?.(job?.description, job?.salary) || '';
    const parsed = globalThis.GhdPay?.parsePostedPay?.(snippet) || { ok: false, comparable: false, listed: '' };

    return { ...parsed, snippet };
  }

  // Display only. The score functions never receive this row.
  function payFactor(job, result) {
    const posted = readPostedPay(job);

    if (!posted.ok) {
      return { label: 'Pay vs market', value: 'Salary not listed', detail: '', score: 0 };
    }

    if (result?.compared && result.text) {
      return {
        label: 'Pay vs market',
        value: result.text,
        detail: result.note || '',
        score: 0
      };
    }

    return { label: 'Pay vs market', value: posted.listed, detail: '', score: 0 };
  }

  function appendPay(factors, job) {
    const row = payFactor(job, checks.get(jobKey(job))?.payResult);

    return [...(factors || []).filter((factor) => factor.label !== 'Pay vs market'), row];
  }

  function localFactorList(local, job) {
    const evidence = local?.evidence || {};
    const built = heuristics().buildFactors(
      evidence.vagueness,
      { unavailable: true, detected: false, score: 0 },
      evidence.workforce,
      { unavailable: true, rating: null, score: 0 },
      { unavailable: true, available: false, score: 0 }
    );
    const clarity = built.find((factor) => factor.label === 'Description Clarity');
    const workforce = evidence.workforce?.available
      ? built.find((factor) => factor.label === 'Company size')
      : null;
    const pending = (label) => factorItem(label, 'Not checked yet', '', true);

    return [
      factorItem(clarity?.label || 'Description Clarity', clarity?.value || 'Unknown', clarity?.detail || '', false, '', clarity?.explain),
      workforce
        ? factorItem(workforce.label, workforce.value, workforce.detail, false, workforce.tooltip)
        : pending('Company size'),
      pending('Recent Layoffs'),
      pending('Company Reviews'),
      pending('Reposts')
    ].join('');
  }

  function renderLocal(job, local, id, note = '') {
    ensureHost();
    shown = 'local';
    latest = local;
    localJob = job;
    localRequest = id;
    localNote = note;
    const action = checking
      ? '<span class="label">Checking…</span>'
      : '<button type="button" id="ghd-full">Run full check</button>';
    const factors = expanded ? `<ul>${localFactorList(local, job)}</ul>` : '';
    const retry = note ? `<span class="note">${escapeHtml(note)}</span>` : '';

    panel().innerHTML = `
      <div class="panel">
        <div class="bar"><span class="title">Ghost Job Detector</span></div>
        <div class="score-row">
          <svg class="ring" viewBox="0 0 72 72" aria-hidden="true">
            <circle cx="36" cy="36" r="28" fill="none" stroke="#334155" stroke-width="6"></circle>
          </svg>
          <div>
            <div class="number pending">—</div>
            <div class="label">Not yet checked</div>
            ${retry}
          </div>
          <button type="button" id="ghd-expand">${expanded ? 'Hide' : 'Expand'}</button>
          ${action}
        </div>
        ${factors}
      </div>
    `;
    bindWhy();
    shadow.getElementById('ghd-expand')?.addEventListener('click', () => {
      rememberExpanded(!expanded);
      renderLocal(localJob, latest, localRequest, localNote);
    });
    shadow.getElementById('ghd-full')?.addEventListener('click', () => {
      const button = shadow.getElementById('ghd-full');

      if (!button || checking) {
        return;
      }

      checking = true;
      button.disabled = true;
      const pending = document.createElement('span');
      pending.className = 'label';
      pending.textContent = 'Checking…';
      button.replaceWith(pending);
      runFullCheck(localJob || job, local);
    });
  }

  function trackIdentity(promise) {
    const flight = Promise.resolve(promise).then((value) => value, () => null);
    identityFlight = flight;
    flight.finally(() => {
      if (identityFlight === flight) {
        identityFlight = null;
      }
    });
    return flight;
  }

  function awaitIdentity(flight) {
    if (!flight) {
      return Promise.resolve();
    }

    return Promise.race([
      flight,
      new Promise((resolve) => setTimeout(resolve, IDENTITY_WAIT_MS))
    ]);
  }

  // The check belongs to the job it was started on. It always finishes and is
  // remembered; it is drawn only while that job is the one on screen.
  async function runFullCheck(job, local, refresh = false) {
    const key = jobKey(job);
    const clicked = performance.now();
    // Taken now: by the time it settles, identityFlight may belong to another job.
    const flight = identityFlight;
    const identityPending = Boolean(flight);
    const previous = checks.get(key);
    const kept = previous?.analysis;
    rememberCheck(key, { status: 'running', job, local, analysis: kept });

    try {
      const identity = await awaitIdentity(flight);
      const identityWaitMs = Math.round(performance.now() - clicked);
      const current = key === currentKey && localJob ? localJob : job;
      const named = identity?.ready && identity.company
        ? { ...current, company: identity.company }
        : current;

      if (key === currentKey && named !== localJob) {
        localJob = named;
      }

      const capturedHeadcount = await capturedHeadcountFor(named);
      const remotePromise = sendEnrichment(named, capturedHeadcount, refresh);
      const repostPromise = requestReposts(named);
      const remote = await remotePromise;

      if (!remote?.ok || !remote.analysis) {
        throw new Error(remote?.error || 'ENRICH_FAILED');
      }

      const idDates = await jobAgePairs(named);
      let careersNotice = remote.analysis.careers?.show ? remote.analysis.careers : null;
      const partial = withPendingReposts(mergeRemote(local, {
        ...remote.analysis,
        factors: {
          ...(remote.analysis.factors || {}),
          reposts: { pending: true, score: 0, unavailable: true, available: false, matches: [] }
        }
      }, idDates, named));
      rememberCheck(key, { status: 'partial', job: named, local, analysis: partial });

      if (key === currentKey) {
        renderScore(partial);
      }

      if (remote.analysis.careersChecked === false) {
        requestCareers(named).then((notice) => {
          if (!notice?.show) {
            return;
          }

          careersNotice = notice;
          const state = checks.get(key);

          if (!state?.analysis) {
            return;
          }

          const next = { ...state.analysis, careers: notice, careersChecked: true };
          rememberCheck(key, { ...state, analysis: next });

          if (key === currentKey) {
            renderScore(next);
          }
        }).catch(() => {});
      }

      if (remote.analysis.payCompareEnabled === true) {
        beginPayComparison(key, named);
      }

      const serverReposts = remote.analysis.factors?.reposts;
      const unfinished = { unavailable: true, available: false, score: 0, detail: 'Repost check did not finish.' };
      let reposts = serverReposts?.pending ? unfinished : (serverReposts || unfinished);
      let repostTiming = {};

      try {
        const repostRemote = await repostPromise;
        const repostsFactor = repostRemote?.reposts || repostRemote?.analysis?.factors?.reposts;

        if (repostRemote?.ok && repostsFactor) {
          reposts = repostsFactor;
          repostTiming = repostRemote.clientTiming || repostRemote.analysis?.clientTiming || {};
        }
      } catch {
        reposts = serverReposts?.pending ? unfinished : (serverReposts || unfinished);
      }

      const analysis = {
        ...mergeRemote(local, {
          ...remote.analysis,
          careers: careersNotice,
          careersChecked: true,
          factors: {
            ...(remote.analysis.factors || {}),
            reposts
          }
        }, idDates, named),
        careers: careersNotice
      };
      console.info('[GHD] full check timing', {
        company: named.company,
        totalMs: Math.round(performance.now() - clicked),
        identityPending,
        identityWaitMs,
        serverCached: Boolean(remote.analysis.cached),
        shownOnFinish: key === currentKey,
        main: remote.analysis.clientTiming || {},
        reposts: repostTiming
      });
      const keptPay = checks.get(key);
      rememberCheck(key, {
        status: 'done',
        job: named,
        local,
        analysis,
        payStarted: keptPay?.payStarted === true,
        payResult: keptPay?.payResult || null
      });

      if (key === currentKey) {
        renderScore(analysis);
      }
    } catch {
      const current = checks.get(key);
      const keptAnalysis = current?.analysis;

      if (keptAnalysis?.scoreWithheld || keptAnalysis?.partial) {
        const next = { ...keptAnalysis, retrying: false };
        rememberCheck(key, {
          status: 'done',
          job: current?.job || job,
          local,
          analysis: next
        });

        if (key === currentKey) {
          checking = false;
          renderScore(next);
        }

        return;
      }

      rememberCheck(key, { status: 'failed', job, local });

      if (key === currentKey) {
        checking = false;
        renderLocal(job, local, localRequest, 'Full check unavailable — try again');
      }
    }
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      const storage = globalThis.chrome?.storage?.local;

      if (!storage?.get) {
        resolve({});
        return;
      }

      let settled = false;
      const finish = (items) => {
        if (!settled) {
          settled = true;
          resolve(items || {});
        }
      };
      const result = storage.get(keys, finish);

      if (result && typeof result.then === 'function') {
        result.then(finish).catch(() => finish({}));
      }
    });
  }

  async function capturedHeadcountFor(job) {
    const api = globalThis.GhdHeadcount;

    if (!api) {
      return null;
    }

    const slugs = api.lookupSlugs(job?.companySlug || job?.slug, job?.company);
    const keys = slugs.map((slug) => api.storageKey(slug)).filter(Boolean);

    if (!keys.length) {
      return null;
    }

    const stored = await storageGet(keys);
    const found = api.freshHeadcount(stored, slugs);
    console.info('[GHD] captured headcount', found
      ? { company: job?.company || '', slug: found.slug, employees: found.employees }
      : { company: job?.company || '', slug: job?.companySlug || job?.slug || '', found: false });
    return found;
  }

  function sendEnrichment(job, capturedHeadcount, refresh = false) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ENRICH_TIMEOUT')), ENRICH_WAIT_MS);
      chrome.runtime.sendMessage({
        type: 'ENRICH_JOB',
        body: {
          title: job.title,
          company: job.company,
          description: job.description || '',
          salary: job.salary || '',
          deferReposts: true,
          url: job.url || '',
          hostname: globalThis.location?.hostname || '',
          platform: job.platform || '',
          jobId: job.jobId || '',
          postedLabel: job.postedLabel || '',
          location: job.jobLocation || '',
          locationNormalized: job.locationNormalized || '',
          companySlug: job.companySlug || job.slug || '',
          openJobsCount: job.openJobsCount || null,
          openJobsPageUrl: job.openJobsPageUrl || '',
          openJobsCompanyId: job.openJobsCompanyId || '',
          openJobsAllMatch: job.openJobsAllMatch === true,
          capturedHeadcount,
          ...(refresh ? { refresh: true } : {})
        }
      }).then((remote) => {
        clearTimeout(timer);
        resolve(remote);
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function requestCareers(job) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'CAREERS_JOB',
        body: {
          title: job.title,
          company: job.company,
          url: job.url || '',
          hostname: globalThis.location?.hostname || '',
          platform: job.platform || ''
        }
      }).then((remote) => {
        if (!remote?.ok) {
          resolve(null);
          return;
        }

        resolve(remote.careers || remote.analysis?.careers || (remote.analysis?.show ? remote.analysis : null));
      }).catch(reject);
    });
  }

  function requestPay(job, posted) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'PAY_MARKET',
        body: {
          title: job.title || '',
          company: job.company || '',
          location: job.jobLocation || '',
          locationNormalized: job.locationNormalized || '',
          salary: posted?.snippet || '',
          description: job.description || ''
        }
      }).then((remote) => {
        resolve(remote);
      }).catch(() => {
        resolve({ ok: false });
      });
    });
  }

  function beginPayComparison(key, job) {
    const state = checks.get(key);

    if (!state || state.payStarted) {
      return;
    }

    const posted = readPostedPay(job);
    const experience = globalThis.GhdPay?.experienceChoice?.(
      job?.title,
      `${job?.description || ''}\n${job?.salary || ''}`
    );

    if (!posted.comparable || experience?.skip) {
      return;
    }

    rememberCheck(key, { ...state, payStarted: true });
    requestPay(job, posted).then((remote) => {
      const body = remote?.ok ? (remote.pay || remote.analysis) : null;

      if (!body?.compared || !body.text) {
        return;
      }

      const current = checks.get(key);

      if (!current) {
        return;
      }

      rememberCheck(key, { ...current, payResult: body });
      const stored = checks.get(key);
      const next = stored?.analysis
        ? { ...stored.analysis, factors: appendPay(stored.analysis.factors, stored.job || job) }
        : null;

      if (next) {
        rememberCheck(key, { ...stored, analysis: next });
      }

      if (next && key === currentKey) {
        renderScore(next);
      }
    }).catch(() => {});
  }

  function requestReposts(job) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('REPOST_TIMEOUT')), REPOST_WAIT_MS);
      chrome.runtime.sendMessage({
        type: 'REPOST_JOB',
        body: {
          title: job.title,
          company: job.company,
          description: job.description || '',
          url: job.url || '',
          hostname: globalThis.location?.hostname || '',
          platform: job.platform || '',
          jobId: job.jobId || '',
          postedLabel: job.postedLabel || '',
          location: job.jobLocation || '',
          locationNormalized: job.locationNormalized || '',
          companySlug: job.companySlug || job.slug || ''
        }
      }).then((remote) => {
        clearTimeout(timer);
        resolve(remote);
      }).catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function withPendingReposts(analysis) {
    return {
      ...analysis,
      scorePending: true,
      factors: (analysis.factors || []).map((factor) => (factor.label === 'Reposts'
        ? { ...factor, value: 'Checking...', detail: '', entries: [], href: '', indicator: null }
        : factor))
    };
  }

  async function analyze(job) {
    if (!job?.title || !job?.company || !heuristics()) {
      return;
    }

    const id = requestId + 1;
    requestId = id;
    const key = jobKey(job);
    currentKey = key;
    const previous = checks.get(key);

    if (previous?.analysis && (previous.status === 'done' || previous.status === 'partial' || previous.status === 'running')) {
      // Coming back to a job whose check finished, whose rows are up while
      // reposts are in flight, or whose retry is still running. Finished rows
      // stay on screen.
      localJob = previous.job;
      renderScore(previous.analysis);
      return;
    }

    checking = previous?.status === 'running';
    renderLoading();

    let local;

    try {
      local = await heuristics().analyzeJob(job);
    } catch {
      local = null;
    }

    if (id !== requestId) {
      return;
    }

    if (!local) {
      renderUnread();
      return;
    }

    const company = pendingCompany || job.company;
    const resolved = company === job.company ? job : { ...job, company };
    pendingCompany = '';
    const state = checks.get(key);
    // The check may have finished while the local analysis was running.
    if (state?.status === 'done') {
      checking = false;
      localJob = state.job;
      renderScore(state.analysis);
      return;
    }

    checking = state?.status === 'running';
    renderLocal(resolved, local, id, state?.status === 'failed' ? 'Full check unavailable — try again' : '');
  }

  function setCompany(company) {
    const name = String(company || '').trim();

    if (!name) {
      return;
    }

    if (localJob) {
      localJob = { ...localJob, company: name };
      return;
    }

    pendingCompany = name;
  }

  return { analyze, setCompany, trackIdentity };
});
