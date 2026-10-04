function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function unwrapDuckDuckGoUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');

    if (target) {
      return target;
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
  } catch {
    return '';
  }

  return '';
}

export function parseDuckDuckGoHtml(html) {
  const results = [];
  const blocks = String(html || '').split(/class="(?:result__body|links_main|web-result)/i).slice(1);

  for (const block of blocks) {
    const linkMatch =
      block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);

    if (!linkMatch) {
      continue;
    }

    const snippetMatch =
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/i);

    const url = unwrapDuckDuckGoUrl(decodeHtml(linkMatch[1]));

    if (!url) {
      continue;
    }

    results.push({
      url,
      title: stripTags(linkMatch[2]),
      snippet: stripTags(snippetMatch?.[1] || ''),
      source: 'duckduckgo'
    });
  }

  if (results.length) {
    return results;
  }

  const anchorPattern = /<a\b[^>]*href="([^"]*uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let anchorMatch = anchorPattern.exec(String(html || ''));

  while (anchorMatch) {
    const url = unwrapDuckDuckGoUrl(decodeHtml(anchorMatch[1]));
    const title = stripTags(anchorMatch[2]);

    if (url && title) {
      results.push({
        url,
        title,
        snippet: '',
        source: 'duckduckgo'
      });
    }

    anchorMatch = anchorPattern.exec(String(html || ''));
  }

  if (results.length) {
    return results;
  }

  const extraPatterns = [
    /<a\b[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a\b[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi
  ];

  for (const pattern of extraPatterns) {
    let extra = pattern.exec(String(html || ''));

    while (extra) {
      const url = unwrapDuckDuckGoUrl(decodeHtml(extra[1]));
      const title = stripTags(extra[2]);

      if (url && title && !/duckduckgo\.com|search\.brave\.com|bing\.com\/ck\/a/i.test(url)) {
        results.push({
          url,
          title,
          snippet: '',
          source: 'duckduckgo'
        });
      }

      extra = pattern.exec(String(html || ''));
    }

    pattern.lastIndex = 0;
  }

  const braveBlocks = String(html || '').split(/data-type="web"/i).slice(1);

  for (const block of braveBlocks) {
    const linkMatch = block.match(/href="(https?:\/\/[^"]+)"/i);

    if (!linkMatch) {
      continue;
    }

    const url = unwrapDuckDuckGoUrl(decodeHtml(linkMatch[1]));
    const title = stripTags(block.slice(0, 1200)).slice(0, 180);

    if (url && title && !/search\.brave\.com|imgs\.search\.brave\.com/i.test(url)) {
      results.push({
        url,
        title,
        snippet: '',
        source: 'brave'
      });
    }
  }

  return results;
}

export function parseTavilyJson(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];

  return rows
    .map((row) => ({
      url: String(row?.url || ''),
      title: stripTags(row?.title),
      snippet: stripTags(row?.content),
      source: 'tavily'
    }))
    .filter((row) => /^https?:\/\//i.test(row.url) && (row.title || row.snippet));
}

const TAVILY_URL = 'https://api.tavily.com/search';

export async function webSearch(query, options = {}) {
  const env = options.env || {};
  const apiKey = String(env.TAVILY_API_KEY || '').trim();
  console.info('[GHD] tavily key check', {
    present: Boolean(apiKey),
    length: apiKey.length
  });

  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set');
  }

  const fetchImpl = options.fetch || fetch;
  const response = await fetchImpl(TAVILY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: String(query || ''),
      // "basic" costs 1 credit per request; "advanced" costs 2.
      search_depth: 'basic',
      max_results: 10,
      // Tavily's generated answer is not retrieved text, so it is never requested.
      include_answer: false,
      ...(Array.isArray(options.includeDomains) && options.includeDomains.length
        ? { include_domains: options.includeDomains }
        : {})
    }),
    signal: AbortSignal.timeout(Math.max(options.timeoutMs || 0, 4000))
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    console.info('[GHD] tavily http error', {
      query,
      status: response.status,
      body: String(body).slice(0, 300)
    });
    throw new Error(`Search failed (${response.status})`);
  }

  return parseTavilyJson(await response.json());
}
