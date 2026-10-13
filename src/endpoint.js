'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

function endpoint({ signal, now = Date.now, sleep: wait = (ms, abort) => sleep(ms, undefined, { signal: abort }), info = () => {} }) {
  let failures = 0, until = 0, open = false, probing = false, disabled = false;
  const listeners = new Set();
  const wake = () => { for (const listener of listeners) listener(); listeners.clear(); };
  function unavailable() {
    const error = new Error('Publishing stopped for this endpoint after its recovery attempt failed.');
    error.endpointUnavailable = true;
    return error;
  }
  return {
    throttle(delay) { until = Math.max(until, now() + delay); },
    async ready() {
      let waitedUntil = 0;
      while (true) {
        if (signal.aborted) throw new Error('Publishing canceled.');
        if (disabled) throw unavailable();
        const target = until;
        const delay = target - Math.max(now(), waitedUntil);
        if (delay <= 0) return;
        info('Endpoint cooldown: waiting ' + Math.ceil(delay) + 'ms...');
        await wait(delay, signal);
        waitedUntil = target;
      }
    },
    async acquire() {
      while (true) {
        await this.ready();
        if (!open) return false;
        if (!probing) { probing = true; info('Endpoint recovery: starting one trial upload.'); return true; }
        await new Promise((resolve, reject) => {
          const finish = () => { signal.removeEventListener('abort', abort); listeners.delete(finish); resolve(); };
          const abort = () => { listeners.delete(finish); reject(new Error('Publishing canceled.')); };
          if (signal.aborted) return abort();
          listeners.add(finish);
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    },
    settle(probe, outcome) {
      if (probe) {
        probing = false;
        if (outcome === 'transient') { disabled = true; info('Endpoint recovery failed; skipping remaining uploads to this endpoint.'); }
        else { open = false; failures = 0; info('Endpoint responded; resuming queued uploads.'); }
        wake();
      } else if (!open) {
        if (outcome === 'transient') {
          if (++failures >= 2) {
            open = true;
            this.throttle(30000);
            info('Endpoint failed two complete retry sequences; pausing before one recovery upload.');
          }
        } else failures = 0;
      }
    }
  };
}

module.exports = { endpoint };
