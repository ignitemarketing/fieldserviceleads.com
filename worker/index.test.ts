import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from './index.ts';

const URL_ = 'https://fieldserviceleads.com/api/waitlist';

function memoryKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  };
}

function limiter(success: boolean) {
  const keys: string[] = [];
  return { keys, async limit({ key }: { key: string }) { keys.push(key); return { success }; } };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://fieldserviceleads.com', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const form = { company: '', source: 'fieldserviceleads.com', page: '/', email: 'Owner@Example.com', fsm: 'Jobber' };

test('stores a valid signup and answers ok:true', async () => {
  const kv = memoryKV();
  const res = await worker.fetch(post(form), { WAITLIST: kv } as Env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const saved = JSON.parse(kv.store.get('signup:owner@example.com')!);
  assert.equal(saved.email, 'owner@example.com');
  assert.equal(saved.fsm, 'Jobber');
  assert.equal(saved.page, '/');
});

test('a repeat signup keeps the first record', async () => {
  const kv = memoryKV();
  await worker.fetch(post(form), { WAITLIST: kv } as Env);
  const first = kv.store.get('signup:owner@example.com');
  const res = await worker.fetch(post({ ...form, fsm: 'Other' }), { WAITLIST: kv } as Env);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(kv.store.get('signup:owner@example.com'), first);
});

test('rejects an invalid email with the error the form shows', async () => {
  const kv = memoryKV();
  const res = await worker.fetch(post({ ...form, email: 'not-an-email' }), { WAITLIST: kv } as Env);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { ok: false, error: 'invalid_email' });
  assert.equal(kv.store.size, 0);
});

test('honeypot submissions look successful but store nothing', async () => {
  const kv = memoryKV();
  const res = await worker.fetch(post({ ...form, company: 'Acme Bots' }), { WAITLIST: kv } as Env);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(kv.store.size, 0);
});

test('drops an unknown fsm value', async () => {
  const kv = memoryKV();
  await worker.fetch(post({ ...form, fsm: '<script>' }), { WAITLIST: kv } as Env);
  assert.equal(JSON.parse(kv.store.get('signup:owner@example.com')!).fsm, '');
});

test('only POST is allowed', async () => {
  const res = await worker.fetch(new Request(URL_), { WAITLIST: memoryKV() } as Env);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('refuses posts from another origin', async () => {
  const kv = memoryKV();
  const res = await worker.fetch(post(form, { origin: 'https://evil.example' }), { WAITLIST: kv } as Env);
  assert.equal(res.status, 403);
  assert.equal(kv.store.size, 0);
});

test('requires a JSON body', async () => {
  const res = await worker.fetch(post('email=a%40b.co', { 'content-type': 'application/x-www-form-urlencoded' }), { WAITLIST: memoryKV() } as Env);
  assert.equal(res.status, 415);
  const bad = await worker.fetch(post('{nope'), { WAITLIST: memoryKV() } as Env);
  assert.deepEqual(await bad.json(), { ok: false, error: 'invalid_json' });
  const arr = await worker.fetch(post('[]'), { WAITLIST: memoryKV() } as Env);
  assert.equal(arr.status, 400);
});

test('refuses oversized bodies', async () => {
  const res = await worker.fetch(post({ ...form, page: 'x'.repeat(5000) }), { WAITLIST: memoryKV() } as Env);
  assert.equal(res.status, 413);
});

test('rate limits per client IP', async () => {
  const kv = memoryKV();
  const rl = limiter(false);
  const res = await worker.fetch(post(form, { 'cf-connecting-ip': '203.0.113.9' }), { WAITLIST: kv, WAITLIST_RATE_LIMITER: rl } as Env);
  assert.equal(res.status, 429);
  assert.deepEqual(rl.keys, ['203.0.113.9']);
  assert.equal(kv.store.size, 0);
});

test('fails closed with 503 when storage is not bound', async () => {
  const res = await worker.fetch(post(form), {} as Env);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'unavailable' });
});

test('other /api paths are a JSON 404', async () => {
  const res = await worker.fetch(new Request('https://fieldserviceleads.com/api/other'), {} as Env);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
});

test('non-/api paths are handed back to the static assets', async () => {
  const seen: string[] = [];
  const ASSETS = { async fetch(req: Request) { seen.push(new URL(req.url).pathname); return new Response('page', { status: 200 }); } };
  const res = await worker.fetch(new Request('https://fieldserviceleads.com/pricing'), { ASSETS } as Env);
  assert.equal(await res.text(), 'page');
  assert.deepEqual(seen, ['/pricing']);
});

test('a storage failure returns a JSON 500 the form can parse', async () => {
  const kv = { async get() { throw new Error('kv down'); }, async put() {} };
  const res = await worker.fetch(post(form), { WAITLIST: kv } as Env);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: 'server_error' });
});
