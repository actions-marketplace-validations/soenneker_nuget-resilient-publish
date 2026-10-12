'use strict';

const { appendFile } = require('node:fs/promises');
const { multipart } = require('./multipart');
const { settings, httpsUrl } = require('./settings');
const { discover } = require('./files');
const { request } = require('./http');
const { mask, output } = require('./runtime');

async function run(env = process.env, dependencies = {}) {
  if (!dependencies.output && !env.GITHUB_OUTPUT)
    throw new Error('GITHUB_OUTPUT is unavailable. Run this action in a GitHub Actions step.');
  const config = settings(env);
  (dependencies.mask || mask)(config.apiKey);
  if (!dependencies.output) {
    try { await appendFile(env.GITHUB_OUTPUT, ''); }
    catch { throw new Error('GITHUB_OUTPUT is not writable; publishing has not started.'); }
  }
  const redact = value => String(value).replaceAll(config.apiKey, '***');
  const info = value => (dependencies.info || (message => process.stdout.write(`${message}\n`)))(redact(value).replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll('::', ': :'));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const timer = setTimeout(cancel, config.totalTimeout);
  const signal = dependencies.signal ? AbortSignal.any([controller.signal, dependencies.signal]) : controller.signal;
  const context = { ...dependencies, config, signal, info };
  let items = [];
  let failure;
  try {
    items = await discover(config.patterns, env.GITHUB_WORKSPACE || process.cwd(), config.symbols);
    info(`Found ${items.filter(i => i.kind === 'package').length} package(s) and ${items.filter(i => i.kind === 'symbols').length} symbol artifact(s).`);
    const index = await request(config.source, async () => ({ headers: { Accept: 'application/json', 'User-Agent': 'nuget-resilient-publish' } }), context, { json: true });
    const endpoints = {};
    for (const [kind, type] of [['package', 'PackagePublish/2.0.0'], ['symbols', 'SymbolPackagePublish/4.9.0']]) {
      if (!items.some(item => item.kind === kind)) continue;
      const resource = Array.isArray(index?.resources) && index.resources.find(r => [].concat(r?.['@type'] || []).includes(type));
      if (!resource) throw new Error(`The service index does not provide ${type}. Disable include-symbols for feeds without symbol support.`);
      endpoints[kind] = httpsUrl(resource['@id'], `${kind} endpoint`);
    }
    for (const item of items) {
      if (signal.aborted) throw new Error('Publishing canceled or total time limit reached.');
      if (item.parent) {
        const parent = items.find(candidate => candidate.path === item.parent);
        if (!['pushed', 'duplicate'].includes(parent.status)) {
          item.status = 'skipped';
          item.error = 'Parent package upload did not succeed.';
          continue;
        }
        item.parentAccepted = true;
      }
      info(`Publishing ${item.kind}: ${item.file}`);
      try {
        item.status = await request(endpoints[item.kind], async () => {
          const content = await multipart(item.path);
          return { method: 'PUT', headers: { ...content.headers, 'X-NuGet-ApiKey': config.apiKey, 'X-NuGet-Protocol-Version': '4.1.0', 'User-Agent': 'nuget-resilient-publish/1.0.0' }, body: content.body };
        }, context, { item });
        info(`${item.file}: ${item.status} (${item.attempts} attempt(s)).`);
      } catch (error) {
        item.status = 'failed';
        item.error = /^(Upload\/request failed|Retry-After|Publishing canceled)/.test(error.message)
          ? error.message : 'Unable to read or upload the artifact.';
        info(`${item.file}: ${item.error}`);
        if (error.stop || signal.aborted) throw new Error(item.error);
      }
    }
    if (items.some(item => item.status === 'failed')) throw new Error('One or more artifacts failed. Inspect the per-artifact results; successful uploads were retained.');
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    for (const item of items) if (item.status === 'pending') { item.status = 'skipped'; item.error = 'Publishing stopped before this artifact was attempted.'; }
    const results = items.map(({ file, kind, status, attempts, error }) => ({ file: redact(file), kind, status, attempts, ...(error ? { error: redact(error) } : {}) }));
    const emit = dependencies.output || ((name, value) => output(name, value, env));
    emit('results', JSON.stringify(results));
    for (const status of ['pushed', 'duplicate', 'processing', 'failed', 'skipped'])
      emit(status, String(results.filter(item => item.status === status).length));
    if (env.GITHUB_STEP_SUMMARY) {
      const html = value => redact(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/[\r\n]/g, ' ');
      const rows = results.map(item => `| ${html(item.file)} | ${item.kind} | ${item.status} | ${item.attempts} | ${html(item.error || '')} |`);
      await appendFile(env.GITHUB_STEP_SUMMARY, `\n### NuGet publishing${failure ? ' — failed' : ''}\n\n| Artifact | Type | Result | Attempts | Detail |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\nAccepted uploads may still be undergoing server validation. Symbol processing is not confirmation of availability.\n`);
    }
  }
  if (failure) throw new Error(redact(failure.message));
}

module.exports = { run };
