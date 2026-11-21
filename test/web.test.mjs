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

test('web/index.noml 清单存在且与 packages/ 快照一一对应', () => {
  const manifestSrc = fs.readFileSync(path.join(ROOT, 'web/index.noml'), 'utf8');
  const manifest = parseNoml(manifestSrc);
  assert.ok(Array.isArray(manifest.snapshots), '清单应含 snapshots 数组');

  const onDisk = [];
  const pkgRoot = path.join(ROOT, 'packages');
  for (const pkg of fs.readdirSync(pkgRoot)) {
    const hostDir = path.join(pkgRoot, pkg);
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
          for (const ver of fs.readdirSync(repoPath)) {
            const snap = path.join(repoPath, ver, 'package.noml');
            if (fs.existsSync(snap)) {
              onDisk.push(path.relative(ROOT, snap).split(path.sep).join('/'));
            }
          }
        }
      }
    }
  }

  const listed = manifest.snapshots.map((s) => s.snapshot);
  assert.equal(listed.length, onDisk.length, '清单快照数与 packages/ 快照数不一致');
  assert.deepEqual([...listed].sort(), [...onDisk].sort(), '清单 snapshot 与 packages/ 快照不一致');

  // 每份快照都能被浏览器解析器读通，且 latest.noml 存在
  const browser = loadBrowserParser();
  for (const rel of listed) {
    const doc = browser.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.equal(doc.name, rel.split('/')[1], `${rel} 的 name 应为 ${rel.split('/')[1]}`);
  }
  for (const s of manifest.snapshots) {
    assert.ok(fs.existsSync(path.join(ROOT, s.latest)), `${s.latest} 应存在`);
  }

  // 包级 latest.noml 必须是带 versions 索引的对象：version/commit 指向最新，
  // versions 升序覆盖该包全部有快照的版本（前端据此懒加载历史版本）
  const latestFiles = new Set(manifest.snapshots.map((s) => s.latest));
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
  }
});

test('web/app.js 走 fetch + noml 解析路径（默认只加载最新版本）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  assert.match(app, /fetchText\('latest\.noml'\)/, 'app.js 应 fetch 根级 latest.noml');
  assert.match(app, /fetchText\('index\.noml'\)/, 'app.js 应 fetch 根级 index.noml（生成时间等）');
  assert.match(app, /fetchText\(item\.latestPath\)/, 'app.js 应按包 fetch latest.noml 版本索引');
  assert.match(app, /latest\.versions/, 'app.js 应使用 latest.noml 的 versions 索引');
  assert.match(app, /fetchText\(item\.snapshot\)/, 'app.js 应只加载默认版本的 package.noml');
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
