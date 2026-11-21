import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync } from '../lib/sync.mjs';
import { HttpError } from '../lib/raw.mjs';
import { parseNoml } from '../lib/noml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-11-20T08:00:00.000Z';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const WORKSPACE = `{
  glossary: '/glossary'
  noui: '/noui'
}
`;

const GLOSSARY = `{
  name: 'glossary'
  version: '0.1.0'
  description: 'Nolang 词条化知识库'
  license: 'Apache-2.0'
  repository: 'https://github.com/lizongying/nolang'
  tag_pattern: 'v{version}'
  compiler: { version: 'v0.4.19' }
}
`;

const NOUI = `{
  name: 'noui'
  version: '0.2.0'
  description: 'Nolang UI 组件库'
  license: 'MIT'
  repository: 'https://github.com/lizongying/nolang'
}
`;

const REFS = new Map([
  ['HEAD', SHA_B],
  ['refs/heads/main', SHA_B],
  ['refs/tags/v0.4.27', SHA_A],
  ['refs/tags/v0.4.28', SHA_B],
]);

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(ROOT, '.test-tmp-'));
  fs.mkdirSync(path.join(dir, 'repos', 'github.com'), { recursive: true });
  return dir;
}

function writeAuthors(dir, text) {
  fs.writeFileSync(path.join(dir, 'repos', 'github.com', 'lizongying.noml'), text);
}

function fakeFetcher(files) {
  return async (host, owner, repo, _ref, p) => {
    const key = `${host}/${owner}/${repo}|${p}`;
    if (!(key in files)) throw new HttpError(404, key);
    return files[key];
  };
}

const lsRemote = async () => ({ refs: REFS, defaultBranch: 'main' });

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function exists(dir, rel) {
  return fs.existsSync(path.join(dir, rel));
}

function mtimes(dir) {
  const out = new Map();
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = path.join(prefix, e.name);
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, rel);
      else out.set(rel, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir, '');
  return out;
}

const baseFiles = {
  'github.com/lizongying/nolang|/workspace.noml': WORKSPACE,
  'github.com/lizongying/nolang|/glossary/package.noml': GLOSSARY,
  'github.com/lizongying/nolang|/noui/package.noml': NOUI,
};

test('全量同步：写快照、包级 latest、根 latest 与 state', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const report = await sync({
    root: dir,
    now: NOW,
    fetchRepoFile: fakeFetcher(baseFiles),
    lsRemote,
  });

  assert.equal(report.errors, 0);
  assert.equal(report.repos[0].status, 'ok');
  assert.equal(report.repos[0].version, 'v0.4.28');
  assert.equal(report.repos[0].commit, SHA_B);

  // 快照原样落盘
  assert.equal(read(dir, 'workspaces/github.com/lizongying/nolang/v0.4.28/workspace.noml'), WORKSPACE);
  assert.equal(read(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.28/package.noml'), GLOSSARY);
  assert.equal(read(dir, 'packages/noui/github.com/lizongying/nolang/v0.4.28/package.noml'), NOUI);

  // 包级 latest.noml
  const latest = parseNoml(read(dir, 'packages/glossary/github.com/lizongying/nolang/latest.noml'));
  assert.deepEqual(latest, { version: 'v0.4.28', commit: SHA_B });

  // 根 latest.noml
  assert.deepEqual(
    parseNoml(read(dir, 'latest.noml')),
    [
      'glossary:v0.4.28@github.com/lizongying/nolang',
      'noui:v0.4.28@github.com/lizongying/nolang',
    ],
  );

  // state
  const state = parseNoml(read(dir, 'state/sync.noml'));
  assert.equal(state['github.com/lizongying/nolang'].last_sync_status, 'ok');
  assert.equal(state['github.com/lizongying/nolang'].last_sync_at, NOW);
  assert.deepEqual(state['github.com/lizongying/nolang'].packages, ['glossary', 'noui']);
});

test('全量同步：为每个仓库版本都写快照，latest 只指向最新', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(baseFiles), lsRemote });

  assert.equal(report.errors, 0);
  for (const v of ['v0.4.27', 'v0.4.28']) {
    assert.ok(exists(dir, `workspaces/github.com/lizongying/nolang/${v}/workspace.noml`), `${v} 应有 workspace 快照`);
    assert.ok(exists(dir, `packages/glossary/github.com/lizongying/nolang/${v}/package.noml`), `${v} 应有 glossary 快照`);
    assert.ok(exists(dir, `packages/noui/github.com/lizongying/nolang/${v}/package.noml`), `${v} 应有 noui 快照`);
  }

  // report.versions 升序，最新版本在末尾
  assert.deepEqual(report.repos[0].versions.map((v) => v.version), ['v0.4.27', 'v0.4.28']);

  // 包级 / 根 latest.noml 只指向最新版本
  assert.deepEqual(
    parseNoml(read(dir, 'packages/glossary/github.com/lizongying/nolang/latest.noml')),
    { version: 'v0.4.28', commit: SHA_B },
  );
  assert.deepEqual(parseNoml(read(dir, 'latest.noml')), [
    'glossary:v0.4.28@github.com/lizongying/nolang',
    'noui:v0.4.28@github.com/lizongying/nolang',
  ]);

  const state = parseNoml(read(dir, 'state/sync.noml'));
  assert.deepEqual(state['github.com/lizongying/nolang'].versions, ['v0.4.27', 'v0.4.28']);
});

test('旧版本没有清单：跳过该版本并告警，不影响整仓', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  // v0.4.27 上 workspace.noml 与根 package.noml 都抓不到（上游早期 tag 常见）
  const fetchRepoFile = async (host, owner, repo, ref, p) => {
    if (ref === 'v0.4.27') throw new HttpError(404, `${ref}${p}`);
    const key = `${host}/${owner}/${repo}|${p}`;
    if (!(key in baseFiles)) throw new HttpError(404, key);
    return baseFiles[key];
  };

  const report = await sync({ root: dir, now: NOW, fetchRepoFile, lsRemote });

  assert.equal(report.errors, 0);
  assert.equal(report.repos[0].status, 'ok');
  assert.deepEqual(
    report.repos[0].versions.map((v) => [v.version, v.status]),
    [['v0.4.27', 'skipped'], ['v0.4.28', 'ok']],
  );
  assert.ok(!exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.27'));
  assert.ok(report.repos[0].warnings.some((w) => /v0\.4\.27/.test(w)));
  assert.ok(exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.28/package.noml'));
});

test('最新版本没有清单：整仓失败', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const fetchRepoFile = async (host, owner, repo, ref, p) => {
    if (ref === 'v0.4.28') throw new HttpError(404, `${ref}${p}`);
    const key = `${host}/${owner}/${repo}|${p}`;
    if (!(key in baseFiles)) throw new HttpError(404, key);
    return baseFiles[key];
  };

  const report = await sync({ root: dir, now: NOW, fetchRepoFile, lsRemote });

  assert.equal(report.errors, 1);
  assert.equal(report.repos[0].status, 'error');
  assert.match(report.repos[0].error, /最新版本 v0\.4\.28 既没有/);
  // 旧版本快照保留，最新版本不写
  assert.ok(exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.27/package.noml'));
  assert.ok(!exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.28'));
});

test('幂等：同样输入再跑一次，文件不重写', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const opts = { root: dir, now: NOW, fetchRepoFile: fakeFetcher(baseFiles), lsRemote };
  await sync(opts);
  const before = mtimes(dir);

  const report = await sync(opts);
  const after = mtimes(dir);

  assert.equal(report.latest.changed, false);
  assert.equal(report.stateWritten, false);
  assert.deepEqual([...after.entries()], [...before.entries()]);
});

test('删除收录记录：清理快照与 latest 条目', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const opts = { root: dir, now: NOW, fetchRepoFile: fakeFetcher(baseFiles), lsRemote };
  await sync(opts);
  assert.ok(exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.28/package.noml'));

  writeAuthors(dir, `[]\n`);
  const report = await sync(opts);

  assert.equal(report.errors, 0);
  assert.ok(report.removed.includes('workspaces/github.com/lizongying/nolang'));
  assert.ok(report.removed.some((p) => p.startsWith('packages/glossary/github.com/lizongying/nolang')));
  assert.ok(!exists(dir, 'workspaces/github.com/lizongying/nolang'));
  assert.ok(!exists(dir, 'packages/glossary/github.com/lizongying/nolang'));
  assert.ok(!exists(dir, 'packages/noui/github.com/lizongying/nolang'));
  assert.deepEqual(parseNoml(read(dir, 'latest.noml')), []);
});

test('校验失败：单个包不合法时只跳过该包，不连坐整仓', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const files = { ...baseFiles, 'github.com/lizongying/nolang|/noui/package.noml': NOUI.replace('name: \'noui\'', 'name: \'other\'') };
  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(files), lsRemote });

  assert.equal(report.errors, 0);
  assert.equal(report.partial, 1);
  assert.equal(report.repos[0].status, 'partial');
  // 每个版本各跳过一次坏包
  assert.deepEqual(report.repos[0].skipped.map((s) => `${s.version}/${s.key}`), ['v0.4.27/noui', 'v0.4.28/noui']);
  assert.match(report.repos[0].skipped[0].reason, /包名不一致/);
  // 好包照常落盘，坏包一个字节都不写
  assert.ok(exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.28/package.noml'));
  assert.ok(exists(dir, 'workspaces/github.com/lizongying/nolang/v0.4.28/workspace.noml'));
  assert.ok(!exists(dir, 'packages/noui/github.com/lizongying/nolang'));
  assert.deepEqual(parseNoml(read(dir, 'latest.noml')), ['glossary:v0.4.28@github.com/lizongying/nolang']);
});

test('version 缺省：回落到仓库版本（真实上游的常见形态）', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'notools',\n]\n`);

  const noVersion = `{
  name: 'nojq'
  license: 'MIT'
  compiler: { version: 'v0.4.27' }
}
`;
  const files = {
    'github.com/lizongying/notools|/workspace.noml': `{
  nojq: '/nojq'
}
`,
    'github.com/lizongying/notools|/nojq/package.noml': noVersion,
  };
  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(files), lsRemote });

  assert.equal(report.errors, 0);
  assert.equal(report.partial, 0);
  assert.equal(report.repos[0].status, 'ok');
  assert.equal(report.repos[0].packages[0].version, 'v0.4.28');
  assert.ok(exists(dir, 'packages/nojq/github.com/lizongying/notools/v0.4.28/package.noml'));
  // 快照仍是上游原文，不改写
  assert.equal(read(dir, 'packages/nojq/github.com/lizongying/notools/v0.4.28/package.noml'), noVersion);
});

test('所有包都不合法：整仓标记失败且不写快照', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const files = {
    ...baseFiles,
    'github.com/lizongying/nolang|/glossary/package.noml': '[]\n',
    'github.com/lizongying/nolang|/noui/package.noml': GLOSSARY,
  };
  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(files), lsRemote });

  assert.equal(report.errors, 1);
  assert.equal(report.repos[0].status, 'error');
  assert.match(report.repos[0].error, /全部跳过/);
  assert.ok(!exists(dir, 'packages/glossary/github.com/lizongying/nolang'));
  assert.ok(!exists(dir, 'packages/noui/github.com/lizongying/nolang'));
});

test('单包仓库：workspace.noml 缺失时回退根 package.noml', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'solo',\n]\n`);

  const files = {
    'github.com/lizongying/solo|/package.noml': `{
  name: 'solo'
  version: '1.0.0'
  license: 'MIT'
}
`,
  };
  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(files), lsRemote });

  assert.equal(report.errors, 0);
  assert.deepEqual(report.repos[0].packages, [{ name: 'solo', path: '/', version: '1.0.0' }]);
  assert.ok(exists(dir, 'packages/solo/github.com/lizongying/solo/v0.4.28/package.noml'));
  assert.ok(!exists(dir, 'workspaces/github.com/lizongying/solo'));
  assert.deepEqual(parseNoml(read(dir, 'latest.noml')), ['solo:v0.4.28@github.com/lizongying/solo']);
});

test('status: paused 的仓库被跳过', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[
  {
    name: 'nolang'
    status: 'paused'
  },
]\n`);

  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(baseFiles), lsRemote });

  assert.equal(report.repos[0].status, 'skipped');
  assert.equal(report.errors, 0);
  assert.ok(!exists(dir, 'packages'));
});

test('部分同步（filter）：只处理指定仓库，不清理其它仓库', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n  'notools',\n]\n`);

  const files = {
    ...baseFiles,
    'github.com/lizongying/notools|/workspace.noml': `{ notool: '/notool' }\n`,
    'github.com/lizongying/notools|/notool/package.noml': `{
  name: 'notool'
  version: '0.1.0'
  license: 'MIT'
}
`,
  };

  await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(files), lsRemote });
  assert.ok(exists(dir, 'packages/notool/github.com/lizongying/notools/v0.4.28/package.noml'));

  // 上游 notools 消失，但只同步 nolang：不应清理 notools 快照
  const report = await sync({
    root: dir,
    now: NOW,
    filter: 'github.com/lizongying/nolang',
    fetchRepoFile: fakeFetcher(baseFiles),
    lsRemote,
  });

  assert.equal(report.repos.length, 1);
  assert.equal(report.repos[0].repo, 'nolang');
  assert.equal(report.repos[0].status, 'ok');
  assert.equal(report.removed.length, 0);
  assert.ok(exists(dir, 'packages/notool/github.com/lizongying/notools/v0.4.28/package.noml'));
  assert.deepEqual(
    parseNoml(read(dir, 'latest.noml')),
    [
      'glossary:v0.4.28@github.com/lizongying/nolang',
      'noui:v0.4.28@github.com/lizongying/nolang',
      'notool:v0.4.28@github.com/lizongying/notools',
    ],
  );
});

test('tag 无法解析：告警但不阻断', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  // version 带 v 前缀，配上 tag_pattern 'v{version}' 会得到不存在的 vv0.1.0
  const files = {
    ...baseFiles,
    'github.com/lizongying/nolang|/glossary/package.noml': GLOSSARY.replace('version: \'0.1.0\'', 'version: \'v0.1.0\''),
  };
  const report = await sync({ root: dir, now: NOW, fetchRepoFile: fakeFetcher(files), lsRemote });

  assert.equal(report.errors, 0);
  // 两个版本各告警一次
  assert.equal(report.warnings, 2);
  assert.match(report.repos[0].warnings[0], /tag "vv0\.1\.0" 在仓库中不存在/);
  assert.ok(exists(dir, 'packages/glossary/github.com/lizongying/nolang/v0.4.28/package.noml'));
});

test('dry-run：不写任何文件', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const report = await sync({
    root: dir,
    now: NOW,
    dryRun: true,
    fetchRepoFile: fakeFetcher(baseFiles),
    lsRemote,
  });

  assert.equal(report.errors, 0);
  assert.equal(report.latest.changed, true);
  assert.ok(!exists(dir, 'packages'));
  assert.ok(!exists(dir, 'workspaces'));
  assert.ok(!exists(dir, 'latest.noml'));
  assert.ok(!exists(dir, 'state'));
});

test('无 tag 仓库：退化为分支 HEAD 短 SHA', async (t) => {
  const dir = makeRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeAuthors(dir, `[\n  'nolang',\n]\n`);

  const refs = new Map([
    ['HEAD', SHA_B],
    ['refs/heads/main', SHA_B],
  ]);
  const report = await sync({
    root: dir,
    now: NOW,
    lsRemote: async () => ({ refs, defaultBranch: 'main' }),
    fetchRepoFile: fakeFetcher(baseFiles),
  });

  assert.equal(report.repos[0].version, SHA_B.slice(0, 7));
  assert.ok(exists(dir, `packages/glossary/github.com/lizongying/nolang/${SHA_B.slice(0, 7)}/package.noml`));
});
