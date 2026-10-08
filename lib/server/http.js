const CLIENT_HEADER = 'ghost-job-detector';

export function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  const allowed =
    !origin ||
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1');

  if (allowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GHD-Client, X-GHD-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = String(raw || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();

  return ip.slice(0, 64) || 'unknown';
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return req.body ? JSON.parse(req.body) : {};
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

export function requireClient(req, res) {
  if (req.headers['x-ghd-client'] !== CLIENT_HEADER) {
    sendJson(res, 403, { error: 'Forbidden' });
    return false;
  }

  return true;
}

export function cleanString(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function incomingPages(body) {
  if (body?.clientHtml && typeof body.clientHtml === 'object') {
    return body.clientHtml;
  }

  return body?.webPages || {};
}

function readCapturedHeadcount(value) {
  const employees = Number(value?.employees);
  const capturedAt = Number(value?.capturedAt);
  const slug = cleanString(value?.slug, 120).toLowerCase().replace(/[^a-z0-9-]+/g, '');

  if (!slug || !Number.isFinite(employees) || employees <= 0 || !Number.isFinite(capturedAt)) {
    return null;
  }

  return {
    slug,
    employees: Math.round(employees),
    capturedAt
  };
}

export function validateJobBody(body) {
  const title = cleanString(body?.title, 200);
  const company = cleanString(body?.company, 200);
  const description = cleanString(body?.description, 20000);
  const url = cleanString(body?.url, 2000);
  const platform = cleanString(body?.platform, 40).toUpperCase();
  const postedLabel = cleanString(body?.postedLabel, 40);
  const location = cleanString(body?.locationNormalized || body?.location, 120);
  const jobId = cleanString(body?.jobId, 40);
  const pages = incomingPages(body);

  if (!title || !company) {
    return { error: 'title and company are required' };
  }

  return {
    value: {
      title,
      company,
      description,
      salary: cleanString(body?.salary, 500),
      url,
      hostname: cleanString(body?.hostname, 200),
      platform: platform || 'UNKNOWN',
      postedLabel,
      location,
      jobId,
      companySlug: cleanString(body?.companySlug, 120).toLowerCase(),
      openJobsCount: (() => {
        const count = Number(body?.openJobsCount);
        return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
      })(),
      openJobsPageUrl: cleanString(body?.openJobsPageUrl, 2000),
      openJobsCompanyId: cleanString(body?.openJobsCompanyId, 40).replace(/\D/g, ''),
      openJobsAllMatch: body?.openJobsAllMatch === true,
      deferReposts: body?.deferReposts === true,
      refresh: body?.refresh === true,
      capturedHeadcount: readCapturedHeadcount(body?.capturedHeadcount),
      // Only the extension's DuckDuckGo repost prefetch is read. Review,
      // layoff and company-page HTML from the request is ignored: anyone can
      // send it, and results built from it would reach other users' checks.
      clientHtml: {
        reposts: cleanString(pages.reposts, 80000)
      }
    }
  };
}

export function validateCompanyBody(body) {
  const company = cleanString(body?.company, 200);

  if (!company) {
    return { error: 'company is required' };
  }

  return {
    value: {
      company,
      // Review HTML from the request is ignored, for the same reason as above.
      clientHtml: ''
    }
  };
}
