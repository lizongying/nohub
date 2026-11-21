import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseNoml } from '../lib/noml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 在干净的 global 上加载 web/noml.js，拿到 window.NOML。 */
function loadBrowserParser() {
  const src = fs.readFileSync(path.join(ROOT, 'web/noml.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.ok(sandbox.NOML && typeof sandbox.NOML.parse === 'function', 'web/noml.js 应暴露 NOML.parse');
  return sandbox.NOML;
}

test('web/noml.js 解析结果与 lib/noml.mjs 一致', () => {
  const browser = loadBrowserParser();
  const samples = [
    `{
  a: 'x\\'y\\\\z\\n\\t\\r'
  b: nil
  c: -1.5e3
  d: [1, 2.5, true, false, nil,]
  e: { f: 'g' }
  ; 行注释
  g: 'h' ; 尾随注释
  #{注解}
  i: 'j'
}`,
    `{}`,
    `[]`,
    `['name:version@host/owner/repo'\n'name:version2@host/owner/repo']`,
  ];
  for (const src of samples) {
    // 浏览器解析器跑在独立 vm 上下文里，跨 realm 对象用 JSON 归一化后比较
    assert.equal(
      JSON.stringify(browser.parse(src)),
      JSON.stringify(parseNoml(src)),
      `解析不一致：${src.slice(0, 40)}`,
    );
  }
});

test('web/noml.js 对 examples/ 清单与快照同样可解析', () => {
  const browser = loadBrowserParser();
  for (const rel of ['examples/workspace.noml', 'examples/package.noml', 'examples/latest.noml']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(
      JSON.stringify(browser.parse(src)),
      JSON.stringify(parseNoml(src)),
      `${rel} 解析不一致`,
    );
  }
});

/** 语义化版本比较（容忍 v 前缀），返回较大者 */
function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return String(a).localeCompare(String(b));
}

function maxVersion(list) {
  return list.slice().sort(cmpVersions).pop();
}

/** 扫描 packages/：每包（name@host/owner/repo）的最新仓库版本，以及全部 latest.noml */
function scanPackages() {
  const latestByPkg = new Map();
  const latestFiles = new Set();
  const pkgRoot = path.join(ROOT, 'packages');
  for (const name of fs.readdirSync(pkgRoot)) {
    const hostDir = path.join(pkgRoot, name);
    if (!fs.statSync(hostDir).isDirectory()) continue;
    for (const host of fs.readdirSync(hostDir)) {
      const ownerDir = path.join(hostDir, host);
      if (!fs.statSync(ownerDir).isDirectory()) continue;
      for (const owner of fs.readdirSync(ownerDir)) {
        const repoDir = path.join(ownerDir, owner);
        if (!fs.statSync(repoDir).isDirectory()) continue;
        for (const repo of fs.readdirSync(repoDir)) {
          const repoPath = path.join(repoDir, repo);
          if (!fs.statSync(repoPath).isDirectory()) continue;
          const latestRel = path.relative(ROOT, path.join(repoPath, 'latest.noml')).split(path.sep).join('/');
          if (fs.existsSync(path.join(repoPath, 'latest.noml'))) latestFiles.add(latestRel);
          const versions = fs.readdirSync(repoPath)
            .filter((v) => fs.existsSync(path.join(repoPath, v, 'package.noml')));
          if (!versions.length) continue;
          latestByPkg.set(`${name}@${host}/${owner}/${repo}`, {
            name, host, owner, repo, latest: maxVersion(versions),
          });
        }
      }
    }
  }
  return { latestByPkg, latestFiles };
}

test('web/index.noml 每包一条最新版本，只带首页列表所需字段', () => {
  const manifestSrc = fs.readFileSync(path.join(ROOT, 'web/index.noml'), 'utf8');
  const manifest = parseNoml(manifestSrc);
  assert.ok(Array.isArray(manifest.packages), '清单应含 packages 数组');

  const { latestByPkg, latestFiles } = scanPackages();
  assert.equal(manifest.packages.length, latestByPkg.size, '清单条目数应与包数一致');

  for (const entry of manifest.packages) {
    const key = `${entry.name}@${entry.repo}`;
    const expected = latestByPkg.get(key);
    assert.ok(expected, `清单条目应对应存在的包：${key}`);
    // 仓库定位信息合成单个 repo 字段（host/owner/repo）
    assert.equal(typeof entry.repo, 'string', `${key} 应有 repo 字段`);
    assert.ok(entry.repo.split('/').length === 3, `${key} 的 repo 应为 host/owner/repo`);
    assert.equal('host' in entry, false, `${key} 不应再有 host 字段`);
    assert.equal('owner' in entry, false, `${key} 不应再有 owner 字段`);
    assert.equal(typeof entry.tag, 'string', `${key} 应有正确 tag`);
    assert.ok(entry.tag, `${key} 的 tag 不应为空`);
    // version 即仓库版本（repo_version），不再单列 repo_version
    assert.equal(entry.version, expected.latest, `${key} 的 version 应为最新仓库版本`);
    assert.equal('repo_version' in entry, false, `${key} 不应再有 repo_version 字段`);
    assert.equal('snapshot' in entry, false, `${key} 不应再带 snapshot 字段`);
    assert.ok(
      fs.existsSync(path.join(ROOT, 'packages', entry.name, ...entry.repo.split('/'), entry.version, 'package.noml')),
      `${key} 的 version 应指向存在的快照`,
    );
    for (const field of ['description', 'category', 'license', 'author', 'email', 'repository']) {
      assert.equal(typeof entry[field], 'string', `${key} 应有 ${field}`);
    }
    assert.ok(Array.isArray(entry.keywords), `${key} 应有 keywords 数组`);
    assert.equal(typeof entry.publish, 'boolean', `${key} 应有 publish 布尔值`);
  }

  // 包级 latest.noml 必须是带 versions 索引的对象：version/commit 指向最新，
  // versions 升序覆盖该包全部有快照的版本（前端据此懒加载历史版本）
  const browser = loadBrowserParser();
  for (const rel of latestFiles) {
    const latest = parseNoml(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.equal(typeof latest.version, 'string', `${rel} 应有 version`);
    assert.equal(typeof latest.commit, 'string', `${rel} 应有 commit`);
    assert.ok(Array.isArray(latest.versions) && latest.versions.length > 0, `${rel} 应有非空 versions`);
    for (const v of latest.versions) {
      assert.equal(typeof v.version, 'string', `${rel} 的 versions 项应有 version`);
      assert.equal(typeof v.commit, 'string', `${rel} 的 versions 项应有 commit`);
      assert.ok(
        fs.existsSync(path.join(ROOT, 'packages', rel.split('/')[1], ...rel.split('/').slice(2, -1), v.version, 'package.noml')),
        `${rel} 的 versions 应指向存在的快照：${v.version}`,
      );
    }
    assert.equal(latest.versions[latest.versions.length - 1].version, latest.version, `${rel} 最新版本应等于 version`);
    // versions 应升序
    const seq = latest.versions.map((v) => v.version);
    assert.deepEqual(seq, [...seq].sort(cmpVersions), `${rel} 的 versions 应升序`);
  }

  // 每份 latest.noml 对应包的最新版本快照应能被浏览器解析器读通
  for (const entry of manifest.packages) {
    const snap = path.join(ROOT, 'packages', entry.name, ...entry.repo.split('/'), entry.version, 'package.noml');
    const doc = browser.parse(fs.readFileSync(snap, 'utf8'));
    assert.equal(doc.name, entry.name, `${entry.name} 快照的 name 应一致`);
  }
});

test('web/app.js 走 fetch + noml 解析路径（首屏只加载 index.noml，详情延迟请求）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  assert.match(app, /fetchText\('index\.noml'\)/, 'app.js 应 fetch 根级 index.noml');
  assert.doesNotMatch(app, /fetchText\('latest\.noml'\)/, '首屏不应请求根级 latest.noml');
  assert.match(app, /function recordFromIndexEntry/, 'app.js 应把 index.noml 条目转成列表记录');
  assert.match(app, /entry\.repo/, 'app.js 应从单个 repo 字段拆出 host/owner/repo');
  assert.match(app, /listOnly/, 'app.js 应标记只带列表字段的条目');
  assert.match(app, /function openGroup\(group\)/, 'app.js 应在点击卡片时延迟加载详情');
  assert.match(app, /fetchText\(base \+ 'latest\.noml'\)/, '延迟加载应请求包级 latest.noml 版本索引');
  assert.match(app, /fetchText\(base \+ defaultVersion \+ '\/package\.noml'\)/, '延迟加载应请求默认版本 package.noml');
  assert.match(app, /fetchText\(rec\.snapshot\)/, 'app.js 应在切换版本时按需 fetch package.noml');
  assert.match(app, /GROUP_LIST\.length \+ '<\/b> 个包/, '顶部统计应按包分组计数');
  assert.match(app, /NOML\.parse/, 'app.js 应调用 NOML.parse 解析 noml');
  assert.match(html, /<script src="noml\.js"><\/script>/, 'index.html 应引入 noml.js');
  assert.match(html, /<script src="data\.js"><\/script>/, 'index.html 应保留 data.js（本地预览）');
});

test('gh-pages 工作流发布根级 noml 数据', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/sync.yml'), 'utf8');
  assert.match(yml, /noml\.js/, 'gh-pages 应发布 web/noml.js');
  assert.match(yml, /web\/index\.noml" > index\.noml/, 'gh-pages 应发布根级 index.noml');
  assert.match(yml, /latest\.noml" > latest\.noml/, 'gh-pages 应发布根级 latest.noml');
  assert.match(yml, /git archive "\$SRC" packages workspaces \| tar -x/, 'gh-pages 应解包 packages 与 workspaces 到根级');
  assert.match(yml, /git add[^\n]*web\/noml\.js/, '回写快照应把 web/noml.js 一并提交');
});
