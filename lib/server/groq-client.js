const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

export async function askGroq(prompt, options = {}) {
  const timeoutMs = options.timeoutMs ?? 4000;
  const temperature = options.temperature ?? 0;
  const env = options.env || {};
  console.info('[GHD] groq key check', {
    present: !!env.GROQ_API_KEY,
    length: (env.GROQ_API_KEY || '').length
  });
  const apiKey = String(env.GROQ_API_KEY || '').trim();

  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const fetchImpl = options.fetch || fetch;
  const response = await fetchImpl(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: options.model || DEFAULT_MODEL,
      temperature,
      messages: [{ role: 'user', content: String(prompt || '') }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const body = typeof response.text === 'function' ? await response.text() : '';
    console.info('[GHD] groq http error', {
      url: String(GROQ_URL),
      model: options.model || DEFAULT_MODEL,
      status: response.status,
      body: String(body).slice(0, 300)
    });
    throw new Error(`Groq request failed (${response.status})`);
  }

  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;

  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Groq returned an empty response');
  }

  return text.trim();
}
