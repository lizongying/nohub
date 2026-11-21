/**
 * git 只读操作：用 `git ls-remote --symref` 一次拿到全部 ref 与默认分支，
 * 再据此解析「仓库版本」（最新语义化 tag，无 tag 时退化为分支 HEAD 短 SHA）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * 构造给 git 用的环境变量。
 *
 * 某些环境（IDE、CI 包装脚本）会注入不完整的 `GIT_CONFIG_*` 变量
 * （有 `GIT_CONFIG_COUNT` 却没有对应的 `GIT_CONFIG_KEY_n`），
 * git 会直接拒绝启动：`missing config key GIT_CONFIG_KEY_0`。
 * 这里按 `KEY_n`/`VALUE_n` 成对重建，落单的项直接丢弃。
 */
function gitEnv() {
  const env = { ...process.env };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const keys = [];
  const values = [];
  let ok = Number.isInteger(count) && count > 0;

  for (let i = 0; ok && i < count; i++) {
    const k = env[`GIT_CONFIG_KEY_${i}`];
    const v = env[`GIT_CONFIG_VALUE_${i}`];
    if (typeof k !== 'string' || typeof v !== 'string') {
      ok = false;
      break;
    }
    keys.push(k);
    values.push(v);
  }

  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) delete env[name];
  }
  if (ok) {
    env.GIT_CONFIG_COUNT = String(count);
    keys.forEach((k, i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = values[i];
    });
  }
  return env;
}

const TAG_PREFIX = 'refs/tags/';
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 列出远端引用。
 *
 * @returns {Promise<{refs: Map<string,string>, defaultBranch: string|null}>}
 *   refs 的键是完整 ref 名（含 `refs/tags/x^{}` 这种 peeled 行），值是 commit SHA。
 */
export async function lsRemote(url) {
  const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', url], {
    maxBuffer: MAX_BUFFER,
    env: gitEnv(),
  });
  return parseLsRemote(stdout);
}

export function parseLsRemote(stdout) {
  const refs = new Map();
  let defaultBranch = null;
  for (const line of stdout.split('\n')) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (sym) {
      defaultBranch = sym[1];
      continue;
    }
    const m = line.match(/^([0-9a-f]{40})\t(.+)$/);
    if (m) refs.set(m[2], m[1]);
  }
  return { refs, defaultBranch };
}

/**
 * 列出仓库的全部语义化 tag 版本，按语义化版本升序。
 *
 * 同步不再只抓最新 tag，而是给每个版本都留一份快照（见 docs 6.8），
 * 因此这里返回全部命中 SEMVER 的 tag，而不是只取最大的那个。
 *
 * @param {Map<string,string>} refs
 * @returns {Array<{version: string, commit: string, tag: string, ref: string,
 *   major: number, minor: number, patch: number, pre: string|null}>}
 */
export function listRepoVersions(refs) {
  const out = [];
  for (const [name, sha] of refs) {
    if (!name.startsWith(TAG_PREFIX)) continue;
    const short = name.slice(TAG_PREFIX.length);
    if (short.endsWith('^{}')) continue;
    const m = short.match(SEMVER);
    if (!m) continue;
    out.push({
      version: short,
      commit: refs.get(`${TAG_PREFIX}${short}^{}`) ?? sha,
      tag: short,
      ref: short,
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      pre: m[4] ?? null,
    });
  }
  out.sort(compareSemver);
  return out;
}

/**
 * 解析仓库版本（最新版本）。
 *
 * @param {Map<string,string>} refs
 * @param {string} branch 已确定的分支（缺省取默认分支）
 * @returns {{version: string|null, commit: string|null, tag: string|null, ref: string|null}}
 *   version 即快照目录名；tag 为命中的语义化 tag；ref 是抓取清单用的 ref。
 */
export function resolveRepoVersion(refs, branch) {
  const versions = listRepoVersions(refs);
  if (versions.length > 0) {
    const top = versions[versions.length - 1];
    return { version: top.version, commit: top.commit, tag: top.tag, ref: top.ref };
  }

  const headSha = (branch && refs.get(`refs/heads/${branch}`)) || refs.get('HEAD');
  if (!headSha) return { version: null, commit: null, tag: null, ref: branch ?? null };
  return { version: headSha.slice(0, 7), commit: headSha, tag: null, ref: branch ?? 'HEAD' };
}

/** 语义化版本比较，b 更大时返回正数。 */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return comparePrerelease(a.pre, b.pre);
}

function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // 正式版本高于预发布版本
  if (b === null) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1; // 数字标识符低于字母标识符
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
