'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { endpoint } = require('../src/endpoint');
const { coordination } = require('../src/batch');
const { request } = require('../src/http');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let time = 0;
  const waits = [];
  const controller = new AbortController();
  const options = { signal: controller.signal, now: () => time, sleep: async ms => { waits.push(ms); time += ms; } };
  return { options, waits, controller };
}

test('two exhausted sequences permit only one recovery upload, then disable the endpoint on failure', async () => {
  const h = harness(), gate = endpoint(h.options);
  gate.settle(await gate.acquire(), 'transient');
  gate.settle(await gate.acquire(), 'transient');
  const probe = await gate.acquire();
  assert.equal(probe, true);
  assert.deepEqual(h.waits, [30000]);
  let acquired = false;
  const other = gate.acquire().then(() => { acquired = true; });
  const rejection = assert.rejects(other, error => error.endpointUnavailable);
  await tick();
  assert.equal(acquired, false);
  gate.settle(probe, 'transient');
  await rejection;
  await assert.rejects(gate.acquire(), error => error.endpointUnavailable);
});

test('successful recovery releases waiting uploads and resets failures', async () => {
  const h = harness(), gate = endpoint(h.options);
  gate.settle(false, 'transient'); gate.settle(false, 'transient');
  assert.equal(await gate.acquire(), true);
  const queued = gate.acquire();
  await tick();
  gate.settle(true, 'response');
  assert.equal(await queued, false);
  gate.settle(false, 'transient');
  assert.equal(await gate.acquire(), false);
});

test('cancellation interrupts waiting for a recovery upload', async () => {
  const h = harness(), gate = endpoint(h.options);
  gate.settle(false, 'transient'); gate.settle(false, 'transient');
  await gate.acquire();
  const queued = gate.acquire();
  const rejection = assert.rejects(queued, /canceled/);
  await tick(); h.controller.abort(); await rejection;
});

test('outage costs two full retry sequences plus one trial; symbols remain independent', async () => {
  const h = harness(), control = coordination(h.options);
  let calls = 0;
  const context = { ...h.options, control, config: { retries: 1, timeout: 1000 }, info: () => {}, random: () => 0,
    fetch: async () => { calls++; return new Response(null, { status: 503 }); } };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(request('https://feed/package', async () => ({}), context, { item: { kind: 'package', attempts: 0 } }), /HTTP 503/);
  }
  assert.equal(calls, 5);
  await assert.rejects(request('https://feed/package', async () => ({}), context, { item: { kind: 'package', attempts: 0 } }), error => error.endpointUnavailable);
  assert.equal(calls, 5);
  context.fetch = async () => new Response(null, { status: 201 });
  assert.equal(await request('https://feed/symbols', async () => ({}), context, { item: { kind: 'symbols', attempts: 0 } }), 'pushed');
});

test('individual invalid packages do not open the endpoint circuit', async () => {
  const h = harness(), control = coordination(h.options);
  const context = { ...h.options, control, config: { retries: 1, timeout: 1000 }, info: () => {},
    fetch: async () => new Response(null, { status: 400 }) };
  for (let i = 0; i < 4; i++) await assert.rejects(request('https://feed/package', async () => ({}), context, { item: { kind: 'package', attempts: 0 } }), /HTTP 400/);
  assert.deepEqual(h.waits, []);
});

test('503 Retry-After holds the same endpoint while a different endpoint can proceed', async () => {
  let now = 0, calls = 0;
  const pending = [];
  const signal = new AbortController().signal;
  const options = { signal, now: () => now, sleep: ms => new Promise(resolve => pending.push({ ms, resolve })) };
  const control = coordination(options);
  const context = { ...options, control, config: { retries: 1, timeout: 1000 }, info: () => {},
    fetch: async () => ++calls === 1 ? new Response(null, { status: 503, headers: { 'retry-after': '2' } }) : new Response(null, { status: 201 }) };
  const item = kind => ({ kind, attempts: 0 });
  const first = request('https://feed/package', async () => ({}), context, { item: item('package') });
  await tick();
  const second = request('https://feed/package', async () => ({}), context, { item: item('package') });
  await tick();
  assert.equal(calls, 1);
  await request('https://feed/symbols', async () => ({}), context, { item: item('symbols') });
  assert.equal(calls, 2);
  now = 2000; pending.splice(0).forEach(p => p.resolve());
  await Promise.all([first, second]);
  assert.equal(calls, 4);
});
