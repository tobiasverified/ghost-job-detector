export async function searchNewsData(query, env = process.env) {
  const apiKey = env.NEWSDATA_API_KEY;

  if (!apiKey) {
    const error = new Error('NewsData is not configured');
    error.code = 'NO_KEY';
    throw error;
  }

  const endpoint = new URL('https://newsdata.io/api/1/latest');
  endpoint.searchParams.set('q', String(query || '').slice(0, 500));
  endpoint.searchParams.set('language', 'en');

  const response = await fetch(endpoint, {
    headers: {
      'X-ACCESS-KEY': apiKey,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(4000)
  });

  if (!response.ok) {
    throw new Error(`NewsData request failed (${response.status})`);
  }

  const data = await response.json();

  if (data.status && data.status !== 'success') {
    throw new Error('NewsData request was not successful');
  }

  return (Array.isArray(data.results) ? data.results : []).map((item) => ({
    title: item.title || '',
    description: item.description || item.content || '',
    url: item.link || '',
    publishedAt: item.pubDate || null,
    source: item.source_name || item.source_id || 'NewsData.io'
  }));
}
