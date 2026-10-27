// Worker for fieldserviceleads.com. Static assets are served by Workers
// Static Assets; wrangler.jsonc routes only /api/* through this script
// (assets.run_worker_first), so every other path never reaches it.
//
// POST /api/waitlist accepts the JSON body Waitlist.astro sends and answers
// { ok: true } or { ok: false, error } exactly as that script expects.

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  WAITLIST?: KVNamespace;
  WAITLIST_RATE_LIMITER?: RateLimit;
}

const MAX_BODY_BYTES = 4096;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FSM_OPTIONS = new Set(['', 'Jobber', 'ServiceTitan', 'Housecall Pro', 'Other']);

function json(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function field(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function waitlist(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, { allow: 'POST' });
  }

  // Browsers always send Origin on a cross-origin or fetch POST; refuse posts
  // from other sites so the endpoint cannot be driven from someone else's page.
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return json({ ok: false, error: 'unsupported_media_type' }, 415);
  }

  if (env.WAITLIST_RATE_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.WAITLIST_RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ ok: false, error: 'rate_limited' }, 429);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'payload_too_large' }, 413);
  }

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    data = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // Honeypot: real visitors never see or fill `company`. Answer like a
  // success so bots get no signal, and store nothing.
  if (field(data.company, 200) !== '') return json({ ok: true });

  const email = field(data.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid_email' }, 400);

  if (!env.WAITLIST) return json({ ok: false, error: 'unavailable' }, 503);

  const key = `signup:${email}`;
  // A repeat signup keeps the first record; the visitor still sees success.
  if ((await env.WAITLIST.get(key)) === null) {
    const fsm = field(data.fsm, 40);
    const cf = (request as Request & { cf?: { country?: string } }).cf;
    await env.WAITLIST.put(key, JSON.stringify({
      email,
      fsm: FSM_OPTIONS.has(fsm) ? fsm : '',
      source: field(data.source, 200),
      page: field(data.page, 200),
      country: cf?.country ?? '',
      createdAt: new Date().toISOString(),
    }));
  }
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/waitlist') return await waitlist(request, env);
      // Only reachable if the platform routes a non-/api path here; keep the
      // static site (and its 404 page) in charge of it.
      if (!pathname.startsWith('/api/') && env.ASSETS) return env.ASSETS.fetch(request);
      return json({ ok: false, error: 'not_found' }, 404);
    } catch (err) {
      console.error('waitlist handler failed', err);
      return json({ ok: false, error: 'server_error' }, 500);
    }
  },
};
