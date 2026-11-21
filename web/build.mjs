#!/usr/bin/env node
/**
 * nohub 搜索页索引构建脚本
 *
 * 扫描仓库 packages/ 目录下的版本快照：
 *   packages/<pkg>/<host>/<owner>/<repo>/<repo_version>/package.noml
 * 以及同级的 latest.noml（含 version / commit），解析 noml 清单后生成：
 *   - web/data.js    ：预编译索引（window.NOHUB_INDEX），本地预览用
 *   - web/index.noml ：快照清单（gh-pages 发布到 data/，前端 fetch 后解析）
 *
 * 用法：node web/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringifyNoml } from '../lib/noml.mjs';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB_DIR, '..');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const OUT_FILE = path.join(WEB_DIR, 'data.js');
const MANIFEST_FILE = path.join(WEB_DIR, 'index.noml');

// ---------------------------------------------------------------------------
// 迷你 noml 解析器（覆盖 package.noml / latest.noml 用到的语法子集）
//   - 顶层对象，成员换行分隔，无逗号
//   - 键：裸标识符或单引号字符串
//   - 值：单引号字符串（\' \\ \n \t \r）、true/false/nil、数字、对象、数组
//   - 注释：; 到行尾
// ---------------------------------------------------------------------------
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  const isIdStart = (c) => /[a-z_]/.test(c);
  const isIdChar = (c) => /[a-z0-9_-]/.test(c);

  while (i < n) {
    const c = src[i];
    if (c === ';') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      i++;
      let s = '';
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          const esc = src[i + 1];
          const map = { "'": "'", '\\': '\\', n: '\n', t: '\t', r: '\r' };
          s += map[esc] ?? esc;
          i += 2;
        } else if (ch === "'") {
          i++;
          break;
        } else {
          s += ch;
          i++;
        }
      }
      tokens.push({ t: 'str', v: s });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX._eE+-]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j])) j++;
      const w = src.slice(i, j);
      if (w === 'true' || w === 'false') tokens.push({ t: 'bool', v: w === 'true' });
      else if (w === 'nil') tokens.push({ t: 'nil' });
      else tokens.push({ t: 'id', v: w });
      i = j;
      continue;
    }
    if ('{}[]:,'.includes(c)) {
      tokens.push({ t: c });
      i++;
      continue;
    }
    i++; // 跳过未知字符
  }
  return tokens;
}

function parseNoml(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  function parseValue() {
    const tk = peek();
    if (!tk) throw new Error('unexpected end of input');
    if (tk.t === 'str' || tk.t === 'num' || tk.t === 'bool') {
      p++;
      return tk.v;
    }
    if (tk.t === 'nil') {
      p++;
      return null;
    }
    if (tk.t === '{') return parseObject();
    if (tk.t === '[') return parseArray();
    throw new Error(`unexpected token: ${tk.t}`);
  }

  function parseObject() {
    next(); // {
    const obj = {};
    while (p < toks.length && peek().t !== '}') {
      const k = next();
      if (k.t !== 'id' && k.t !== 'str') throw new Error('bad object key');
      if (peek().t === ',') next();
      if (peek().t !== ':') throw new Error('expected ":"');
      next();
      obj[k.v] = parseValue();
      if (peek().t === ',') next(); // 容忍对象内逗号
    }
    next(); // }
    return obj;
  }

  function parseArray() {
    next(); // [
    const arr = [];
    while (p < toks.length && peek().t !== ']') {
      arr.push(parseValue());
      if (peek().t === ',') next();
    }
    next(); // ]
    return arr;
  }

  return parseValue();
}

// ---------------------------------------------------------------------------
// 扫描 packages/ 目录
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name === 'package.noml') out.push(full);
  }
  return out;
}

/** 按规范第 7 节解析 tag；包未自报 version 时用仓库版本 */
function resolveTag(pkg, version) {
  if (pkg.tag_pattern) return String(pkg.tag_pattern).replaceAll('{version}', version);
  if (pkg.tag_prefix) return String(pkg.tag_prefix) + version;
  return version;
}

/** docs 回退链：docs -> homepage -> repository */
function resolveDocs(pkg) {
  return pkg.docs || pkg.homepage || normalizeRepoUrl(pkg.repository) || '';
}

/** 把 git 克隆地址（git@ / ssh:// / 裸域名）统一成可点击的 https 页面地址 */
function normalizeRepoUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  // git@host:owner/repo.git -> https://host/owner/repo
  let m = s.match(/^git@([^:\s]+):(.+)$/);
  if (m) return `https://${m[1]}/${m[2].replace(/\.git\/?$/i, '').replace(/\/+$/, '')}`;
  // ssh://[git@]host[:port]/owner/repo.git -> https://host/owner/repo
  m = s.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (m) return `https://${m[1]}/${m[2].replace(/\.git\/?$/i, '').replace(/\/+$/, '')}`;
  // 裸域名 github.com/owner/repo -> https://github.com/owner/repo
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) {
    return `https://${s}`;
  }
  return s.replace(/\.git\/?$/i, '');
}

/** 语义化版本比较（容忍 v 前缀与不同段数），降序排列用 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return String(a).localeCompare(String(b));
}

/** 扫描 packages/ 下全部版本快照，附带解析后的 package.noml 与同级 latest.noml */
function scanSnapshots() {
  const files = walk(PACKAGES_DIR);
  const snapshots = [];

  for (const file of files) {
    const rel = path.relative(PACKAGES_DIR, file).split(path.sep);
    // packages/<pkg>/<host>/<owner>/<repo>/<repo_version>/package.noml
    if (rel.length !== 6) continue;
    const [pkgDir, host, owner, repo, repoVersion] = rel;

    const pkg = parseNoml(fs.readFileSync(file, 'utf8'));

    // latest.noml 位于 packages/<pkg>/<host>/<owner>/<repo>/latest.noml
    let latest = null;
    try {
      latest = parseNoml(
        fs.readFileSync(path.join(PACKAGES_DIR, ...rel.slice(0, 4), 'latest.noml'), 'utf8'),
      );
    } catch {
      latest = null;
    }

    snapshots.push({ pkgDir, host, owner, repo, repoVersion, pkg, latest });
  }

  return snapshots;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((x) => typeof x === 'string') : [];
}

/** 快照排序：包名升序，再按仓库版本降序（默认展示最新版本） */
function compareSnapshots(a, b) {
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  const byRepo = a.repoKey.localeCompare(b.repoKey);
  if (byRepo !== 0) return byRepo;
  return compareVersions(b.repoVersion, a.repoVersion);
}

/** 快照 → 页面索引记录（字段映射与 app.js 的 recordFrom 保持一致） */
function recordFromSnapshot({ pkgDir, host, owner, repo, repoVersion, pkg, latest }) {
  // version 允许缺省，缺省回落到仓库版本（规范第 7 节）
  const version = pkg.version ?? repoVersion;
  return {
    // 包元数据
    name: pkg.name ?? pkgDir,
    version,
    description: pkg.description ?? '',
    keywords: stringArray(pkg.keywords),
    author: pkg.author ?? '',
    email: pkg.email ?? '',
    organization: pkg.organization ?? '',
    repository: pkg.repository ?? '',
    repoUrl: normalizeRepoUrl(pkg.repository),
    homepage: pkg.homepage ?? '',
    license: pkg.license ?? '',
    dependencies: stringArray(pkg.dependencies),
    devDependencies: stringArray(pkg['dev-dependencies']),
    // nohub 扩展
    category: pkg.category ?? '',
    docs: pkg.docs ?? '',
    readme: pkg.readme ?? '',
    tagPattern: pkg.tag_pattern ?? '',
    tagPrefix: pkg.tag_prefix ?? '',
    publish: pkg.publish !== false,
    // no 编译选项
    compiler: pkg.compiler && typeof pkg.compiler === 'object' ? pkg.compiler : {},
    output: pkg.output ?? '',
    ignore: stringArray(pkg.ignore),
    // 索引派生
    host,
    owner,
    repo,
    repoVersion,
    repoKey: `${host}/${owner}/${repo}`,
    tag: resolveTag(pkg, version),
    docsUrl: resolveDocs(pkg),
    snapshotPath: `packages/${pkgDir}/${host}/${owner}/${repo}/${repoVersion}/package.noml`,
    latestCommit: latest?.commit ?? '',
  };
}

function buildIndex() {
  const records = scanSnapshots().map(recordFromSnapshot).sort(compareSnapshots);
  return {
    generatedAt: new Date().toISOString(),
    source: 'nohub packages/ 目录快照',
    count: records.length,
    packages: records,
  };
}

/**
 * gh-pages 快照清单：只带定位信息，前端 fetch 后再解析各份 package.noml。
 * 发布到 gh-pages 的 data/index.noml。
 */
function buildManifest() {
  const snapshots = scanSnapshots().map(({ pkgDir, host, owner, repo, repoVersion, pkg }) => {
    const version = pkg.version ?? repoVersion;
    return {
      name: pkg.name ?? pkgDir,
      version,
      tag: resolveTag(pkg, version),
      host,
      owner,
      repo,
      repo_version: repoVersion,
      snapshot: `packages/${pkgDir}/${host}/${owner}/${repo}/${repoVersion}/package.noml`,
      latest: `packages/${pkgDir}/${host}/${owner}/${repo}/latest.noml`,
    };
  });

  snapshots.sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    const byRepo = `${a.host}/${a.owner}/${a.repo}`.localeCompare(`${b.host}/${b.owner}/${b.repo}`);
    if (byRepo !== 0) return byRepo;
    return compareVersions(b.repo_version, a.repo_version);
  });

  return {
    generated_at: new Date().toISOString(),
    source: 'nohub packages/ 目录快照',
    snapshots,
  };
}

const index = buildIndex();
const banner = `// 由 web/build.mjs 自动生成，请勿手动修改。\n// 重新生成：node web/build.mjs\n`;
fs.writeFileSync(OUT_FILE, `${banner}window.NOHUB_INDEX = ${JSON.stringify(index, null, 2)};\n`);

const manifest = buildManifest();
const manifestBanner = '; 由 web/build.mjs 自动生成，请勿手动修改。\n; 重新生成：node web/build.mjs\n';
fs.writeFileSync(MANIFEST_FILE, manifestBanner + stringifyNoml(manifest) + '\n');

console.log(`✓ 索引已生成：${path.relative(ROOT, OUT_FILE)}`);
console.log(`  共 ${index.count} 个包，扫描快照 ${walk(PACKAGES_DIR).length} 份`);
for (const r of index.packages) {
  console.log(`  - ${r.name}@${r.host}/${r.owner}/${r.repo} ${r.repoVersion} (tag ${r.tag})`);
}
console.log(`✓ 快照清单已生成：${path.relative(ROOT, MANIFEST_FILE)}（${manifest.snapshots.length} 份）`);
