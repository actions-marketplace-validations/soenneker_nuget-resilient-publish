'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorMessage, readErrorMessage } = require('../src/diagnostics');

test('empty responses without diagnostic headers explicitly report empty', async () => {
  assert.deepEqual(await errorMessage(new Response(null, { status: 500 }), []), { bodyStatus: 'empty' });
});

test('plain text messages are bounded and redact secrets and workflow commands', async () => {
  const result = await errorMessage(new Response('Failure known-secret password="multiple secret words" token=hidden\n::error:: injected ' + 'x'.repeat(600), {
    headers: { 'content-type': 'text/plain' }
  }), ['known-secret']);
  assert.equal(result.bodyStatus, 'text');
  assert.ok(result.message.length <= 512);
  for (const secret of ['known-secret', 'multiple secret words', 'hidden', '::error::']) assert.ok(!result.message.includes(secret));
  assert.match(result.message, /Failure/);
});

test('missing content type supports text errors', async () => {
  const response = { headers: new Headers(), text: async () => 'Upstream request timed out' };
  assert.deepEqual(await errorMessage(response, []), { bodyStatus: 'text', message: 'Upstream request timed out' });
});

test('unsupported, malformed, oversized and schema-less bodies explain omission', async () => {
  for (const [body, type, expected] of [
    ['<html>private</html>', 'text/html', 'unsupported_content_type'],
    ['private', 'application/json', 'invalid_json'],
    ['x'.repeat(8193), 'text/plain', 'too_large'],
    ['{}', 'application/json', 'no_error_message']
  ]) assert.deepEqual(await errorMessage(new Response(body, { headers: { 'content-type': type } }), []), { bodyStatus: expected });
});

test('problem details are sanitized including reflected credential fields', async () => {
  const result = await errorMessage(Response.json({ detail: 'Failure reflected-secret', apiKey: 'reflected-secret' }), []);
  assert.equal(result.bodyStatus, 'json');
  assert.match(result.message, /Failure/);
  assert.ok(!result.message.includes('reflected-secret'));
});

test('read failures and native size limits have distinct statuses', async () => {
  for (const [code, expected] of [['ECONNRESET', 'read_error'], ['ERR_INDEX_TOO_LARGE', 'too_large']]) {
    const result = await errorMessage({ headers: new Headers(), text: async () => { throw Object.assign(new Error('private'), { code }); } }, []);
    assert.deepEqual(result, { bodyStatus: expected });
  }
});

test('canceled diagnostic read reports timeout without exposing the abort reason', async () => {
  const controller = new AbortController();
  const result = readErrorMessage(new Response(new ReadableStream({ pull: () => new Promise(() => {}) })), [], controller.signal);
  controller.abort(new Error('private'));
  assert.deepEqual(await result, { bodyStatus: 'timeout' });
});
