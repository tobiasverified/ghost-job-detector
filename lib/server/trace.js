// Per-request timing. Every wrapped call records when it started (ms after the
// request began) and how long it took, then the request logs one summary line.
export function createTrace(label) {
  const started = performance.now();
  const spans = [];

  async function span(name, work) {
    const start = performance.now();
    let ok = true;

    try {
      return await work();
    } catch (error) {
      ok = false;
      throw error;
    } finally {
      spans.push({
        name: String(name).replace(/\s+/g, ' ').slice(0, 90),
        at: Math.round(start - started),
        ms: Math.round(performance.now() - start),
        ...(ok ? {} : { failed: true })
      });
    }
  }

  function wrap(fn, describe) {
    if (typeof fn !== 'function') {
      return fn;
    }

    return (...args) => span(describe(...args), () => fn(...args));
  }

  function report(extra = {}) {
    const ordered = [...spans].sort((left, right) => left.at - right.at);
    console.info('[GHD] timing', JSON.stringify({
      label,
      totalMs: Math.round(performance.now() - started),
      ...extra,
      spans: ordered
    }));
  }

  return { span, wrap, report };
}

function describeUrl(input) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url);
    const action = url.searchParams.get('action');
    return `${url.hostname}${url.pathname.slice(0, 40)}${action ? `?action=${action}` : ''}`;
  } catch {
    return 'unknown-url';
  }
}

// Wraps the network-facing dependencies of one request so every call is timed.
export function tracedDependencies(deps, trace) {
  const cache = deps.cache
    ? {
      get: trace.wrap(deps.cache.get?.bind(deps.cache), (key) => `cache.get ${key}`),
      set: trace.wrap(deps.cache.set?.bind(deps.cache), (key) => `cache.set ${key}`)
    }
    : deps.cache;

  return {
    ...deps,
    cache,
    trace,
    fetch: trace.wrap(deps.fetch, (input) => `fetch ${describeUrl(input)}`),
    askGroq: trace.wrap(deps.askGroq, (prompt) => `groq: ${String(prompt || '').slice(0, 60)}`),
    webSearch: trace.wrap(deps.webSearch, (query) => `tavily: ${query}`),
    searchNews: trace.wrap(deps.searchNews, (query) => `newsdata: ${query}`)
  };
}
