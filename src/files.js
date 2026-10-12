'use strict';
const { glob, stat, realpath, access } = require('node:fs/promises');
const { constants } = require('node:fs');
const { resolve, relative, basename } = require('node:path');

async function discover(patterns, cwd, includeSymbols) {
  const paths = new Map();
  async function add(path) {
    const actual = await realpath(path);
    const info = await stat(actual);
    if (!info.isFile() || info.size === 0) throw new Error('Every selected artifact must be a nonempty regular file.');
    await access(actual, constants.R_OK);
    const kind = /\.snupkg$/i.test(path) ? 'symbols' : 'package';
    if (!/\.(snupkg|nupkg)$/i.test(path) || /\.symbols\.nupkg$/i.test(path))
      throw new Error('Select .nupkg or .snupkg files; legacy .symbols.nupkg files are unsupported.');
    if (kind === 'symbols' && !includeSymbols) return;
    if (!paths.has(actual)) paths.set(actual, { path: actual, file: relative(cwd, path).replaceAll('\\', '/'), name: basename(path), kind, status: 'pending', attempts: 0 });
  }
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) throw new Error('Negated package patterns are unsupported. Use explicit paths or positive glob patterns.');
    let matched = false;
    for await (const path of glob(pattern.replaceAll('\\', '/'), { cwd })) {
      matched = true;
      await add(resolve(cwd, path));
    }
    if (!matched) throw new Error('A packages pattern matched no files. Check the artifact paths before publishing.');
  }
  if (includeSymbols) {
    for (const item of [...paths.values()]) {
      if (item.kind !== 'package') continue;
      const companion = item.path.replace(/\.nupkg$/i, '.snupkg');
      try { await stat(companion); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await add(companion);
      paths.get(await realpath(companion)).parent = item.path;
    }
  }
  if (!paths.size) throw new Error('No publishable artifacts were selected.');
  return [...paths.values()].sort((a, b) => (a.kind === b.kind ? a.file.localeCompare(b.file) : a.kind === 'package' ? -1 : 1));
}
module.exports = { discover };
