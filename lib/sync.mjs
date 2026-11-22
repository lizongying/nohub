/**
 * nohub 同步器。
 *
 * 读取 repos/<host>/<owner>.noml 里的作者收录记录，对每个 active 仓库：
 *   1. `git ls-remote` 取 ref，解析仓库版本（最新语义化 tag，无 tag 用分支 HEAD 短 SHA）
 *   2. 抓 workspace.noml（缺省 /workspace.noml），不存在则回退根目录 package.noml（单包仓库）
 *   3. 逐个抓 package.noml，校验后按仓库版本写快照
 *   4. 写包级 latest.noml（{ version, commit, versions }，versions 是全量版本索引），并汇总根目录 latest.noml
 *   5. 更新 state/sync.noml；全量同步时清理已删除仓库的快照
 *
 * 增量：state/sync.noml 里记录过的版本视为已同步，默认不再抓取；上次同步失败时
 * 最新版本会重试。传 force: true 可忽略状态重新抓取全部版本。
 *
 * 网络实现可注入，便于离线测试：
 *   sync({ fetchRepoFile, lsRemote, root, filter, dryRun, now, force })
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseNoml, stringifyNoml } from './noml.mjs';
import { DEFAULT_ROOT, makePaths } from './paths.mjs';
import { createRawFetcher, isNotFound } from './raw.mjs';
import { lsRemote, listRepoVersions, compareSemver } from './git.mjs';
import { isPlainObject, readState, writeState } from './state.mjs';

const DEFAULT_WORKSPACE = '/workspace.noml';
const SEMVER_LOOSE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 执行同步。
 *
 * @param {object} [options]
 * @param {string} [options.root]       实例仓库根目录，缺省取参考实现根
 * @param {string} [options.filter]     只同步 `host/owner/repo` 或 `owner/repo`，留空全量
 * @param {(host:string,owner:string,repo:string,ref:string,p:string)=>Promise<string>} [options.fetchRepoFile]
 * @param {(url:string)=>Promise<{refs:Map<string,string>,defaultBranch:string|null}>} [options.lsRemote]
 * @param {boolean} [options.dryRun]    只报告不写盘
 * @param {boolean} [options.force]     忽略增量状态，重新抓取全部版本
 * @param {string} [options.now]        同步时间戳（测试用）
 * @returns {Promise<object>} 同步报告
 */
export async function sync(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const paths = makePaths(root);
  const fetchRepoFile = options.fetchRepoFile ?? createRawFetcher();
  const lsRemoteFn = options.lsRemote ?? lsRemote;
  const now = options.now ?? new Date().toISOString();
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const filter = normalizeFilter(options.filter);

  const report = {
    startedAt: now,
    filter: filter ? filter.raw : '',
    repos: [],
    removed: [],
    errors: 0,
    partial: 0,
    warnings: 0,
    skipped: [],
    latest: null,
    stateWritten: false,
  };

  const authors = await loadAuthors(paths.repos, filter);
  const live = new Set();
  const updates = new Map(); // 'host/owner/repo' -> ['<pkg>:<version>@host/owner/repo', ...]
  const state = readState(paths.stateFile);

  for (const author of authors) {
    for (const entry of author.entries) {
      if (filter && filter.repo && entry.name !== filter.repo) continue;

      const key = `${author.host}/${author.owner}/${entry.name}`;
      if (entry.status === 'paused') {
        report.repos.push({
          host: author.host,
          owner: author.owner,
          repo: entry.name,
          status: 'skipped',
          reason: 'paused',
        });
        continue;
      }

      live.add(key);
      const result = await syncOne({
        host: author.host,
        owner: author.owner,
        entry,
        paths,
        fetchRepoFile,
        lsRemoteFn,
        now,
        dryRun,
        force,
        state,
      });

      report.repos.push(result.report);
      if (result.report.status === 'ok' || result.report.status === 'partial') {
        // 最新版本也命中缓存时，根 latest.noml 保持原样，避免用重建的包列表误写版本。
        if (result.latestTouched || !fs.existsSync(paths.latest)) {
          const version = result.report.version;
          updates.set(
            key,
            result.report.packages.map((p) => `${p.name}:${version}@${key}`),
          );
        }
        if (result.report.status === 'partial') report.partial++;
      } else {
        report.errors++;
      }
      report.warnings += result.report.warnings.length;
      for (const s of result.report.skipped ?? []) report.skipped.push({ repo: key, ...s });
    }
  }

  // 部分同步不清理：filter 只覆盖部分仓库，其余仓库的快照不应被删掉
  const removedKeys = filter ? [] : await prune(paths, live, dryRun);
  report.removed = removedKeys.map((k) => k.path);

  report.latest = await rebuildLatest(paths.latest, updates, removedKeys, dryRun);

  if (!dryRun) report.stateWritten = writeState(paths.stateFile, state);

  report.ok = report.errors === 0 && report.partial === 0;
  return report;
}

// ---------------------------------------------------------------------------
// 单个仓库
// ---------------------------------------------------------------------------

async function syncOne(ctx) {
  const { host, owner, entry, paths, fetchRepoFile, lsRemoteFn, now, dryRun, force, state } = ctx;
  const name = entry.name;
  const key = `${host}/${owner}/${name}`;
  const repoUrl = `https://${host}/${owner}/${name}`;
  const prior = isPlainObject(state[key]) ? state[key] : null;
  const seen = new Set(Array.isArray(prior?.versions) ? prior.versions : []);
  // 上次失败的仓库，最新版本必须重试；其它已记录版本直接沿用快照。
  const retryLatest = prior?.['last-sync-status'] === 'error';

  const report = {
    host,
    owner,
    repo: name,
    status: 'ok',
    version: '',
    commit: '',
    branch: '',
    ref: '',
    workspace: entry.workspace ?? DEFAULT_WORKSPACE,
    versions: [],
    packages: [],
    skipped: [],
    warnings: [],
    error: '',
    processed: 0,
    cached: 0,
  };
  let touched = 0;
  let latestTouched = false;

  try {
    const { refs, defaultBranch } = await lsRemoteFn(repoUrl);
    const branch = entry.branch ?? defaultBranch ?? 'main';
    const versions = listRepoVersions(refs);
    if (versions.length === 0) {
      // 无语义化 tag：退化为分支 HEAD 短 SHA，只留一个版本
      const headSha = (branch && refs.get(`refs/heads/${branch}`)) || refs.get('HEAD');
      if (!headSha) throw new Error('无法解析仓库版本：既没有语义化 tag，也没有可用的 HEAD');
      versions.push({ version: headSha.slice(0, 7), commit: headSha, tag: null, ref: branch ?? 'HEAD' });
    }

    const latest = versions[versions.length - 1];
    report.branch = branch;
    report.version = latest.version;
    report.commit = latest.commit ?? '';
    report.ref = latest.ref ?? branch;
    report.versions = [];

    const remoteByVersion = new Map(versions.map((v) => [v.version, v]));
    // 包级索引以磁盘上的 latest.noml 为底稿：跳过旧版本时仍保留完整版本列表。
    const packageIndexes = loadPackageIndexes(paths, host, owner, name, remoteByVersion);

    let partial = false;
    let latestPackages = null;
    for (let i = 0; i < versions.length; i++) {
      const ver = versions[i];
      const isLatest = i === versions.length - 1;
      const cached = !force && seen.has(ver.version) && !(isLatest && retryLatest);
      if (cached) {
        report.versions.push({
          version: ver.version,
          commit: ver.commit,
          status: 'cached',
          packages: [],
          skipped: [],
          warnings: [],
        });
        report.cached++;
        continue;
      }

      touched++;
      const res = await syncVersion({ host, owner, name, entry, paths, fetchRepoFile, dryRun }, ver, refs, isLatest);

      report.versions.push({
        version: ver.version,
        commit: ver.commit,
        status: res.status,
        packages: res.packages,
        skipped: res.skipped,
        warnings: res.warnings,
      });
      for (const p of res.packages) {
        if (!packageIndexes.has(p.name)) packageIndexes.set(p.name, new Map());
        packageIndexes.get(p.name).set(ver.version, {
          version: ver.version,
          commit: ver.commit ?? '',
          cmp: remoteByVersion.get(ver.version) ?? ver,
        });
      }
      for (const s of res.skipped) report.skipped.push({ version: ver.version, ...s });
      for (const w of res.warnings) report.warnings.push(w);
      if (res.status === 'partial') partial = true;
      if (isLatest) {
        latestPackages = res.packages;
        latestTouched = true;
      }
      if (res.status === 'error') throw new Error(res.error);
    }
    report.processed = touched;

    // 最新版本也已缓存时沿用上次的包列表，不动根 latest.noml。
    if (latestPackages == null) {
      latestPackages = (Array.isArray(prior?.packages) ? prior.packages : [])
        .filter((n) => typeof n === 'string')
        .map((n) => ({ name: n, path: '', version: prior['repo-version'] ?? report.version }));
    }
    report.packages = latestPackages;

    // 只有实际处理过版本才重写包级索引，全量命中缓存时一遍文件都不碰。
    if (!dryRun && touched > 0) writePackageIndexes(paths, host, owner, name, packageIndexes);
    report.status = partial ? 'partial' : 'ok';
  } catch (err) {
    report.status = 'error';
    report.error = err.message;
    report.packages = [];
    report.skipped = [];
    report.processed = touched;
  }

  // 全部命中缓存且已有状态：保留原来的 last-sync-at，不产生无意义的每日提交。
  if (!dryRun && (touched > 0 || prior == null)) {
    state[key] = {
      'last-sync-at': now,
      'last-sync-status': report.status,
      'last-sync-error': report.error || null,
      'repo-version': report.version,
      commit: report.commit,
      branch: report.branch,
      versions: report.versions.map((v) => v.version),
      packages: report.packages.map((p) => p.name),
      skipped: report.skipped,
      warnings: report.warnings,
    };
  }

  return { report, touched, latestTouched };
}

/** 读取磁盘上已有的包级 latest.noml，作为增量同步的版本索引底稿。 */
function loadPackageIndexes(paths, host, owner, name, remoteByVersion) {
  const indexes = new Map();
  for (const pkgName of safeReaddir(paths.packages)) {
    const file = path.join(paths.packages, pkgName, host, owner, name, 'latest.noml');
    if (!fs.existsSync(file)) continue;
    let doc;
    try {
      doc = parseNoml(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isPlainObject(doc) || !Array.isArray(doc.versions)) continue;
    const idx = new Map();
    for (const item of doc.versions) {
      if (!isPlainObject(item) || typeof item.version !== 'string') continue;
      const ver = remoteByVersion.get(item.version);
      if (!ver) continue; // 远端已删除的 tag 不再保留在索引里
      idx.set(item.version, {
        version: item.version,
        commit: typeof item.commit === 'string' ? item.commit : '',
        cmp: ver,
      });
    }
    indexes.set(pkgName, idx);
  }
  return indexes;
}

/** 把包级 latest.noml 写回：versions 保留全部已同步版本，升序。 */
function writePackageIndexes(paths, host, owner, name, indexes) {
  for (const [pkgName, idx] of indexes) {
    if (idx.size === 0) continue;
    const entries = [...idx.values()].sort((a, b) => compareSemver(a.cmp, b.cmp));
    const top = entries[entries.length - 1];
    const text = `${stringifyNoml({
      version: top.version,
      commit: top.commit,
      versions: entries.map((it) => ({ version: it.version, commit: it.commit })),
    })}\n`;
    writeIfChanged(path.join(paths.packages, pkgName, host, owner, name, 'latest.noml'), text);
  }
}

/**
 * 同步单个仓库版本：抓 workspace.noml / package.noml，校验后写快照。
 *
 * 旧版本没有清单（上游早期 tag 还没有 workspace.noml）不算错误，只跳过并告警；
 * 最新版本抓不到就是整仓失败。返回 `{ status, packages, skipped, warnings, error }`，
 * status 取值 `ok` / `partial` / `skipped` / `error`。
 */
async function syncVersion(ctx, ver, refs, isLatest) {
  const { host, owner, name, entry, paths, fetchRepoFile, dryRun } = ctx;
  const workspace = entry.workspace ?? DEFAULT_WORKSPACE;
  const out = { status: 'ok', packages: [], skipped: [], warnings: [], error: '' };

  // 1) 工作区清单
  let workspaceRaw = null;
  try {
    workspaceRaw = await fetchRepoFile(host, owner, name, ver.ref, workspace);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // 单包仓库：没有 workspace.noml 是允许的
  }

  // 2) 待同步的包
  let specs;
  if (workspaceRaw != null) {
    const ws = parseNoml(workspaceRaw);
    if (!isPlainObject(ws)) throw new Error('workspace.noml 顶层必须是对象');
    specs = Object.keys(ws).map((k) => ({ key: k, relPath: ws[k] }));
    for (const s of specs) {
      if (typeof s.relPath !== 'string') {
        throw new Error(`workspace.noml 里 "${s.key}" 的值必须是字符串（no build 要求纯映射）`);
      }
      if (!s.relPath.startsWith('/')) {
        throw new Error(`workspace.noml 里 "${s.key}" 的路径必须以 / 开头`);
      }
    }
  }

  const manifests = [];
  if (specs && specs.length > 0) {
    for (const s of specs) {
      const raw = await fetchRepoFile(host, owner, name, ver.ref, `${s.relPath}/package.noml`);
      manifests.push({ key: s.key, relPath: s.relPath, raw, pkg: parseNoml(raw) });
    }
  } else {
    let raw;
    try {
      raw = await fetchRepoFile(host, owner, name, ver.ref, '/package.noml');
    } catch (err) {
      if (isNotFound(err)) {
        if (isLatest) {
          out.status = 'error';
          out.error = `最新版本 ${ver.version} 既没有 ${workspace} 也没有根 package.noml`;
          return out;
        }
        out.status = 'skipped';
        out.warnings.push(`${ver.version}: 既没有 ${workspace} 也没有根 package.noml，跳过该版本`);
        return out;
      }
      throw err;
    }
    const pkg = parseNoml(raw);
    if (!isPlainObject(pkg) || typeof pkg.name !== 'string') {
      throw new Error('根目录 package.noml 缺少合法的 name');
    }
    manifests.push({ key: pkg.name, relPath: '/', raw, pkg });
  }

  // 3) 逐包校验：坏包只跳过自己，不连坐整个仓库
  //    （真实上游里缺 license、缺 version 的包很常见）
  const written = [];
  for (const m of manifests) {
    const check = checkManifest(m, refs, ver.version);
    if (!check.ok) {
      out.skipped.push({ key: m.key, path: m.relPath, reason: check.error });
      out.warnings.push(`${ver.version}/${m.key}: ${check.error}（已跳过该包）`);
      continue;
    }
    m.version = check.version;
    out.warnings.push(...check.warnings.map((w) => `${ver.version}/${m.key}: ${w}`));
    written.push(m);
  }
  if (written.length === 0) {
    if (isLatest) {
      out.status = 'error';
      out.error = '所有包都未通过校验，已全部跳过';
      return out;
    }
    out.status = 'skipped';
    out.warnings.push(`${ver.version}: 所有包都未通过校验，跳过该版本`);
    return out;
  }

  // 4) 写快照（原样落盘，保证快照就是上游内容）；包级 latest.noml 在 syncOne 里统一写
  if (!dryRun) {
    if (workspaceRaw != null) {
      writeIfChanged(path.join(paths.workspaces, host, owner, name, ver.version, 'workspace.noml'), workspaceRaw);
    }
    for (const m of written) {
      const dir = path.join(paths.packages, m.pkg.name, host, owner, name, ver.version);
      writeIfChanged(path.join(dir, 'package.noml'), m.raw);
    }
  }

  out.status = written.length < manifests.length ? 'partial' : 'ok';
  out.packages = written.map((m) => ({ name: m.pkg.name, path: m.relPath, version: m.version }));
  return out;
}

/**
 * 逐包校验，返回 `{ ok, error, version, warnings }`。
 * `version` 允许缺省：缺省时回落到仓库版本（docs 第 4.1、7 节）。
 * tag 不可解析只告警，不拒绝写入。
 */
function checkManifest(m, refs, repoVersion) {
  const pkg = m.pkg;
  const warnings = [];

  if (!isPlainObject(pkg)) {
    return { ok: false, error: `${m.relPath}/package.noml 顶层必须是对象`, warnings };
  }
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    return { ok: false, error: `${m.relPath}/package.noml 缺少合法的 name`, warnings };
  }
  if (pkg.name !== m.key) {
    return {
      ok: false,
      error: `包名不一致：workspace 键 "${m.key}" 与 package.noml 的 name "${pkg.name}" 不符`,
      warnings,
    };
  }

  let version = repoVersion;
  if (pkg.version !== undefined) {
    if (typeof pkg.version !== 'string' || !SEMVER_LOOSE.test(pkg.version)) {
      return { ok: false, error: `package.noml 的 version 不是语义化版本：${String(pkg.version)}`, warnings };
    }
    version = pkg.version;
  }

  if (pkg.license === undefined) {
    warnings.push('缺少 license');
  } else if (typeof pkg.license !== 'string' || pkg.license.trim() === '') {
    return { ok: false, error: 'package.noml 的 license 必须是有效的 SPDX 标识字符串', warnings };
  }

  // tag 可解析性只告警：快照版本以仓库 tag 为准，包自报的 version/tag 仅作索引元数据。
  // 只有显式声明了 tag_pattern / tag_prefix 才要求命中的 tag 真实存在；
  // 未声明时 tag 缺省等于包自己的 version，与仓库 tag 本就可以不同（见 docs 第 7 节）。
  if (pkg.tag_pattern || pkg.tag_prefix) {
    const tag = resolveTag(pkg, version);
    if (!refs.has(`refs/tags/${tag}`)) {
      warnings.push(`tag "${tag}" 在仓库中不存在（version=${version}）`);
    }
  }

  return { ok: true, version, warnings };
}

/** 按 docs 第 7 节解析 tag；包未自报 version 时用仓库版本。 */
export function resolveTag(pkg, repoVersion = '') {
  const version = typeof pkg.version === 'string' && pkg.version ? pkg.version : repoVersion;
  if (typeof pkg.tag_pattern === 'string' && pkg.tag_pattern) {
    return pkg.tag_pattern.replaceAll('{version}', version);
  }
  if (typeof pkg.tag_prefix === 'string' && pkg.tag_prefix) {
    return pkg.tag_prefix + version;
  }
  return version || null;
}

// ---------------------------------------------------------------------------
// 作者记录
// ---------------------------------------------------------------------------

async function loadAuthors(reposDir, filter) {
  const out = [];
  if (!fs.existsSync(reposDir)) return out;

  for (const host of safeReaddir(reposDir)) {
    if (filter && filter.host !== host) continue;
    const hostDir = path.join(reposDir, host);
    if (!statDir(hostDir)) continue;

    for (const name of safeReaddir(hostDir)) {
      if (!name.endsWith('.noml')) continue;
      const owner = name.slice(0, -'.noml'.length);
      if (filter && filter.owner !== owner) continue;

      const authorFile = path.join(hostDir, name);
      let doc;
      try {
        doc = parseNoml(fs.readFileSync(authorFile, 'utf8'));
      } catch (err) {
        throw new Error(`作者记录 ${authorFile} 解析失败：${err.message}`);
      }
      if (!Array.isArray(doc)) throw new Error(`作者记录 ${authorFile} 顶层必须是数组`);

      const entries = [];
      for (const el of doc) {
        if (typeof el === 'string') {
          entries.push({ name: el, status: 'active' });
        } else if (isPlainObject(el) && typeof el.name === 'string') {
          entries.push({
            name: el.name,
            branch: typeof el.branch === 'string' ? el.branch : undefined,
            workspace: typeof el.workspace === 'string' ? el.workspace : undefined,
            status: el.status === 'paused' ? 'paused' : 'active',
          });
        }
      }
      out.push({ host, owner, file: authorFile, entries });
    }
  }
  return out;
}

function normalizeFilter(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parts = text.split('/').filter(Boolean);
  if (parts.length >= 3) return { host: parts[0], owner: parts[1], repo: parts[2], raw: text };
  if (parts.length === 2) return { host: 'github.com', owner: parts[0], repo: parts[1], raw: text };
  return { host: 'github.com', owner: parts[0], repo: null, raw: text };
}

// ---------------------------------------------------------------------------
// 清理 / latest
// ---------------------------------------------------------------------------

/** 全量同步时删除已不在收录记录里的仓库快照，返回被删的 key。 */
async function prune(paths, live, dryRun) {
  const removed = [];

  // workspaces/<host>/<owner>/<repo>
  for (const host of safeReaddir(paths.workspaces)) {
    const hostDir = path.join(paths.workspaces, host);
    if (!statDir(hostDir)) continue;
    for (const owner of safeReaddir(hostDir)) {
      const ownerDir = path.join(hostDir, owner);
      if (!statDir(ownerDir)) continue;
      for (const repo of safeReaddir(ownerDir)) {
        const dir = path.join(ownerDir, repo);
        if (!statDir(dir)) continue;
        const key = `${host}/${owner}/${repo}`;
        if (live.has(key)) continue;
        removed.push({ key, path: `workspaces/${key}` });
        if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  // packages/<pkg>/<host>/<owner>/<repo>
  for (const pkg of safeReaddir(paths.packages)) {
    const pkgDir = path.join(paths.packages, pkg);
    if (!statDir(pkgDir)) continue;
    for (const host of safeReaddir(pkgDir)) {
      const hostDir = path.join(pkgDir, host);
      if (!statDir(hostDir)) continue;
      for (const owner of safeReaddir(hostDir)) {
        const ownerDir = path.join(hostDir, owner);
        if (!statDir(ownerDir)) continue;
        for (const repo of safeReaddir(ownerDir)) {
          const dir = path.join(ownerDir, repo);
          if (!statDir(dir)) continue;
          const key = `${host}/${owner}/${repo}`;
          if (live.has(key)) continue;
          removed.push({ key, path: `packages/${pkg}/${key}` });
          if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }

  return removed;
}

/** 汇总根目录 latest.noml：更新成功仓库的条目，删除已下线仓库的条目。 */
async function rebuildLatest(latestFile, updates, removed, dryRun) {
  let existing = [];
  if (fs.existsSync(latestFile)) {
    try {
      const doc = parseNoml(fs.readFileSync(latestFile, 'utf8'));
      if (Array.isArray(doc)) existing = doc.filter((x) => typeof x === 'string');
    } catch {
      existing = [];
    }
  }

  const byRepo = new Map();
  for (const item of existing) {
    const at = item.lastIndexOf('@');
    if (at < 0) continue;
    const key = item.slice(at + 1);
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(item);
  }
  for (const { key } of removed) byRepo.delete(key);
  for (const [key, items] of updates) byRepo.set(key, items);

  const entries = [];
  for (const key of [...byRepo.keys()].sort()) {
    for (const item of byRepo.get(key).sort()) entries.push(item);
  }

  const text = `${stringifyNoml(entries)}\n`;
  const changed = !fs.existsSync(latestFile) || fs.readFileSync(latestFile, 'utf8') !== text;
  if (changed && !dryRun) writeIfChanged(latestFile, text);

  return { file: latestFile, count: entries.length, changed, entries };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function writeIfChanged(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return false;
  fs.writeFileSync(file, text);
  return true;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
