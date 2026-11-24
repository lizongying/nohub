/* ============================================================
 nohub 搜索页交互逻辑
 数据来源：
   - 本地预览：data.js（由 web/build.mjs 从 packages/ 快照预编译，含全部版本）
   - gh-pages：fetch 根级 index.noml（每包一条最新版本，只带首页列表所需字段）
              → 直接渲染列表；点击卡片时才延迟请求该包的 latest.noml
               （versions 版本索引，用于版本切换）与默认版本 package.noml（详情），
               切换历史版本时再按需 fetch 对应快照，全程用 noml.js 解析原始 noml 数据
 说明：package.noml 的 version 字段与 release 相关，页面不展示；
        版本以快照目录的仓库版本（repoVersion）为准，可切换。
 ============================================================ */
(function () {
  'use strict';

  var INDEX = window.NOHUB_INDEX || null;
  var PKGS = INDEX ? INDEX.packages || [] : [];
  var I18N = window.NOHUB_I18N || { languages: ['zh-CN'], labels: {}, htmlLang: {}, strings: {} };

  // no 运行时一键安装命令（尚未安装 no 时先执行）
  var NO_INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/lizongying/nolang/main/install.sh | sh';

  // ---------- 多语言 / 分类哨兵 ----------
  var DEFAULT_LANG = 'zh-TW';
  var CAT_ALL = '*all*'; // 「全部」分类（UI 文案随语言切换，内部用哨兵值）
  var CAT_NONE = '*none*'; // 未分类占位（数据缺失 category 时）

  var LOCALES = {
    'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR',
    en: 'en-US', fr: 'fr-FR', ru: 'ru-RU', de: 'de-DE', es: 'es-ES', 'pt-BR': 'pt-BR',
  };

  // ---------- 按包分组（同名同仓库的多个版本快照归为一组） ----------
  var GROUPS = {};
  var GROUP_LIST = [];

  function repoKeyOf(p) {
    return p.repoKey || (p.host + '/' + p.owner + '/' + p.repo);
  }

  function buildGroups() {
    GROUPS = {};
    PKGS.forEach(function (p) {
      var repoKey = repoKeyOf(p);
      var k = p.name + '@' + repoKey;
      if (!GROUPS[k]) {
        GROUPS[k] = {
          key: k, repoKey: repoKey, name: p.name,
          versions: [], records: {},
          // gh-pages 的首页条目只带列表字段，详情需延迟加载
          loaded: !p.listOnly, loading: false,
        };
      }
      GROUPS[k].records[p.repoVersion] = p;
    });

    Object.keys(GROUPS).forEach(function (k) {
      var group = GROUPS[k];
      group.versions = Object.keys(group.records).map(function (v) { return group.records[v]; })
        .sort(function (a, b) { return compareVersions(b.repoVersion, a.repoVersion); });
      group.defaultVersion = group.versions[0] ? group.versions[0].repoVersion : null;
      group.default = (group.defaultVersion && group.records[group.defaultVersion]) || null;
    });

    GROUP_LIST = Object.keys(GROUPS).map(function (k) { return GROUPS[k]; })
      .sort(function (a, b) {
        var byName = a.name.localeCompare(b.name);
        return byName !== 0 ? byName : a.repoKey.localeCompare(b.repoKey);
      });
  }

  var state = {
    q: '',
    category: CAT_ALL,
    lang: DEFAULT_LANG,
    activeIdx: -1, // 键盘导航聚焦项
    selected: null, // 当前详情展示的版本记录
    groupKey: null, // 当前详情所属的包分组
    latestAliasKey: null, // 深链 ?package=...:latest@... 指定的包分组，地址栏保留 latest 写法
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var searchInput = $('#searchInput');
  var searchClear = $('#searchClear');
  var chipsEl = $('#chips');
  var resultsEl = $('#results');
  var resultsMeta = $('#resultsMeta');
  var emptyEl = $('#emptyState');
  var detailPane = $('#detailPane');
  var headerStats = $('#headerStats');
  var footerSource = $('#footerSource');
  var themeToggle = $('#themeToggle');
  var langSelect = $('#langSelect');

  // ---------- i18n ----------
  function knownLang(code) {
    return I18N.languages.indexOf(code) !== -1 ? code : null;
  }

  /** 把任意语言标签归一化到已支持的语言；不支持返回 null */
  function normalizeLang(code) {
    var c = String(code == null ? '' : code).trim();
    if (knownLang(c)) return c;
    var lower = c.toLowerCase();
    if (!lower) return null;
    if (lower.indexOf('zh') === 0) {
      // 繁：tw / hk / mo / hant；其余（cn / sg / hans）归简中
      return /(tw|hant|hk|mo)/.test(lower) ? knownLang('zh-TW') : knownLang('zh-CN');
    }
    var base = lower.split(/[-_]/)[0];
    for (var i = 0; i < I18N.languages.length; i++) {
      if (I18N.languages[i].split('-')[0] === base) return I18N.languages[i];
    }
    return null;
  }

  /** 按语言选复数形式键（CLDR 简化规则） */
  function pluralForm(lang, n) {
    var base = lang.split('-')[0];
    if (base === 'zh' || base === 'ja' || base === 'ko') return 'other';
    if (base === 'fr') return (n === 0 || n === 1) ? 'one' : 'other';
    if (base === 'ru') {
      var m10 = n % 10;
      var m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return 'one';
      if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'few';
      return 'many';
    }
    return n === 1 ? 'one' : 'other'; // en / de / es / pt
  }

  /** 取文案：t(key, vars)；缺失时回退简中，再缺失返回键名 */
  function t(key, vars) {
    var table = (I18N.strings && (I18N.strings[state.lang] || I18N.strings[DEFAULT_LANG])) || {};
    var s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    if (s == null && state.lang !== DEFAULT_LANG) {
      var fb = I18N.strings[DEFAULT_LANG] || {};
      s = Object.prototype.hasOwnProperty.call(fb, key) ? fb[key] : null;
    }
    if (s == null) return key;
    if (typeof s === 'object') {
      var n = vars && vars.n != null ? Number(vars.n) : 1;
      s = s[pluralForm(state.lang, n)] || s.other || '';
    }
    if (vars) {
      s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return vars[k] != null ? String(vars[k]) : m;
      });
    }
    return s;
  }

  function detectLang() {
    try {
      var saved = localStorage.getItem('nohub-lang');
      if (saved) {
        var hit = normalizeLang(saved);
        if (hit) return hit;
      }
    } catch (e) { /* file:// 等场景忽略 */ }
    if (typeof navigator !== 'undefined' && navigator.language) {
      var fromNav = normalizeLang(navigator.language);
      if (fromNav) return fromNav;
    }
    return DEFAULT_LANG;
  }

  /** 静态文案（index.html 里带 data-i18n* 属性的元素） */
  function applyStaticTexts() {
    if (!document.querySelectorAll) return;
    var i;
    var nodes = document.querySelectorAll('[data-i18n]');
    for (i = 0; i < nodes.length; i++) nodes[i].innerHTML = t(nodes[i].getAttribute('data-i18n'));
    nodes = document.querySelectorAll('[data-i18n-ph]');
    for (i = 0; i < nodes.length; i++) nodes[i].setAttribute('placeholder', t(nodes[i].getAttribute('data-i18n-ph')));
    nodes = document.querySelectorAll('[data-i18n-content]');
    for (i = 0; i < nodes.length; i++) nodes[i].setAttribute('content', t(nodes[i].getAttribute('data-i18n-content')));
    ['aria-label', 'title'].forEach(function (attr) {
      var list = document.querySelectorAll('[data-i18n-' + attr + ']');
      for (i = 0; i < list.length; i++) list[i].setAttribute(attr, t(list[i].getAttribute('data-i18n-' + attr)));
    });
  }

  /** 设置语言并整体重渲染；rerender=false 时只更新状态（启动阶段由 boot 统一渲染） */
  function applyLang(lang, rerender) {
    state.lang = normalizeLang(lang) || DEFAULT_LANG;
    if (document.documentElement) {
      document.documentElement.setAttribute('lang', (I18N.htmlLang && I18N.htmlLang[state.lang]) || state.lang);
    }
    try { localStorage.setItem('nohub-lang', state.lang); } catch (e) { /* file:// 等场景忽略 */ }
    if (rerender !== false) {
      applyStaticTexts();
      renderHeader();
      renderChips();
      renderResults();
      renderDetail();
      if (langSelect) langSelect.value = state.lang;
    }
  }

  // ---------- 工具 ----------
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function escapeReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(text, tokens) {
    var html = escapeHtml(text);
    tokens.forEach(function (tok) {
      if (!tok) return;
      html = html.replace(new RegExp(escapeReg(tok), 'gi'), function (m) {
        return '<mark>' + m + '</mark>';
      });
    });
    return html;
  }

  function isMobileDetail() {
    return window.matchMedia('(max-width: 960px)').matches;
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      return d.toLocaleString(LOCALES[state.lang] || 'zh-CN', { hour12: false });
    } catch (e) {
      return iso;
    }
  }

  /** 语义化版本比较（容忍 v 前缀与不同段数） */
  function compareVersions(a, b) {
    var pa = String(a).replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var pb = String(b).replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return String(a).localeCompare(String(b));
  }

  // ---------- 搜索匹配 ----------
  function tokensOf(q) {
    return q.toLowerCase().split(/\s+/).filter(Boolean);
  }

  // 单 token 命中记分：包名 > 关键词 > 描述/分类/作者/仓库等
  function scoreToken(pkg, tok) {
    var name = (pkg.name || '').toLowerCase();
    if (name === tok) return 100;
    if (name.indexOf(tok) === 0) return 60;
    if (name.indexOf(tok) !== -1) return 40;
    var kws = (pkg.keywords || []).map(function (k) { return k.toLowerCase(); });
    if (kws.some(function (k) { return k.indexOf(tok) !== -1; })) return 20;
    var hay = [
      pkg.description, pkg.category, pkg.author, pkg.email, pkg.license,
      pkg.host, pkg.owner, pkg.repo, pkg.repository,
    ].join(' ').toLowerCase();
    if (hay.indexOf(tok) !== -1) return 10;
    return 0;
  }

  // 返回匹配的仓库分组列表
  function filtered() {
    var tokens = tokensOf(state.q);
    var cat = state.category;
    var list = GROUP_LIST.filter(function (g) {
      var p = g.default;
      if (!p) return false;
      if (cat !== CAT_ALL && (p.category || CAT_NONE) !== cat) return false;
      if (tokens.length === 0) return true;
      var score = 0;
      for (var i = 0; i < tokens.length; i++) {
        var s = scoreToken(p, tokens[i]);
        if (s === 0) return false;
        score += s;
      }
      g.__score = score;
      return true;
    });
    if (tokens.length > 0) {
      list.sort(function (a, b) {
        return (b.__score - a.__score) || a.name.localeCompare(b.name);
      });
    }
    return list;
  }

  function categories() {
    var map = {};
    GROUP_LIST.forEach(function (g) {
      var c = (g.default && g.default.category) || CAT_NONE;
      map[c] = (map[c] || 0) + 1;
    });
    return Object.keys(map).sort(function (a, b) {
      if (a === CAT_NONE) return 1;
      if (b === CAT_NONE) return -1;
      return a.localeCompare(b);
    }).map(function (c) { return { name: c, count: map[c] }; });
  }

  /** 分类显示名：哨兵值翻译成「全部 / 未分类」，其余为数据里的原始分类名 */
  function catLabel(c) {
    if (c === CAT_ALL) return t('all');
    if (c === CAT_NONE) return t('uncategorized');
    return c;
  }

  // ---------- 渲染：头部统计 / 分类 ----------
  function renderHeader() {
    var repos = {};
    GROUP_LIST.forEach(function (g) { repos[g.repoKey] = true; });
    var repoCount = Object.keys(repos).length;
    headerStats.innerHTML =
      '<span class="stat-pill"><b>' + GROUP_LIST.length + '</b> ' + t('pkgUnit', { n: GROUP_LIST.length }) + '</span>' +
      '<span class="stat-pill"><b>' + repoCount + '</b> ' + t('repoUnit', { n: repoCount }) + '</span>';
    footerSource.textContent = t('footerGenAt') + fmtTime(INDEX.generatedAt);
  }

  function renderChips() {
    var cats = categories();
    var html = '<button class="chip' + (state.category === CAT_ALL ? ' active' : '') +
      '" data-cat="' + CAT_ALL + '" type="button">' + t('all') +
      '<span class="chip-count">' + GROUP_LIST.length + '</span></button>';
    cats.forEach(function (c) {
      html += '<button class="chip' + (state.category === c.name ? ' active' : '') +
        '" data-cat="' + escapeHtml(c.name) + '" type="button">' +
        escapeHtml(catLabel(c.name)) + '<span class="chip-count">' + c.count + '</span></button>';
    });
    chipsEl.innerHTML = html;
  }

  // ---------- 渲染：结果列表 ----------
  function renderResults() {
    var list = filtered();
    var tokens = tokensOf(state.q);

    if (list.length === 0) {
      resultsEl.innerHTML = '';
      emptyEl.hidden = false;
      resultsMeta.innerHTML = '';
      state.activeIdx = -1;
      return;
    }
    emptyEl.hidden = true;

    var total = GROUP_LIST.length;
    if (state.q || state.category !== CAT_ALL) {
      resultsMeta.innerHTML = t('foundOf', { n: list.length, total: total });
    } else {
      resultsMeta.innerHTML = t('totalPkg', { n: total });
    }

    resultsEl.innerHTML = list.map(function (g, i) {
      var p = g.default;
      if (!p) return '';
      var keywords = (p.keywords || []).slice(0, 5).map(function (k) {
        return '<span class="tag">' + highlight(k, tokens) + '</span>';
      }).join('');
      var badges = '<span class="badge">' + escapeHtml(p.repoVersion) + '</span>';
      if (!p.publish) badges += '<span class="badge gray">' + t('unpublished') + '</span>';
      if (p.category) badges += '<span class="badge green">' + escapeHtml(p.category) + '</span>';

      var verCount = g.versions.length;

      return '<button class="pkg' + (i === state.activeIdx ? ' active' : '') +
        '" type="button" data-idx="' + i + '">' +
        '<div class="pkg-head">' +
          '<span class="pkg-name">' + highlight(p.name, tokens) + '</span>' +
          badges +
        '</div>' +
        '<p class="pkg-desc">' + highlight(p.description || t('noDesc'), tokens) + '</p>' +
        (keywords ? '<div class="pkg-tags">' + keywords + '</div>' : '') +
        '<div class="pkg-meta">' +
          '<span>' + escapeHtml(p.host) + '/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '</span>' +
          (p.license ? '<span class="dot">' + escapeHtml(p.license) + '</span>' : '') +
          '<span class="dot">' + (p.publish ? t('published') : t('unpublished')) + '</span>' +
          (verCount > 1 ? '<span class="dot">' + t('versionCount', { n: verCount }) + '</span>' : '') +
        '</div>' +
      '</button>';
    }).join('');

    if (state.activeIdx >= list.length) state.activeIdx = list.length - 1;
  }

  // ---------- 渲染：详情面板 ----------
  function kvRow(label, valueHtml, mono) {
    return '<dt>' + escapeHtml(label) + '</dt><dd class="' + (mono ? 'mono ' : '') +
      (valueHtml ? '' : 'is-empty') + '">' + (valueHtml || '—') + '</dd>';
  }

  // 源码仓库地址：优先用构建期规范化过的 repoUrl，缺失时做运行时兜底
  function repoUrlOf(p) {
    if (p.repoUrl) return p.repoUrl;
    var s = String(p.repository || '').trim();
    var m = s.match(/^git@([^:\s]+):(.+)$/);
    if (m) return 'https://' + m[1] + '/' + m[2].replace(/\.git\/?$/i, '').replace(/\/+$/, '');
    m = s.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
    if (m) return 'https://' + m[1] + '/' + m[2].replace(/\.git\/?$/i, '').replace(/\/+$/, '');
    if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) {
      return 'https://' + s;
    }
    return s;
  }

  // 包引用：name:repoVersion@host/owner/repo（与根级 latest.noml 条目同格式）
  function pkgRef(p) {
    return p.name + ':' + p.repoVersion + '@' + p.host + '/' + p.owner + '/' + p.repo;
  }

  /** 解析包引用 name[:version]@host/owner/repo；version 缺省或 latest 时取最新 */
  function parsePackageRef(ref) {
    var m = /^([^:@\s]+)(?::([^@\s]+))?@([^\s]+)$/.exec(String(ref || '').trim());
    if (!m) return null;
    return { name: m[1], version: m[2] || '', repoKey: m[3] };
  }

  /** 把包引用写进地址栏；ref 为空则移除 package 参数（其余查询参数保留） */
  function setLocationRef(ref) {
    if (!window.history || !window.history.replaceState) return;
    try {
      var url = new URL(window.location.href);
      var params = new URLSearchParams(url.search);
      if (ref) params.set('package', ref);
      else params.delete('package');
      // package 值保留 name:version@host/owner/repo 的可读形式，其余参数正常转义
      var query = [];
      params.forEach(function (v, k) {
        query.push(encodeURIComponent(k) + '=' + (k === 'package' ? v : encodeURIComponent(v)));
      });
      url.search = query.length ? '?' + query.join('&') : '';
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {
      // file:// 等环境可能不允许 replaceState，忽略即可
    }
  }

  /** 把当前详情写回地址栏（方便复制分享），关闭详情时移除 */
  function syncLocation() {
    if (!state.selected) { setLocationRef(''); return; }
    var group = GROUPS[state.groupKey];
    var ref = pkgRef(state.selected);
    // 用 latest 打开且仍停留在最新版本时，保留 latest 写法
    if (state.latestAliasKey && state.latestAliasKey === state.groupKey &&
        group && state.selected === group.default) {
      ref = state.selected.name + ':latest@' + repoKeyOf(state.selected);
    }
    setLocationRef(ref);
  }

  /** 从分组里找指定版本的完整记录（gh-pages 历史版本可能尚未加载） */
  function findRecord(group, version) {
    if (!version || !group) return null;
    var v = group.versions.filter(function (x) { return x.repoVersion === version; })[0];
    var candidates = [v && v.entry, group.records[version], v];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && c.name && !c.listOnly && c.repoVersion === version) return c;
    }
    return null;
  }

  // 复制命令按钮（点击写入剪贴板）
  function copyBtn(cmd, label) {
    return '<button class="copy-btn" type="button" data-cmd="' + escapeHtml(cmd) + '">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
      escapeHtml(label) + '</button>';
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      }
      document.body.removeChild(ta);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // 剪贴板 API 不可用（如 file://、权限不足）时退回 execCommand
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function renderDetail() {
    var p = state.selected;
    if (!p) {
      detailPane.classList.remove('open');
      detailPane.innerHTML =
        '<div class="detail-empty">' +
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>' +
        '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>' +
        '</svg>' +
        '<div>' + t('emptyDetail') + '</div>' +
        '</div>';
      return;
    }

    var tokens = tokensOf(state.q);
    var compiler = p.compiler || {};
    var emptyDep = '<span style="color:var(--is-empty)">' + t('none') + '</span>';
    var deps = (p.dependencies || []).map(function (d) {
      return '<span class="dep">' + escapeHtml(d) + '</span>';
    }).join('') || emptyDep;
    var devDeps = (p.devDependencies || []).map(function (d) {
      return '<span class="dep">' + escapeHtml(d) + '</span>';
    }).join('') || emptyDep;

    var linkLibs = Array.isArray(compiler['link-libs']) && compiler['link-libs'].length
      ? compiler['link-libs'].map(escapeHtml).join(', ') : t('none');
    var keywords = (p.keywords || []).map(function (k) {
      return '<span class="tag">' + highlight(k, tokens) + '</span>';
    }).join('');

    // 快照对应的 release 地址（如 https://github.com/lizongying/nolang/releases/tag/v0.4.28）
    var releaseUrl = repoUrlOf(p) ? repoUrlOf(p) + '/releases/tag/' + p.repoVersion : '';

    // 版本列表（同一包的全部快照版本，可点击进入）
    var group = GROUPS[state.groupKey];
    var versions = group ? group.versions : [p];
    var verChips = versions.map(function (v) {
      var active = v.repoVersion === p.repoVersion;
      return '<button class="ver-chip' + (active ? ' active' : '') + '" type="button" data-ver="' +
        escapeHtml(v.repoVersion) + '">' + escapeHtml(v.repoVersion) + '</button>';
    }).join('');

    detailPane.innerHTML =
      '<div class="detail-card">' +
        '<div class="detail-head">' +
          '<div class="detail-title-row">' +
            '<h2 class="detail-name">' + highlight(p.name, tokens) + '</h2>' +
            '<button class="detail-close" id="detailClose" type="button" aria-label="' + t('closeDetail') + '">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
            '</button>' +
          '</div>' +
          '<div class="detail-badges">' +
            (p.category ? '<span class="badge green">' + escapeHtml(p.category) + '</span>' : '') +
          '</div>' +
          (p.description ? '<p class="detail-desc">' + highlight(p.description, tokens) + '</p>' : '') +
          '<div class="detail-versions">' +
            '<div class="detail-section-title">' + t('version') + '</div>' +
            '<div class="ver-list">' + verChips + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="detail-links">' +
          '<div class="install-note">' +
            '<p class="install-note-text">' + t('installNote') + '</p>' +
            '<div class="install-cmd">' +
              '<button class="copy-btn install-cmd-btn" type="button" data-cmd="' + escapeHtml(NO_INSTALL_CMD) + '">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                '<span class="install-cmd-text">' + escapeHtml(NO_INSTALL_CMD) + '</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="detail-links-btns">' +
            copyBtn('no install ' + pkgRef(p), t('installBin')) +
            copyBtn('no add ' + pkgRef(p), t('importPkg')) +
          '</div>' +
        '</div>' +
        '<div class="detail-body">' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">' + t('basicInfo') + '</h3>' +
            '<dl class="kv">' +
              kvRow(t('pkgName'), escapeHtml(p.name), true) +
              kvRow(t('version'), escapeHtml(p.repoVersion), true) +
              kvRow(t('repo'), repoUrlOf(p)
                ? '<a class="inline-link" href="' + escapeHtml(repoUrlOf(p)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(repoUrlOf(p)) + '</a>'
                : '') +
              kvRow(t('homepage'), p.homepage
                ? '<a class="inline-link" href="' + escapeHtml(p.homepage) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(p.homepage) + '</a>'
                : '') +
              '<dt>' + t('keywords') + '</dt><dd><div class="pkg-tags" style="margin:0">' + (keywords || emptyDep) + '</div></dd>' +
              kvRow(t('category'), escapeHtml(p.category || '')) +
              kvRow(t('license'), escapeHtml(p.license || '')) +
              kvRow(t('publishStatus'), p.publish ? t('published') : t('unpublished')) +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">' + t('author') + '</h3>' +
            '<dl class="kv">' +
              kvRow(t('author'), escapeHtml(p.author || '')) +
              kvRow(t('email'), escapeHtml(p.email || '')) +
              kvRow(t('org'), escapeHtml(p.organization || '')) +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">' + t('depsSection') + '</h3>' +
            '<dl class="kv">' +
              '<dt>dependencies</dt><dd><div class="dep-list">' + deps + '</div></dd>' +
              '<dt>dev-deps</dt><dd><div class="dep-list">' + devDeps + '</div></dd>' +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">' + t('compilerSection') + '</h3>' +
            '<dl class="kv">' +
              kvRow('compiler', escapeHtml(compiler.version || ''), true) +
              kvRow('link-libs', linkLibs, true) +
              kvRow(t('anonFnType'), compiler['anonymous-fn-type'] === true ? t('enabled') : t('disabled')) +
              kvRow('output', escapeHtml(p.output || ''), true) +
              kvRow('ignore', (p.ignore || []).length ? escapeHtml(p.ignore.join(', ')) : '', true) +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">' + t('snapshotSection') + '</h3>' +
            '<div class="snapshot-path">' +
              (releaseUrl
                ? '<a class="inline-link" href="' + escapeHtml(releaseUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(releaseUrl) + '</a>'
                : escapeHtml(p.snapshotPath)) +
            '</div>' +
            '<dl class="kv" style="margin-top:10px">' +
              kvRow('commit', escapeHtml(p.latestCommit || ''), true) +
            '</dl>' +
          '</div>' +
        '</div>' +
      '</div>';

    // 移动端打开详情抽屉
    if (isMobileDetail()) {
      detailPane.classList.add('open');
      ensureBackdrop().classList.add('show');
    }

    var closeBtn = $('#detailClose');
    if (closeBtn) closeBtn.addEventListener('click', closeDetail);
  }

  function ensureBackdrop() {
    var bd = document.querySelector('.detail-backdrop');
    if (!bd) {
      bd = document.createElement('div');
      bd.className = 'detail-backdrop';
      bd.addEventListener('click', closeDetail);
      document.body.appendChild(bd);
    }
    return bd;
  }

  function closeDetail() {
    state.selected = null;
    state.groupKey = null;
    detailPane.classList.remove('open');
    ensureBackdrop().classList.remove('show');
    renderDetail();
    syncLocation();
    searchInput.focus();
  }

  function selectPackage(pkg) {
    if (pkg && pkg.listOnly) {
      var lazyKey = pkg.name + '@' + (pkg.repoKey || (pkg.host + '/' + pkg.owner + '/' + pkg.repo));
      openGroup(GROUPS[lazyKey]);
      return;
    }
    state.selected = pkg;
    var repoKey = pkg.repoKey || (pkg.host + '/' + pkg.owner + '/' + pkg.repo);
    state.groupKey = pkg.name + '@' + repoKey;
    renderDetail();
    if (isMobileDetail()) {
      var card = detailPane.querySelector('.detail-card');
      if (card) card.scrollTop = 0;
    }
    syncLocation();
  }

  function showDetailLoading(name) {
    detailPane.innerHTML =
      '<div class="detail-card"><div class="detail-empty" style="padding:40px 0">' +
      t('loadingDetail', { name: escapeHtml(name) }) + '</div></div>';
    if (isMobileDetail()) {
      detailPane.classList.add('open');
      ensureBackdrop().classList.add('show');
    }
  }

  function showDetailError(err) {
    detailPane.innerHTML =
      '<div class="detail-card"><div class="detail-empty" style="padding:40px 0">' + t('loadFailed') + ': ' +
      escapeHtml(String((err && err.message) || err || '')) + '</div></div>';
  }

  /**
   * gh-pages 延迟加载：点击卡片后才请求该包的 latest.noml（版本索引）
   * 与默认版本的 package.noml（详情），随后渲染详情与版本切换。
   * targetVersion 非空时直达该版本（深链 ?package= 用），缺省取最新版本。
   */
  function openGroup(group, targetVersion) {
    if (!group) return;
    if (group.loading) return;
    if (group.loaded && group.default && !group.default.listOnly) {
      selectPackage(findRecord(group, targetVersion) || group.default);
      return;
    }
    if (!group.default) return;

    // 访问具体包时立即改写地址栏，不必等详情异步加载完成
    var refVersion = targetVersion || group.defaultVersion;
    if (!targetVersion && state.latestAliasKey === group.key) refVersion = 'latest';
    setLocationRef(group.name + ':' + refVersion + '@' + group.repoKey);

    group.loading = true;
    showDetailLoading(group.name);
    var repoKey = group.repoKey;
    var parts = repoKey.split('/');
    var base = 'packages/' + group.name + '/' + repoKey + '/';
    var defaultVersion = group.defaultVersion;

    Promise.all([
      fetchText(base + 'latest.noml'),
      fetchText(base + defaultVersion + '/package.noml'),
    ]).then(function (res) {
      var latest = window.NOML.parse(res[0]) || {};
      var pkg = window.NOML.parse(res[1]) || {};

      // 版本索引（latest.noml 的 versions，升序）；缺默认版本时补一条
      var versions = Array.isArray(latest.versions) ? latest.versions : [];
      if (!versions.some(function (v) { return v && v.version === defaultVersion; })) {
        versions = versions.concat([{ version: defaultVersion, commit: latest.commit || '' }]);
      }
      group.meta = versions.map(function (v) {
        return {
          repoVersion: v.version,
          commit: v.commit || '',
          snapshot: base + v.version + '/package.noml',
          entry: group.records[v.version] || null,
        };
      }).sort(function (a, b) { return compareVersions(b.repoVersion, a.repoVersion); });
      group.versions = group.meta;

      // 默认版本详情（完整字段，替代首页条目）
      var record = recordFrom({
        name: group.name,
        version: pkg.version,
        tag: '',
        host: parts[0] || '',
        owner: parts[1] || '',
        repo: parts[2] || '',
        repo_version: defaultVersion,
        snapshot: base + defaultVersion + '/package.noml',
      }, pkg, { commit: latest.commit || '' });
      record.listOnly = false;
      group.records[defaultVersion] = record;
      group.default = record;
      group.meta.forEach(function (m) { m.entry = group.records[m.repoVersion] || null; });
      group.loaded = true;

      renderResults();
      return selectVersion(group, targetVersion);
    }).then(function () {
      group.loading = false;
    }).catch(function (err) {
      group.loading = false;
      showDetailError(err);
    });
  }

  /** 选中分组的指定版本；历史版本在 gh-pages 下按需加载，找不到时回退最新 */
  function selectVersion(group, version) {
    if (!version || version === group.defaultVersion) {
      selectPackage(group.default);
      return Promise.resolve();
    }
    var v = group.versions.filter(function (x) { return x.repoVersion === version; })[0];
    var cached = findRecord(group, version);
    if (cached) {
      selectPackage(cached);
      return Promise.resolve();
    }
    if (!v) {
      selectPackage(group.default);
      return Promise.resolve();
    }
    return loadVersion(group, v).then(function (record) {
      selectPackage(record);
    });
  }

  /** 地址栏 ?package=name:version@host/owner/repo → 直接打开对应包/版本 */
  function applyDeepLink() {
    var ref = '';
    try {
      ref = new URLSearchParams(window.location.search).get('package') || '';
    } catch (e) {
      var parts = /(?:^|[?&])package=([^&]*)/.exec(window.location.search || '');
      if (parts) {
        try { ref = decodeURIComponent(parts[1].replace(/\+/g, ' ')); }
        catch (err) { ref = parts[1]; }
      }
    }
    if (!ref) return;
    var target = parsePackageRef(ref);
    if (!target) { syncLocation(); return; } // 非法引用：清掉地址栏参数
    var group = GROUPS[target.name + '@' + target.repoKey];
    if (!group || !group.default) { syncLocation(); return; }
    if (target.version.toLowerCase() === 'latest') {
      state.latestAliasKey = target.name + '@' + target.repoKey;
      openGroup(group, ''); // 走最新版本
    } else {
      openGroup(group, target.version);
    }
  }

  // ---------- 事件 ----------
  function onSearch() {
    state.q = searchInput.value.trim();
    state.activeIdx = -1;
    searchClear.hidden = !state.q;
    renderResults();
  }

  chipsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.chip');
    if (!btn) return;
    state.category = btn.getAttribute('data-cat');
    renderChips();
    renderResults();
  });

  // ---------- 主题切换（暗 / 亮；偏好写入 localStorage，图标由 CSS 按 data-theme 切换） ----------
  function applyTheme(theme) {
    if (document.documentElement) document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('nohub-theme', theme); } catch (e) { /* file:// 等场景忽略 */ }
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = document.documentElement && document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
  }

  // ---------- 语言切换（重渲染全部界面文案；偏好写入 localStorage） ----------
  if (langSelect) {
    langSelect.addEventListener('change', function () {
      applyLang(langSelect.value);
    });
  }

  resultsEl.addEventListener('click', function (e) {
    var card = e.target.closest('.pkg');
    if (!card) return;
    var list = filtered();
    var g = list[Number(card.getAttribute('data-idx'))];
    if (g) selectPackage(g.default);
  });

  // 版本切换 / 复制命令（事件委托，详情重渲染后依然有效）
  detailPane.addEventListener('click', function (e) {
    var btn = e.target.closest('.copy-btn');
    if (btn) {
      var cmd = btn.getAttribute('data-cmd') || '';
      var original = btn.innerHTML;
      copyText(cmd).then(function () {
        btn.classList.add('copied');
        btn.textContent = t('copied');
        setTimeout(function () {
          btn.classList.remove('copied');
          btn.innerHTML = original;
        }, 1400);
      }).catch(function () {
        btn.textContent = t('copyFailed');
        setTimeout(function () {
          btn.innerHTML = original;
        }, 1400);
      });
      return;
    }
    var chip = e.target.closest('.ver-chip');
    if (!chip) return;
    var group = GROUPS[state.groupKey];
    if (!group) return;
    var ver = chip.getAttribute('data-ver');
    var rec = group.versions.filter(function (v) { return v.repoVersion === ver; })[0];
    if (!rec) return;
    // 本地预览（data.js）：版本项本身就是完整记录
    var target = rec.entry || (rec.name ? rec : null);
    if (target) {
      if (target !== state.selected) selectPackage(target);
      return;
    }
    // gh-pages：历史版本按需 fetch package.noml
    loadVersion(group, rec).then(function (record) {
      selectPackage(record);
    }).catch(function () {
      chip.textContent = t('loadFailed');
      setTimeout(renderDetail, 1200);
    });
  });

  searchInput.addEventListener('input', onSearch);
  searchClear.addEventListener('click', function () {
    searchInput.value = '';
    onSearch();
    searchInput.focus();
  });

  $('#emptyReset').addEventListener('click', function () {
    searchInput.value = '';
    state.category = CAT_ALL;
    searchClear.hidden = true;
    renderChips();
    onSearch();
    searchInput.focus();
  });

  searchInput.addEventListener('keydown', function (e) {
    var list = filtered();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      if (state.activeIdx === -1) {
        state.activeIdx = e.key === 'ArrowDown' ? 0 : list.length - 1;
      } else {
        state.activeIdx += e.key === 'ArrowDown' ? 1 : -1;
        if (state.activeIdx >= list.length) state.activeIdx = 0;
        if (state.activeIdx < 0) state.activeIdx = list.length - 1;
      }
      renderResults();
      var el = resultsEl.querySelector('.pkg.active');
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else if (e.key === 'Enter') {
      if (state.activeIdx >= 0 && list[state.activeIdx]) {
        selectPackage(list[state.activeIdx].default);
      } else if (list.length === 1) {
        selectPackage(list[0].default);
      }
    } else if (e.key === 'Escape') {
      if (state.selected) closeDetail();
      else { searchInput.value = ''; onSearch(); }
    }
  });

  // ---------- gh-pages 数据加载（fetch + noml 解析） ----------
  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error(t('httpFailed', { url: url, status: res.status }));
      return res.text();
    });
  }

  function arrOf(value) {
    return Array.isArray(value) ? value.filter(function (x) { return typeof x === 'string'; }) : [];
  }

  function orEmpty(value) {
    return value == null ? '' : value;
  }

  /** docs 回退链：docs -> homepage -> repository */
  function resolveDocs(pkg) {
    return pkg.docs || pkg.homepage || normalizeRepoUrl(pkg.repository) || '';
  }

  /** 把 git 克隆地址（git@ / ssh:// / 裸域名）统一成可点击的 https 页面地址 */
  function normalizeRepoUrl(url) {
    if (!url) return '';
    var s = String(url).trim();
    if (!s) return '';
    var m = s.match(/^git@([^:\s]+):(.+)$/);
    if (m) return 'https://' + m[1] + '/' + m[2].replace(/\.git\/?$/i, '').replace(/\/+$/, '');
    m = s.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
    if (m) return 'https://' + m[1] + '/' + m[2].replace(/\.git\/?$/i, '').replace(/\/+$/, '');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) {
      return 'https://' + s;
    }
    return s.replace(/\.git\/?$/i, '');
  }

  /** 快照清单条目 + 解析后的 package.noml / latest.noml → 索引记录 */
  function recordFrom(entry, pkg, latest) {
    return {
      name: entry.name,
      version: entry.version,
      description: orEmpty(pkg.description),
      keywords: arrOf(pkg.keywords),
      author: orEmpty(pkg.author),
      email: orEmpty(pkg.email),
      organization: orEmpty(pkg.organization),
      repository: orEmpty(pkg.repository),
      repoUrl: normalizeRepoUrl(pkg.repository),
      homepage: orEmpty(pkg.homepage),
      license: orEmpty(pkg.license),
      dependencies: arrOf(pkg.dependencies),
      devDependencies: arrOf(pkg['dev-dependencies']),
      category: orEmpty(pkg.category),
      docs: orEmpty(pkg.docs),
      readme: orEmpty(pkg.readme),
      tagPattern: orEmpty(pkg.tag_pattern),
      tagPrefix: orEmpty(pkg.tag_prefix),
      publish: pkg.publish !== false,
      compiler: pkg.compiler && typeof pkg.compiler === 'object' ? pkg.compiler : {},
      output: orEmpty(pkg.output),
      ignore: arrOf(pkg.ignore),
      host: entry.host,
      owner: entry.owner,
      repo: entry.repo,
      repoVersion: entry.repo_version,
      repoKey: entry.host + '/' + entry.owner + '/' + entry.repo,
      tag: entry.tag,
      docsUrl: resolveDocs(pkg),
      snapshotPath: entry.snapshot,
      latestCommit: latest && latest.commit ? latest.commit : '',
    };
  }

  /** index.noml 的首页条目 → 列表记录（只带列表字段，详情延迟加载） */
  function recordFromIndexEntry(entry) {
    // index.noml 用单个 repo 字段（host/owner/repo）定位仓库，这里再拆给记录用
    var repoKey = entry.repo || '';
    var parts = repoKey.split('/');
    var record = recordFrom({
      name: entry.name,
      version: entry.version,
      tag: entry.tag,
      host: parts[0] || '',
      owner: parts[1] || '',
      repo: parts[2] || '',
      repo_version: entry.version,
      snapshot: 'packages/' + entry.name + '/' + repoKey + '/' + entry.version + '/package.noml',
    }, entry, null);
    record.listOnly = true;
    return record;
  }

  /** 按需加载某个历史版本的 package.noml，解析成完整记录并缓存 */
  function loadVersion(group, rec) {
    if (!group) return Promise.reject(new Error(t('noGroup')));
    if (rec.entry && !rec.entry.listOnly) return Promise.resolve(rec.entry);
    if (rec.loading) return rec.loading;
    if (!rec.snapshot) return Promise.reject(new Error(t('noSnapshot')));
    var parts = group.repoKey.split('/');
    var p = fetchText(rec.snapshot).then(function (text) {
      var pkg = window.NOML.parse(text) || {};
      var record = recordFrom({
        name: group.name,
        version: pkg.version,
        tag: '',
        host: parts[0] || '',
        owner: parts[1] || '',
        repo: parts[2] || '',
        repo_version: rec.repoVersion,
        snapshot: rec.snapshot,
      }, pkg, { commit: rec.commit || '' });
      rec.entry = record;
      group.records[rec.repoVersion] = record;
      return record;
    });
    rec.loading = p;
    p.then(function () { rec.loading = null; }, function () { rec.loading = null; });
    return p;
  }

  /**
   * gh-pages 数据流（延迟加载）：
   *   1. 只 fetch 根级 index.noml（每包一条最新版本，含首页列表所需字段）
   *   2. 直接渲染列表；点击卡片时才请求该包的 latest.noml + package.noml
   *   3. 切换历史版本时再按需 fetch 对应快照
   */
  function loadNomlIndex() {
    if (!window.NOML) return Promise.reject(new Error(t('nomlMissing')));
    return fetchText('index.noml')
      .then(function (text) { return window.NOML.parse(text); })
      .then(function (manifest) {
        var entries = manifest && Array.isArray(manifest.packages) ? manifest.packages : [];
        var packages = entries.map(recordFromIndexEntry);
        return {
          generatedAt: manifest && manifest['generated-at'] ? manifest['generated-at'] : '',
          source: (manifest && manifest.source) || 'nohub gh-pages noml 数据',
          count: packages.length,
          packages: packages,
        };
      });
  }

  function showLoadError(err) {
    var results = document.getElementById('results');
    if (results) results.innerHTML = '';
    var meta = document.getElementById('resultsMeta');
    if (meta) meta.innerHTML = '';
    var empty = document.getElementById('emptyState');
    if (empty) empty.hidden = false;
    var title = document.querySelector('.empty-title');
    if (title) title.textContent = t('dataLoadFailed');
    var sub = document.querySelector('.empty-sub');
    if (sub) sub.textContent = String((err && err.message) || err || '');
  }

  // ---------- 启动 ----------
  function boot() {
    buildGroups();
    applyLang(detectLang(), false);
    if (langSelect) langSelect.value = state.lang;
    renderHeader();
    renderChips();
    renderResults();
    renderDetail();
    applyDeepLink();
  }

  function startNoml() {
    var metaEl = document.getElementById('resultsMeta');
    if (metaEl) metaEl.textContent = t('loadingNoml');
    loadNomlIndex().then(function (idx) {
      INDEX = idx;
      PKGS = idx.packages || [];
      boot();
    }).catch(showLoadError);
  }

  // 本地预览（localhost / file://）才注入 data.js；
  // 线上（gh-pages）不请求 data.js，直接 fetch index.noml + noml 解析。
  function isLocalPreview() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:';
  }

  if (INDEX) {
    boot();
  } else if (isLocalPreview()) {
    var dataScript = document.createElement('script');
    dataScript.src = 'data.js';
    dataScript.onload = function () {
      INDEX = window.NOHUB_INDEX || null;
      PKGS = INDEX ? INDEX.packages || [] : [];
      boot();
    };
    dataScript.onerror = startNoml;
    document.head.appendChild(dataScript);
  } else {
    startNoml();
  }
})();
