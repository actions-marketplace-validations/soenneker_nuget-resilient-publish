'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coordination } = require('../src/batch');
const { request } = require('../src/http');

const tick = () => new Promise(resolve => setImmediate(resolve));

test('shared cooldown blocks multiple workers and respects extensions', async () => {
  let now = 0;
  const pending = [];
  const control = coordination({ signal: new AbortController().signal, now: () => now,
    sleep: (ms, signal) => new Promise(resolve => pending.push({ ms, resolve })) });
  control.throttle(100);
  let completed = 0;
  const first = control.ready().then(() => completed++);
  const second = control.ready().then(() => completed++);
  assert.deepEqual(pending.map(p => p.ms), [100, 100]);
  now = 50;
  control.throttle(200);
  now = 100;
  pending.splice(0).forEach(p => p.resolve());
  await tick();
  assert.equal(completed, 0);
  assert.deepEqual(pending.map(p => p.ms), [150, 150]);
  now = 250;
  pending.splice(0).forEach(p => p.resolve());
  await Promise.all([first, second]);
  assert.equal(completed, 2);
});

test('fatal stop interrupts workers waiting on a long shared cooldown', async () => {
  const control = coordination({ signal: new AbortController().signal });
  control.throttle(300000);
  const waiting = control.ready();
  control.stopped = true;
  await assert.rejects(waiting);
});

test('a 429 prevents a different artifact from starting until the shared deadline', async () => {
  let now = 0;
  const pending = [];
  const signal = new AbortController().signal;
  const wait = (ms, abort) => new Promise(resolve => pending.push({ ms, resolve }));
  const control = coordination({ signal, now: () => now, sleep: wait });
  const calls = [];
  let attempts = 0;
  const context = { config: { retries: 1, timeout: 1000 }, signal, control, now: () => now, sleep: wait, info: () => {},
    fetch: async url => { calls.push(url); return url.endsWith('/a') && attempts++ === 0
      ? new Response(null, { status: 429, headers: { 'Retry-After': '1' } }) : new Response(null, { status: 201 }); } };
  const a = request('https://feed.example/a', async () => ({}), context);
  await tick();
  const b = request('https://feed.example/b', async () => ({}), context);
  await tick();
  assert.deepEqual(calls, ['https://feed.example/a']);
  assert.deepEqual(pending.map(p => p.ms), [1000, 1000]);
  now = 1000;
  pending.splice(0).forEach(p => p.resolve());
  await Promise.all([a, b]);
  assert.equal(calls.length, 3);
});

test('fatal stop during asynchronous file preparation prevents the upload from starting', async () => {
  const signal = new AbortController().signal;
  const control = coordination({ signal });
  let calls = 0;
  await assert.rejects(request('https://feed.example/package', async () => {
    control.stopped = true;
    return {};
  }, { config: { retries: 0, timeout: 1000 }, signal, control, info: () => {}, fetch: async () => { calls++; return new Response(null, { status: 201 }); } }), /canceled/);
  assert.equal(calls, 0);
});
