'use strict';

const { endpoint } = require('./endpoint');
const { setTimeout: sleep } = require('node:timers/promises');

function coordination({ signal, now = Date.now, sleep: wait = (ms, abort) => sleep(ms, undefined, { signal: abort }), info }) {
  const endpoints = new Map();
  let until = 0;
  let stopped = false;
  const stopController = new AbortController();
  const waitSignal = AbortSignal.any([signal, stopController.signal]);
  return {
    endpoint(key) {
      if (!endpoints.has(key)) endpoints.set(key, endpoint({ signal: waitSignal, now, sleep: wait, info }));
      return endpoints.get(key);
    },
    get stopped() { return stopped; },
    set stopped(value) { stopped = value; if (value) stopController.abort(); },
    waitSignal,
    throttle(delay) { until = Math.max(until, now() + delay); },
    async ready() {
      let waitedUntil = 0;
      while (!signal.aborted && !this.stopped) {
        const target = until;
        const delay = target - Math.max(now(), waitedUntil);
        if (delay <= 0) return;
        await wait(delay, waitSignal);
        waitedUntil = target;
        // Another worker can extend the shared deadline while this one sleeps.
      }
      throw new Error('Publishing canceled or stopped; no further uploads will be started.');
    }
  };
}

async function pool(items, concurrency, control, signal, publish) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && !signal.aborted && !control.stopped) {
      const item = items[cursor++];
      try {
        await control.ready();
        if (signal.aborted || control.stopped) return;
        await publish(item);
      } catch (error) {
        control.stopped = true;
        control.failure ||= error;
        throw error;
      }
    }
  });
  // Always settle in-flight work before reporting results or removing signal handlers.
  const results = await Promise.allSettled(workers);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw control.failure || failed.reason;
}

module.exports = { coordination, pool };
