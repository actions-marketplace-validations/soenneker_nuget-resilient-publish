'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { run } = require('../src/action');

const index = { resources: [
  { '@type': 'PackagePublish/2.0.0', '@id': 'https://feed.example/package' },
  { '@type': 'SymbolPackagePublish/4.9.0', '@id': 'https://feed.example/symbols' }
] };

async function fixture(t, files = ['Example.1.0.0.nupkg', 'Example.1.0.0.snupkg']) {
  const root = await mkdtemp(join(tmpdir(), 'publish-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) await writeFile(join(root, file), `bytes:${file}`);
  const env = { GITHUB_WORKSPACE: root, INPUT_PACKAGES: '*.nupkg', 'INPUT_API-KEY': 'secret-key', GITHUB_STEP_SUMMARY: join(root, 'summary') };
  const outputs = {};
  const calls = [];
  const logs = [];
  const delays = [];
  const masks = [];
  const bodies = [];
  let clock = Date.now();
  const dependencies = {
    mask: value => masks.push(value), output: (name, value) => outputs[name] = value,
    info: value => logs.push(value), sleep: async ms => { delays.push(ms); clock += ms; }, now: () => clock, random: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (!options.method) return Response.json(index);
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.equal(body.length, Number(options.headers['Content-Length']));
      bodies.push(body.toString());
      return new Response(null, { status: 201 });
    }
  };
  return { root, env, outputs, calls, logs, delays, masks, bodies, dependencies, results: () => JSON.parse(outputs.results) };
}

function sequence(f, statuses) {
  const original = f.dependencies.fetch;
  f.dependencies.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!options.method) return response;
    const next = statuses.shift();
    if (next instanceof Error) throw next;
    return new Response(null, typeof next === 'number' ? { status: next } : next);
  };
}

test('symbol timeout retries only symbols and streams a fresh complete multipart body', async t => {
  const f = await fixture(t);
  sequence(f, [201, Object.assign(new Error('socket reset secret-key'), { code: 'ECONNRESET' }), 201]);
  await run(f.env, f.dependencies);
  assert.deepEqual(f.calls.map(c => c.url), ['https://api.nuget.org/v3/index.json', 'https://feed.example/package', 'https://feed.example/symbols', 'https://feed.example/symbols']);
  assert.deepEqual(f.results().map(r => [r.status, r.attempts]), [['pushed', 1], ['pushed', 2]]);
  assert.ok(f.bodies[1].includes('bytes:Example.1.0.0.snupkg'));
  assert.ok(f.bodies[2].includes('bytes:Example.1.0.0.snupkg'));
  assert.notEqual(f.bodies[1], f.bodies[2]);
  assert.equal(f.outputs.pushed, '2');
  assert.deepEqual(f.delays, [5000]);
  assert.deepEqual(f.masks, ['secret-key']);
  assert.ok(!JSON.stringify(f.logs).includes('secret-key'));
  assert.ok((await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8')).includes('pushed'));
  assert.equal(f.calls[0].options.headers['X-NuGet-ApiKey'], undefined);
});

test('ambiguous package timeout then duplicate still publishes symbols', async t => {
  const f = await fixture(t);
  sequence(f, [Object.assign(new Error('lost response'), { code: 'ECONNRESET' }), 409, 201]);
  await run(f.env, f.dependencies);
  assert.deepEqual(f.results().map(r => r.status), ['duplicate', 'pushed']);
});

test('symbol 409 is processing, not a confirmed publication', async t => {
  const f = await fixture(t);
  sequence(f, [201, 409]);
  await run(f.env, f.dependencies);
  assert.equal(f.outputs.processing, '1');
  assert.equal(f.outputs.duplicate, '0');
});

test('symbol 404 after accepted parent retries for eventual visibility', async t => {
  const f = await fixture(t);
  sequence(f, [201, 404, 201]);
  await run(f.env, f.dependencies);
  assert.equal(f.results()[1].attempts, 2);
});

test('standalone symbols support recovery without reuploading package; 404 fails immediately', async t => {
  const f = await fixture(t);
  f.env.INPUT_PACKAGES = '*.snupkg';
  sequence(f, [404]);
  await assert.rejects(run(f.env, f.dependencies), /artifacts failed/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.outputs.failed, '1');
});

test('429 honors Retry-After; an excessive delay stops all remaining uploads', async t => {
  const f = await fixture(t);
  sequence(f, [{ status: 429, headers: { 'Retry-After': '12' } }, 201, 201]);
  await run(f.env, f.dependencies);
  assert.deepEqual(f.delays, [12000]);
  const g = await fixture(t, ['A.nupkg', 'B.nupkg']);
  sequence(g, [{ status: 429, headers: { 'Retry-After': '301' } }]);
  await assert.rejects(run(g.env, g.dependencies), /Retry-After/);
  assert.equal(g.calls.length, 2);
  assert.equal(g.outputs.skipped, '1');
});

for (const status of [400, 401, 403, 413, 302]) test(`HTTP ${status} is not retried`, async t => {
  const f = await fixture(t);
  sequence(f, [status]);
  await assert.rejects(run(f.env, f.dependencies));
  assert.equal(f.calls.length, 2);
  assert.equal(f.outputs.failed, '1');
  assert.equal(f.outputs.skipped, '1');
  assert.deepEqual(f.delays, []);
});

test('failed package skips companion but other packages continue', async t => {
  const f = await fixture(t, ['A.nupkg', 'A.snupkg', 'B.nupkg', 'B.snupkg']);
  sequence(f, [400, 201, 201]);
  await assert.rejects(run(f.env, f.dependencies), /artifacts failed/);
  assert.deepEqual(f.results().map(r => r.status), ['failed', 'pushed', 'skipped', 'pushed']);
});

test('authentication rejection stops later packages', async t => {
  const f = await fixture(t, ['A.nupkg', 'B.nupkg']);
  sequence(f, [401]);
  await assert.rejects(run(f.env, f.dependencies), /fresh key/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.outputs.skipped, '1');
});

test('retry exhaustion preserves successful package result', async t => {
  const f = await fixture(t);
  f.env['INPUT_MAX-RETRIES'] = '2';
  sequence(f, [201, 500, 503, 504]);
  await assert.rejects(run(f.env, f.dependencies), /artifacts failed/);
  assert.deepEqual(f.results().map(r => [r.status, r.attempts]), [['pushed', 1], ['failed', 3]]);
});

test('skip-duplicate false treats conflict as failure', async t => {
  const f = await fixture(t);
  f.env['INPUT_SKIP-DUPLICATE'] = 'false';
  sequence(f, [409]);
  await assert.rejects(run(f.env, f.dependencies));
  assert.equal(f.outputs.failed, '1');
});

test('overlapping globs deduplicate artifacts and packages always precede symbols', async t => {
  const f = await fixture(t);
  f.env.INPUT_PACKAGES = '*.snupkg\n*.nupkg\nExample.1.0.0.nupkg';
  await run(f.env, f.dependencies);
  assert.deepEqual(f.results().map(r => r.kind), ['package', 'symbols']);
  assert.equal(f.calls.length, 3);
});

test('include-symbols false allows feeds with no symbol resource', async t => {
  const f = await fixture(t);
  f.env['INPUT_INCLUDE-SYMBOLS'] = 'false';
  const original = f.dependencies.fetch;
  f.dependencies.fetch = (url, options) => options.method ? original(url, options) : Response.json({ resources: [index.resources[0]] });
  await run(f.env, f.dependencies);
  assert.equal(f.results().length, 1);
});

test('missing symbol resource fails before any uploads', async t => {
  const f = await fixture(t);
  f.dependencies.fetch = async () => Response.json({ resources: [index.resources[0]] });
  await assert.rejects(run(f.env, f.dependencies), /SymbolPackagePublish/);
  assert.ok(f.results().every(r => r.attempts === 0));
});

test('missing, empty, and legacy files fail before contacting feed', async t => {
  for (const files of [[], ['empty.nupkg'], ['A.symbols.nupkg']]) {
    const f = await fixture(t, files);
    if (files[0] === 'empty.nupkg') await writeFile(join(f.root, files[0]), '');
    await assert.rejects(run(f.env, f.dependencies));
    assert.equal(f.calls.length, 0);
  }
});

test('invalid input and insecure discovered endpoints fail before uploads', async t => {
  const f = await fixture(t);
  f.env['INPUT_MAX-RETRIES'] = '3.5';
  await assert.rejects(run(f.env, f.dependencies), /integer/);
  delete f.env['INPUT_MAX-RETRIES'];
  f.dependencies.fetch = async () => Response.json({ resources: [{ ...index.resources[0], '@id': 'http://insecure.example/upload' }, index.resources[1]] });
  await assert.rejects(run(f.env, f.dependencies), /HTTPS/);
});

test('cancellation during backoff prevents further uploads and records partial results', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.dependencies.signal = controller.signal;
  f.dependencies.sleep = async () => controller.abort();
  sequence(f, [201, 503]);
  await assert.rejects(run(f.env, f.dependencies), /canceled/);
  assert.deepEqual(f.results().map(r => r.status), ['pushed', 'failed']);
  assert.equal(f.calls.length, 3);
});


test('total deadline cancels an in-flight upload and retains completed results', async t => {
  const f = await fixture(t);
  f.env['INPUT_TOTAL-TIMEOUT-SECONDS'] = '1';
  const original = f.dependencies.fetch;
  f.dependencies.fetch = async (url, options) => {
    if (url.endsWith('/symbols')) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
    });
    return original(url, options);
  };
  await assert.rejects(run(f.env, f.dependencies), /total time limit/);
  assert.deepEqual(f.results().map(r => r.status), ['pushed', 'failed']);
});

test('missing output environment fails before any upload', async t => {
  const f = await fixture(t);
  delete f.dependencies.output;
  await assert.rejects(run(f.env, f.dependencies), /GITHUB_OUTPUT/);
  assert.equal(f.calls.length, 0);
});

test('response body and raw transport errors cannot disclose credentials in results', async t => {
  const f = await fixture(t);
  f.env['INPUT_MAX-RETRIES'] = '0';
  const original = f.dependencies.fetch;
  f.dependencies.fetch = async (url, options) => {
    await original(url, options);
    if (!options.method) return Response.json(index);
    return new Response('secret-key sensitive service response', { status: 400 });
  };
  await assert.rejects(run(f.env, f.dependencies));
  assert.ok(!JSON.stringify(f.outputs).includes('secret-key'));
  assert.ok(!JSON.stringify(f.logs).includes('secret-key'));
  assert.ok(JSON.stringify(f.logs).includes('sensitive service response'));
});

test('required packages validate exact filenames and versions before network access', async t => {
  const f = await fixture(t);
  f.env['INPUT_REQUIRED-PACKAGES'] = 'Example.1.0.0.nupkg\nMissing.1.0.0.nupkg';
  await assert.rejects(run(f.env, f.dependencies), /Required package is missing/);
  assert.equal(f.calls.length, 0);
  f.env['INPUT_REQUIRED-PACKAGES'] = 'Example.2.0.0.nupkg';
  await assert.rejects(run(f.env, f.dependencies), /Required package is missing/);
  f.env['INPUT_REQUIRED-PACKAGES'] = 'Example.1.0.0.nupkg';
  await run(f.env, f.dependencies);
  assert.equal(f.outputs.pushed, '2');
});

test('required symbols reject missing companions and contradictory settings before uploading', async t => {
  const f = await fixture(t, ['Example.1.0.0.nupkg']);
  f.env['INPUT_REQUIRE-SYMBOLS'] = 'true';
  await assert.rejects(run(f.env, f.dependencies), /Required symbol companion/);
  assert.equal(f.calls.length, 0);
  f.env['INPUT_INCLUDE-SYMBOLS'] = 'false';
  await assert.rejects(run(f.env, f.dependencies), /cannot be true/);
});

test('concurrent uploads respect their limit and package-before-symbol barrier', async t => {
  const f = await fixture(t, ['A.nupkg', 'A.snupkg', 'B.nupkg', 'B.snupkg', 'C.nupkg']);
  f.env.INPUT_CONCURRENCY = '2';
  const original = f.dependencies.fetch;
  let active = 0;
  let peak = 0;
  let finishedPackages = 0;
  let startedUploads = 0;
  let releasePair;
  const firstPair = new Promise(resolve => { releasePair = resolve; });
  f.dependencies.fetch = async (url, options) => {
    if (!options.method) return original(url, options);
    active++;
    peak = Math.max(peak, active);
    startedUploads++;
    if (startedUploads === 2) releasePair();
    if (startedUploads <= 2) await firstPair;
    const response = await original(url, options);
    if (url.endsWith('/symbols')) assert.equal(finishedPackages, 3);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (url.endsWith('/package')) finishedPackages++;
    return response;
  };
  await run(f.env, f.dependencies);
  assert.equal(peak, 2);
  assert.equal(f.outputs.pushed, '5');
  assert.equal(f.outputs.total, '5');
  assert.ok(f.logs.some(line => line.includes('5/5 finished')));
});

test('fatal rejection stops new workers but awaits and records in-flight success', async t => {
  const f = await fixture(t, ['A.nupkg', 'B.nupkg', 'C.nupkg']);
  f.env.INPUT_CONCURRENCY = '2';
  const original = f.dependencies.fetch;
  let releaseB;
  const gate = new Promise(resolve => { releaseB = resolve; });
  let bStarted;
  const ready = new Promise(resolve => { bStarted = resolve; });
  let rejectionRecorded;
  const rejected = new Promise(resolve => { rejectionRecorded = resolve; });
  const originalInfo = f.dependencies.info;
  f.dependencies.info = message => {
    originalInfo(message);
    if (message.startsWith('A.nupkg: Upload/request failed (HTTP 403)')) rejectionRecorded();
  };
  f.dependencies.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!options.method) return response;
    if (f.bodies.at(-1).includes('bytes:A.nupkg')) {
      await ready;
      return new Response(null, { status: 403 });
    }
    bStarted();
    await gate;
    return response;
  };
  const promise = run(f.env, f.dependencies);
  await ready;
  // B may finish reading its file before A has even returned its rejection.
  // Keep B in flight until the fatal response has actually stopped the pool.
  try {
    await rejected;
    assert.equal(f.outputs.results, undefined);
  } finally {
    releaseB();
  }
  await assert.rejects(promise, /HTTP 403/);
  assert.deepEqual(f.results().map(r => r.status), ['failed', 'pushed', 'skipped']);
  assert.equal(f.calls.length, 3);
});

test('reporting errors never replace primary failure and other outputs are still attempted', async t => {
  const f = await fixture(t);
  sequence(f, [401]);
  const originalOutput = f.dependencies.output;
  f.dependencies.output = (name, value) => {
    if (name === 'results') throw new Error('secret-key output failure');
    originalOutput(name, value);
  };
  f.dependencies.appendSummary = async () => { throw new Error('secret-key summary failure'); };
  await assert.rejects(run(f.env, f.dependencies), /HTTP 401/);
  assert.equal(f.outputs.failed, '1');
  assert.ok(!JSON.stringify(f.logs).includes('secret-key'));
});

test('summary failure does not fail successful uploads; output failure is reported separately', async t => {
  const f = await fixture(t);
  f.dependencies.appendSummary = async () => { throw new Error('disk'); };
  await run(f.env, f.dependencies);
  assert.equal(f.outputs.pushed, '2');
  const g = await fixture(t);
  g.dependencies.output = () => { throw new Error('disk'); };
  await assert.rejects(run(g.env, g.dependencies), /outputs could not be written/);
  assert.equal(g.calls.length, 3);
});

test('batch and per-attempt diagnostics retain retry causes, statuses, sizes, and timing', async t => {
  const f = await fixture(t);
  sequence(f, [503, 201, 201]);
  await run(f.env, f.dependencies);
  const result = f.results()[0];
  assert.equal(result.sizeBytes, Buffer.byteLength('bytes:Example.1.0.0.nupkg'));
  assert.equal(result.durationMs, 5000);
  assert.equal(result.httpStatus, 201);
  assert.equal(result.attemptDetails[0].httpStatus, 503);
  assert.equal(result.attemptDetails[0].retryDelayMs, 5000);
  assert.equal(f.outputs['duration-seconds'], '5.000');
});


test('persistent endpoint outage skips queued packages and retains partial results', async t => {
  const f = await fixture(t, ['A.nupkg', 'B.nupkg', 'C.nupkg', 'D.nupkg']);
  f.env['INPUT_MAX-RETRIES'] = '0';
  sequence(f, [503, 503, 503]);
  await assert.rejects(run(f.env, f.dependencies), /artifacts failed/);
  assert.deepEqual(f.results().map(item => item.status), ['failed', 'failed', 'failed', 'skipped']);
  assert.equal(f.results()[3].attempts, 0);
  assert.match(f.results()[3].error, /Endpoint/);
});
