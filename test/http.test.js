'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { request, retryDelay } = require('../src/http');

function context(extra = {}) {
  return { config: { retries: 1, timeout: 20, skipDuplicate: true }, signal: new AbortController().signal,
    info: () => {}, sleep: async () => {}, ...extra };
}

test('Retry-After supports seconds, HTTP dates, past dates, malformed values, and a hard limit', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  assert.equal(retryDelay('12', 0), 12000);
  assert.equal(retryDelay('Mon, 12 Oct 2026 12:00:30 GMT', 0, () => 0, now), 30000);
  assert.equal(retryDelay('Mon, 12 Oct 2026 11:59:00 GMT', 0, () => 0, now), 0);
  assert.equal(retryDelay('nonsense', 2, () => 0), 20000);
  assert.equal(retryDelay(null, 10, () => 0), 60000);
  assert.throws(() => retryDelay('99999999999999999999', 0), /five minutes/);
});

test('per-attempt timer aborts hanging request and retries within the configured bound', async () => {
  let calls = 0;
  const ctx = context({ fetch: (url, options) => new Promise((resolve, reject) => {
    calls++;
    options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  }) });
  await assert.rejects(request('https://feed.example', async () => ({}), ctx), /after 2 attempt/);
  assert.equal(calls, 2);
});

test('index body read is covered by per-attempt timeout', async () => {
  const ctx = context({ fetch: async (url, options) => ({ ok: true, text: () => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('body stalled')), { once: true });
  }) }) });
  await assert.rejects(request('https://feed.example', async () => ({}), ctx, { json: true }), /after 2 attempt/);
});

test('cleanup failure cannot turn authentication rejection into retry', async () => {
  let calls = 0;
  const ctx = context({ fetch: async () => { calls++; return { status: 401, ok: false, body: { cancel: async () => { throw new Error('cleanup'); } } }; } });
  await assert.rejects(request('https://feed.example', async () => ({}), ctx), /HTTP 401/);
  assert.equal(calls, 1);
});

test('invalid JSON fails without retry; service errors retry index discovery', async () => {
  let calls = 0;
  const ctx = context({ fetch: async () => { calls++; return calls === 1 ? new Response(null, { status: 503 }) : Response.json({ resources: [] }); } });
  assert.deepEqual(await request('https://feed.example', async () => ({}), ctx, { json: true }), { resources: [] });
  ctx.fetch = async () => new Response('not-json');
  await assert.rejects(request('https://feed.example', async () => ({}), ctx, { json: true }), /invalid JSON/);
});
