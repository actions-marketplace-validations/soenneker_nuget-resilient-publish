'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { readFileSync } = require('node:fs');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { run } = require('../src/action');
const { send } = require('../src/transport');

// Public test-only certificate/key. Never used outside the loopback test server.
const cert = readFileSync(join(__dirname, 'fixtures/localhost-cert.pem'));
const key = readFileSync(join(__dirname, 'fixtures/localhost-key.pem'));

async function server(t, handler) {
  const previousCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = cert;
  const instance = https.createServer({ key, cert }, handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(async () => {
    https.globalAgent.options.ca = previousCa;
    instance.closeAllConnections();
    await new Promise(resolve => instance.close(resolve));
  });
  return `https://127.0.0.1:${instance.address().port}`;
}

test('real HTTPS multipart upload, dropped symbol response, replay, and GitHub output files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'publish-https-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'A.nupkg'), 'package bytes');
  await writeFile(join(directory, 'A.snupkg'), 'symbol bytes');
  const requests = [];
  let symbolCalls = 0;
  const url = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/index.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ resources: [
        { '@type': 'PackagePublish/2.0.0', '@id': `${url}/package` },
        { '@type': 'SymbolPackagePublish/4.9.0', '@id': `${url}/symbols` }
      ] }));
    } else if (req.url === '/symbols' && ++symbolCalls === 1) res.destroy();
    else { res.statusCode = 201; res.end(); }
  });
  await run({ GITHUB_WORKSPACE: directory, GITHUB_OUTPUT: join(directory, 'outputs'), INPUT_PACKAGES: '*.nupkg', INPUT_SOURCE: `${url}/index.json`, NUGET_API_KEY: 'integration-test-key' },
    { mask: () => {}, info: () => {}, sleep: async () => {} });
  assert.deepEqual(requests.map(r => r.path), ['/index.json', '/package', '/symbols', '/symbols']);
  for (const req of requests.slice(1)) {
    assert.equal(req.body.length, Number(req.headers['content-length']));
    assert.equal(req.headers['x-nuget-apikey'], 'integration-test-key');
    assert.equal(req.headers['x-nuget-protocol-version'], '4.1.0');
    assert.ok(req.body.toString().includes(req.path === '/package' ? 'package bytes' : 'symbol bytes'));
    assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=nuget_/);
  }
  const output = readFileSync(join(directory, 'outputs'), 'utf8');
  assert.match(output, /"status":"pushed","attempts":2/);
  assert.ok(!output.includes('integration-test-key'));
});

test('native transport returns redirect without following it', async t => {
  let calls = 0;
  const url = await server(t, (req, res) => { calls++; res.writeHead(302, { Location: '/other' }); res.end(); });
  const response = await send(url, { signal: new AbortController().signal });
  assert.equal(response.status, 302);
  await response.body.cancel();
  assert.equal(calls, 1);
});

test('native transport aborts a stalled connection', async t => {
  const url = await server(t, () => {});
  await assert.rejects(send(url, { signal: AbortSignal.timeout(50) }), /abort/i);
});

test('native transport caps index response size', async t => {
  const url = await server(t, (req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  const response = await send(url, { signal: AbortSignal.timeout(2000) });
  await assert.rejects(response.text(), /size limit/);
});

test('an early server rejection remains authoritative during a streaming upload', async t => {
  const url = await server(t, (req, res) => { res.writeHead(401); res.end(); });
  const response = await send(url, {
    method: 'PUT', signal: AbortSignal.timeout(2000),
    body: (async function* () {
      for (let i = 0; i < 256; i++) yield Buffer.alloc(65536);
    })()
  });
  assert.equal(response.status, 401);
  await response.body.cancel();
});
