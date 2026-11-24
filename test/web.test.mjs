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
  assert.match(app, /function openGroup\(group, targetVersion\)/, 'app.js 应在点击卡片时延迟加载详情并支持指定版本');
  assert.match(app, /fetchText\(base \+ 'latest\.noml'\)/, '延迟加载应请求包级 latest.noml 版本索引');
  assert.match(app, /fetchText\(base \+ defaultVersion \+ '\/package\.noml'\)/, '延迟加载应请求默认版本 package.noml');
  assert.match(app, /fetchText\(rec\.snapshot\)/, 'app.js 应在切换版本时按需 fetch package.noml');
  assert.match(app, /t\('pkgUnit', \{ n: GROUP_LIST\.length \}\)/, '顶部统计应按包分组计数（走 i18n 复数文案）');
  assert.match(app, /NOML\.parse/, 'app.js 应调用 NOML.parse 解析 noml');
  assert.match(html, /<script src="noml\.js"><\/script>/, 'index.html 应引入 noml.js');
  assert.match(html, /<script src="i18n\.js"><\/script>/, 'index.html 应引入 i18n.js');
  assert.match(app, /var DEFAULT_LANG = 'zh-TW';/, '默认语言应为繁体中文');
  assert.match(html, /<html lang="zh-TW">/, 'index.html 默认 html lang 应为 zh-TW');
  assert.match(html, /<option value="zh-TW" selected>/, '下拉框默认选中繁体中文');
  assert.doesNotMatch(html, /<script src="data\.js"><\/script>/, 'index.html 不应静态引入 data.js');
  assert.match(app, /dataScript\.src = 'data\.js'/, 'data.js 应仅在本地预览时动态注入');
});

/** 最小 DOM stub，在 vm 里跑通 app.js 的完整启动链路 */
async function runApp({ search, local, index }) {
  const src = fs.readFileSync(path.join(ROOT, 'web/app.js'), 'utf8');
  const els = new Map();
  const el = (key) => {
    if (!els.has(key)) {
      els.set(key, {
        innerHTML: '', textContent: '', hidden: false, listeners: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener(type, fn) { this.listeners[type] = fn; },
        querySelector() { return null; },
        focus() {}, appendChild() {}, getAttribute() { return ''; },
      });
    }
    return els.get(key);
  };
  const historyCalls = [];
  const href = (local ? 'http://localhost:8000/' : 'https://example.com/nohub/') + search;
  const sandbox = {
    console, setTimeout, clearTimeout, URL, URLSearchParams, Promise,
    location: {
      href, search, hash: '',
      hostname: local ? 'localhost' : 'example.com',
      protocol: local ? 'http:' : 'https:',
      pathname: local ? '/' : '/nohub/',
    },
    history: { replaceState(_a, _b, url) { historyCalls.push(url); } },
    matchMedia: () => ({ matches: false }),
    document: {
      querySelector: (sel) => el('q' + sel),
      getElementById: (id) => el('#' + id),
      createElement: () => el('created'),
      head: { appendChild() {} },
      body: { appendChild() {} },
      execCommand() { return true; },
    },
    fetch: (url) => {
      const rel = String(url).replace(/^\.\//, '');
      let file = path.join(ROOT, rel);
      if (!fs.existsSync(file)) file = path.join(ROOT, 'web', rel);
      if (!fs.existsSync(file)) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      }
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(fs.readFileSync(file, 'utf8')),
      });
    },
  };
  sandbox.window = sandbox;
  if (local) sandbox.NOHUB_INDEX = index;
  vm.createContext(sandbox);
  // i18n.js 在浏览器里总是先于 app.js 加载，测试沙箱同样如此
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/i18n.js'), 'utf8'), sandbox);
  if (!local) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/noml.js'), 'utf8'), sandbox);
  }
  vm.runInContext(src, sandbox);
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  return {
    detail: el('q#detailPane').innerHTML,
    historyCalls,
    listeners: el('q#results').listeners,
    detailListeners: el('q#detailPane').listeners,
    // 语言切换测试用：直接读元素当前渲染结果
    langSelect: el('q#langSelect'),
    headerStats: el('q#headerStats'),
    resultsMeta: el('q#resultsMeta'),
    chips: el('q#chips'),
  };
}

function localIndex() {
  const mk = (repoVersion) => ({
    name: 'glossary', version: repoVersion, description: 'glossary', keywords: [], category: '',
    license: 'Apache-2.0', author: '', email: '', repository: 'https://github.com/lizongying/nolang',
    publish: true, compiler: {}, dependencies: [], devDependencies: [],
    host: 'github.com', owner: 'lizongying', repo: 'nolang',
    repoKey: 'github.com/lizongying/nolang', repoVersion, tag: repoVersion,
    docsUrl: '', snapshotPath: '', latestCommit: '',
  });
  return {
    generatedAt: '2026-01-01T00:00:00.000Z', source: 'test', count: 2,
    packages: [mk('v0.4.27'), mk('v0.4.28')],
  };
}

test('?package= 深链：本地预览直达指定版本并写回地址栏', async () => {
  const { detail, historyCalls } = await runApp({
    local: true,
    index: localIndex(),
    search: '?package=glossary:v0.4.27@github.com/lizongying/nolang',
  });
  assert.match(detail, /class="detail-name">glossary</, '应直接打开目标包详情');
  assert.match(detail, /class="ver-chip active" type="button" data-ver="v0.4.27"/, '应选中指定版本');
  assert.ok(
    historyCalls.some((u) =>
      decodeURIComponent(u).includes('package=glossary:v0.4.27@github.com/lizongying/nolang')),
    '地址栏应同步为当前包引用',
  );
});

test('?package= 深链：gh-pages 懒加载历史版本（缺省版本取最新）', async () => {
  const pkgLatest = parseNoml(
    fs.readFileSync(path.join(ROOT, 'packages/glossary/github.com/lizongying/nolang/latest.noml'), 'utf8'),
  );
  const newest = pkgLatest.version;
  const activeChip = `class="ver-chip active" type="button" data-ver="${newest}"`;

  const older = await runApp({
    local: false,
    search: '?package=glossary:v0.4.27@github.com/lizongying/nolang',
  });
  assert.match(older.detail, /class="detail-name">glossary</, '应打开目标包详情');
  assert.match(older.detail, /class="ver-chip active" type="button" data-ver="v0.4.27"/, '应加载历史版本快照');
  assert.ok(
    older.historyCalls.some((u) => decodeURIComponent(u).includes('package=glossary:v0.4.27@')),
    'gh-pages 深链加载完成后应写回地址栏',
  );

  const latest = await runApp({
    local: false,
    search: '?package=glossary@github.com/lizongying/nolang',
  });
  assert.match(latest.detail, /class="detail-name">glossary</, '省略版本时应打开包');
  assert.ok(latest.detail.includes(activeChip), '省略版本应取最新');

  const alias = await runApp({
    local: false,
    search: '?package=glossary:latest@github.com/lizongying/nolang',
  });
  assert.ok(alias.detail.includes(activeChip), 'latest 应取最新');
});

test('?package= 深链：:latest 指向最新版本并保留 latest 写法', async () => {
  const res = await runApp({
    local: true,
    index: localIndex(),
    search: '?package=glossary:latest@github.com/lizongying/nolang',
  });
  assert.match(res.detail, /class="detail-name">glossary</, '应打开目标包详情');
  assert.match(res.detail, /class="ver-chip active" type="button" data-ver="v0.4.28"/, 'latest 应取最新版本');
  assert.ok(
    res.historyCalls.some((u) =>
      decodeURIComponent(u).includes('package=glossary:latest@github.com/lizongying/nolang')),
    '地址栏应保留 latest 写法',
  );
});

test('访问具体包：点击列表项与切换版本都会改写地址栏', async () => {
  const res = await runApp({ local: true, index: localIndex(), search: '' });
  assert.equal(res.historyCalls.length, 0, '初始不应有 package 参数');

  // 点击结果卡片（glossary 默认最新版本 v0.4.28）
  res.listeners.click({
    target: { closest: (sel) => sel === '.pkg' ? { getAttribute: () => '0' } : null },
  });
  assert.ok(
    res.historyCalls.some((u) => decodeURIComponent(u).includes('package=glossary:v0.4.28@')),
    '点击列表项应写入地址栏',
  );

  // 切换到历史版本 v0.4.27
  res.detailListeners.click({
    target: { closest: (sel) => sel === '.ver-chip' ? { getAttribute: () => 'v0.4.27' } : null },
  });
  assert.ok(
    res.historyCalls.some((u) => decodeURIComponent(u).includes('package=glossary:v0.4.27@')),
    '切换版本应更新地址栏',
  );
});

test('gh-pages 点击列表项立即改写地址栏，不等详情异步加载', async () => {
  const res = await runApp({ local: false, search: '' });
  res.listeners.click({
    target: { closest: (sel) => sel === '.pkg' ? { getAttribute: () => '0' } : null },
  });
  assert.ok(
    res.historyCalls.some((u) => decodeURIComponent(u).includes('package=glossary:')),
    '点击后同步写入地址栏，无需等待 fetch 完成',
  );
});

test('?package= 深链：latest 别名不会串到其他包', async () => {
  const base = localIndex().packages[0];
  const mk = (name, repoVersion) => ({ ...base, name, version: repoVersion, repoVersion });
  const index = {
    generatedAt: base.version, source: 'test', count: 3,
    packages: [mk('glossary', 'v0.4.27'), mk('glossary', 'v0.4.28'), mk('test1', 'v0.4.28')],
  };
  const res = await runApp({
    local: true, index,
    search: '?package=glossary:latest@github.com/lizongying/nolang',
  });
  // 模拟点击结果列表中的另一张卡片（按包名排序：glossary=0, test1=1）
  res.listeners.click({
    target: {
      closest: (sel) => sel === '.pkg'
        ? { getAttribute: (k) => (k === 'data-idx' ? '1' : '') }
        : null,
    },
  });
  assert.ok(
    res.historyCalls.some((u) => decodeURIComponent(u).includes('package=test1:v0.4.28@')),
    '切换到其他包应写具体版本',
  );
  assert.ok(
    !res.historyCalls.some((u) => decodeURIComponent(u).includes('package=test1:latest@')),
    'latest 别名不应串到其他包',
  );
});

test('?package= 深链：非法引用不打开详情并清除地址栏参数', async () => {
  for (const ref of ['not-a-ref', 'unknown:v0.4.28@github.com/lizongying/nolang']) {
    const { detail, historyCalls } = await runApp({
      local: true, index: localIndex(), search: '?package=' + ref,
    });
    assert.match(detail, /detail-empty/, `非法引用应保持空详情：${ref}`);
    assert.ok(historyCalls.length > 0, `非法引用应改写地址栏：${ref}`);
    assert.ok(
      historyCalls.every((u) => !new URL('https://x' + u).searchParams.has('package')),
      `非法引用应清除 package 参数：${ref}`,
    );
  }
});

test('gh-pages 工作流发布根级 noml 数据', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/sync.yml'), 'utf8');
  assert.match(yml, /noml\.js/, 'gh-pages 应发布 web/noml.js');
  assert.match(yml, /web\/index\.noml" > index\.noml/, 'gh-pages 应发布根级 index.noml');
  assert.match(yml, /latest\.noml" > latest\.noml/, 'gh-pages 应发布根级 latest.noml');
  assert.match(yml, /git archive "\$SRC" packages workspaces \| tar -x/, 'gh-pages 应解包 packages 与 workspaces 到根级');
  assert.match(yml, /git add[^\n]*web\/noml\.js/, '回写快照应把 web/noml.js 一并提交');
  assert.match(yml, /for f in index\.html app\.js styles\.css noml\.js i18n\.js;/, 'gh-pages 应发布 web/i18n.js');
  assert.match(yml, /paths: \[[^\]]*web\/i18n\.js/, 'i18n.js 变更应触发同步');
});

test('web/i18n.js 十种语言齐全且键与简中一致', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/i18n.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const i18n = sandbox.NOHUB_I18N;
  assert.ok(i18n, 'i18n.js 应暴露 window.NOHUB_I18N');
  const langs = ['zh-CN', 'zh-TW', 'ja', 'ko', 'en', 'fr', 'ru', 'de', 'es', 'pt-BR'];
  // 跨 realm 数组原型不同，用 JSON 归一化后比较
  assert.deepEqual(JSON.parse(JSON.stringify(i18n.languages)), langs, '应支持十种语言');
  for (const lang of langs) {
    assert.ok(i18n.labels[lang], `${lang} 应有下拉框自称`);
    assert.ok(i18n.htmlLang[lang], `${lang} 应有 html lang 映射`);
    assert.ok(i18n.strings[lang] && typeof i18n.strings[lang] === 'object', `${lang} 应有文案表`);
  }
  const baseKeys = Object.keys(i18n.strings['zh-CN']).sort();
  assert.ok(baseKeys.length >= 50, '简中文案应覆盖界面全部键');
  for (const lang of langs) {
    assert.deepEqual(
      Object.keys(i18n.strings[lang]).sort(),
      baseKeys,
      `${lang} 的键应与简中完全一致`,
    );
    for (const k of baseKeys) {
      const v = i18n.strings[lang][k];
      if (typeof v === 'string') assert.ok(v.trim(), `${lang}.${k} 不应为空串`);
    }
  }
});

test('语言切换：重渲染统计、chips 与结果计数', async () => {
  // 5 个包分组：验证 en 复数 packages 与 ru 复数 пакетов（n=5 → many）
  const base = localIndex().packages[0];
  const index = {
    generatedAt: base.version, source: 'test', count: 5,
    packages: ['glossary', 'alpha', 'beta', 'gamma', 'delta'].map((name) => ({ ...base, name })),
  };
  const res = await runApp({ local: true, index, search: '' });
  assert.match(res.headerStats.innerHTML, /個套件/, '默认应为繁体中文');
  assert.match(res.resultsMeta.innerHTML, /共 <b>5<\/b> 個套件/, '默认繁中结果统计');

  const setLang = (code) => {
    res.langSelect.value = code;
    res.langSelect.listeners.change();
  };

  setLang('en');
  assert.match(res.headerStats.innerHTML, />5<\/b> packages</, '英文统计应为复数 packages');
  assert.match(res.chips.innerHTML, />All</, '英文「全部」chip 应为 All');
  assert.match(res.resultsMeta.innerHTML, /packages in total/, '英文结果统计应为复数');
  assert.equal(res.langSelect.value, 'en', '选择器应同步为当前语言');

  setLang('ja');
  assert.match(res.headerStats.innerHTML, /パッケージ/, '日文统计应为 パッケージ');
  assert.match(res.chips.innerHTML, />すべて</, '日文「全部」chip 应为 すべて');

  setLang('ru');
  assert.match(res.headerStats.innerHTML, /пакетов/, '俄文统计应为复数 пакетов');

  setLang('zh-CN');
  assert.match(res.headerStats.innerHTML, /个包/, '切回简中应恢复');
  assert.equal(res.langSelect.value, 'zh-CN', '选择器应同步为当前语言');
});
