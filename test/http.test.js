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

test('permanent TLS, file, DNS and unknown errors fail without retries', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOENT', 'EACCES', 'ENOTFOUND', 'ERR_INDEX_TOO_LARGE', 'UNKNOWN']) {
    let calls = 0;
    const ctx = context({ fetch: async () => { calls++; throw Object.assign(new Error('sensitive details'), { code }); } });
    await assert.rejects(request('https://feed.example', async () => ({}), ctx), error => !error.message.includes('sensitive'));
    assert.equal(calls, 1, code);
  }
});

test('temporary network failures retry and preserve the safe error code', async () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']) {
    let calls = 0;
    const ctx = context({ fetch: async () => { calls++; throw Object.assign(new Error('sensitive'), { code }); } });
    await assert.rejects(request('https://feed.example', async () => ({}), ctx), new RegExp(code));
    assert.equal(calls, 2);
  }
});

test('symbol timeout is independent and timeout diagnostics identify the phase', async () => {
  const ctx = context({ config: { retries: 0, timeout: 5, symbolTimeout: 100 }, fetch: (url, options) => new Promise((resolve, reject) => {
    options.onPhase('response');
    const timer = setTimeout(() => resolve(new Response(null, { status: 201 })), 30);
    options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('timeout')); }, { once: true });
  }) });
  const symbol = { kind: 'symbols', attempts: 0 };
  assert.equal(await request('https://feed.example', async () => ({}), ctx, { item: symbol }), 'pushed');
  const pkg = { kind: 'package', attempts: 0 };
  await assert.rejects(request('https://feed.example', async () => ({}), ctx, { item: pkg }), /response-timeout/);
  assert.equal(pkg.attemptDetails[0].reason, 'response-timeout');
});


test('failure diagnostics include selected headers and sanitized JSON only', async () => {
  const logs = [];
  const ctx = context({ config: { logResponses: true, retries: 0, timeout: 100, apiKey: 'publish-secret' }, info: message => logs.push(message),
    fetch: async () => Response.json({ error: 'Rejected publish-secret reflected-key token=hidden\n::error:: injected', apiKey: 'reflected-key' }, {
      status: 403, headers: { 'retry-after': '10', 'x-request-id': 'request-123', authorization: 'Bearer header-secret', 'set-cookie': 'cookie-secret' }
    }) });
  await assert.rejects(request('https://feed.example', async () => ({}), ctx), /HTTP 403/);
  const text = logs.join('\n');
  assert.match(text, /request-123/);
  assert.match(text, /retry-after/);
  assert.match(text, /Rejected/);
  assert.match(text, /completed in/);
  for (const secret of ['publish-secret', 'reflected-key', 'hidden', 'header-secret', 'cookie-secret', '::error::']) assert.ok(!text.includes(secret), secret);
});

test('HTML, malformed and oversized errors are not dumped; success bodies are not logged', async () => {
  for (const [body, type, status] of [
    ['<html>private-body</html>', 'text/html', 500],
    ['private-body', 'application/json', 400],
    [JSON.stringify({ message: 'private-body' + 'x'.repeat(8192) }), 'application/json', 403],
    [JSON.stringify({ message: 'private-body' }), 'application/json', 201]
  ]) {
    const logs = [];
    const ctx = context({ config: { logResponses: true, retries: 0, timeout: 100 }, info: message => logs.push(message),
      fetch: async () => new Response(body, { status, headers: { 'content-type': type } }) });
    if (status === 201) assert.equal(await request('https://feed.example', async () => ({}), ctx), 'pushed');
    else await assert.rejects(request('https://feed.example', async () => ({}), ctx), new RegExp(`HTTP ${status}`));
    assert.ok(!logs.join(' ').includes('private-body'));
  }
});

test('stalled diagnostic read does not retry an authentication failure', async () => {
  let calls = 0;
  const ctx = context({ config: { logResponses: true, retries: 1, timeout: 20 }, fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { status: 401, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(request('https://feed.example', async () => ({}), ctx), /HTTP 401/);
  assert.equal(calls, 1);
});


test('response logging defaults off, validates input, and avoids reading error bodies when disabled', async () => {
  const { settings } = require('../src/settings');
  assert.equal(settings({ NUGET_API_KEY: 'key' }).logResponses, false);
  assert.equal(settings({ NUGET_API_KEY: 'key', 'INPUT_LOG-RESPONSES': 'true' }).logResponses, true);
  assert.throws(() => settings({ NUGET_API_KEY: 'key', 'INPUT_LOG-RESPONSES': 'yes' }), /log-responses/);
  for (const logResponses of [undefined, false]) {
    const logs = [];
    const ctx = context({ config: { retries: 0, timeout: 100, logResponses }, info: message => logs.push(message),
      fetch: async () => ({ ok: false, status: 403, headers: new Headers({ 'x-request-id': 'private-id' }),
        body: { cancel: async () => {}, getReader: () => { assert.fail('Disabled diagnostics read the body'); } } }) });
    await assert.rejects(request('https://feed.example', async () => ({}), ctx), /HTTP 403/);
    assert.ok(logs.every(log => !log.includes('response diagnostics') && !log.includes('private-id')));
  }
});
