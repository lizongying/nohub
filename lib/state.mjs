/**
 * nohub 内部同步状态，存放在实例仓库的 state/sync.noml。
 *
 * 作者文件（repos/<host>/<owner>.noml）只声明「同步哪些仓库、怎么同步」，
 * 状态由 nohub 自己维护，不回写作者文件。结构：
 *
 * {
 *   'github.com/lizongying/nolang' {
 *     last_sync_at: '2026-11-20T08:00:00.000Z'
 *     last_sync_status: 'ok'
 *     last_sync_error: ''
 *     repo_version: 'v0.4.28'
 *     commit: 'abc1234...'
 *     branch: 'main'
 *     packages: ['glossary', 'noui']
 *     warnings: []
 *   }
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseNoml, stringifyNoml } from './noml.mjs';

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readState(file) {
  let doc;
  try {
    doc = parseNoml(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  return isPlainObject(doc) ? doc : {};
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${stringifyNoml(state)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}
