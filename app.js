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

  // no 运行时一键安装命令（尚未安装 no 时先执行）
  var NO_INSTALL_CMD = 'curl -fsSL https://raw.githubusercontent.com/lizongying/nolang/main/install.sh | sh';

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
    category: '全部',
    activeIdx: -1, // 键盘导航聚焦项
    selected: null, // 当前详情展示的版本记录
    groupKey: null, // 当前详情所属的包分组
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
      return d.toLocaleString('zh-CN', { hour12: false });
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
      if (cat !== '全部' && (p.category || '未分类') !== cat) return false;
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
      var c = (g.default && g.default.category) || '未分类';
      map[c] = (map[c] || 0) + 1;
    });
    return Object.keys(map).sort(function (a, b) {
      if (a === '未分类') return 1;
      if (b === '未分类') return -1;
      return a.localeCompare(b);
    }).map(function (c) { return { name: c, count: map[c] }; });
  }

  // ---------- 渲染：头部统计 / 分类 ----------
  function renderHeader() {
    var repos = {};
    GROUP_LIST.forEach(function (g) { repos[g.repoKey] = true; });
    headerStats.innerHTML =
      '<span class="stat-pill"><b>' + GROUP_LIST.length + '</b> 个包</span>' +
      '<span class="stat-pill"><b>' + Object.keys(repos).length + '</b> 个仓库</span>';
    footerSource.textContent = '数据快照生成于 ' + fmtTime(INDEX.generatedAt);
  }

  function renderChips() {
    var cats = categories();
    var html = '<button class="chip' + (state.category === '全部' ? ' active' : '') +
      '" data-cat="全部" type="button">全部<span class="chip-count">' + GROUP_LIST.length + '</span></button>';
    cats.forEach(function (c) {
      html += '<button class="chip' + (state.category === c.name ? ' active' : '') +
        '" data-cat="' + escapeHtml(c.name) + '" type="button">' +
        escapeHtml(c.name) + '<span class="chip-count">' + c.count + '</span></button>';
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
    if (state.q || state.category !== '全部') {
      resultsMeta.innerHTML = '找到 <b>' + list.length + '</b> / ' + total + ' 个包';
    } else {
      resultsMeta.innerHTML = '共 <b>' + total + '</b> 个包';
    }

    resultsEl.innerHTML = list.map(function (g, i) {
      var p = g.default;
      if (!p) return '';
      var keywords = (p.keywords || []).slice(0, 5).map(function (k) {
        return '<span class="tag">' + highlight(k, tokens) + '</span>';
      }).join('');
      var badges = '<span class="badge">' + escapeHtml(p.repoVersion) + '</span>';
      if (!p.publish) badges += '<span class="badge gray">未发布</span>';
      if (p.category) badges += '<span class="badge green">' + escapeHtml(p.category) + '</span>';

      var verCount = g.versions.length;

      return '<button class="pkg' + (i === state.activeIdx ? ' active' : '') +
        '" type="button" data-idx="' + i + '">' +
        '<div class="pkg-head">' +
          '<span class="pkg-name">' + highlight(p.name, tokens) + '</span>' +
          badges +
        '</div>' +
        '<p class="pkg-desc">' + highlight(p.description || '暂无描述', tokens) + '</p>' +
        (keywords ? '<div class="pkg-tags">' + keywords + '</div>' : '') +
        '<div class="pkg-meta">' +
          '<span>' + escapeHtml(p.host) + '/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '</span>' +
          (p.license ? '<span class="dot">' + escapeHtml(p.license) + '</span>' : '') +
          '<span class="dot">' + (p.publish ? '已发布' : '未发布') + '</span>' +
          (verCount > 1 ? '<span class="dot">' + verCount + ' 个版本</span>' : '') +
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

  // 包引用：name:repoVersion@host/owner/repo
  function pkgRef(p) {
    return p.name + ':' + p.repoVersion + '@' + p.host + '/' + p.owner + '/' + p.repo;
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
        '<div>从左侧选择一个包<br />查看完整 package 信息与快照</div>' +
        '</div>';
      return;
    }

    var tokens = tokensOf(state.q);
    var compiler = p.compiler || {};
    var emptyDep = '<span style="color:#b6bbc9">无</span>';
    var deps = (p.dependencies || []).map(function (d) {
      return '<span class="dep">' + escapeHtml(d) + '</span>';
    }).join('') || emptyDep;
    var devDeps = (p.devDependencies || []).map(function (d) {
      return '<span class="dep">' + escapeHtml(d) + '</span>';
    }).join('') || emptyDep;

    var linkLibs = Array.isArray(compiler['link-libs']) && compiler['link-libs'].length
      ? compiler['link-libs'].map(escapeHtml).join(', ') : '无';
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
            '<button class="detail-close" id="detailClose" type="button" aria-label="关闭详情">' +
              '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
            '</button>' +
          '</div>' +
          '<div class="detail-badges">' +
            (p.category ? '<span class="badge green">' + escapeHtml(p.category) + '</span>' : '') +
          '</div>' +
          (p.description ? '<p class="detail-desc">' + highlight(p.description, tokens) + '</p>' : '') +
          '<div class="detail-versions">' +
            '<div class="detail-section-title">版本</div>' +
            '<div class="ver-list">' + verChips + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="detail-links">' +
          '<div class="install-note">' +
            '<p class="install-note-text">如果还没有 <code>no</code>，需要先安装：一键安装（macOS / Linux / Windows Git Bash）会自动下载最新的 <code>no</code> 到 <code>$HOME/.local/bin</code>。</p>' +
            '<div class="install-cmd">' +
              '<button class="copy-btn install-cmd-btn" type="button" data-cmd="' + escapeHtml(NO_INSTALL_CMD) + '">' +
                '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                '<span class="install-cmd-text">' + escapeHtml(NO_INSTALL_CMD) + '</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="detail-links-btns">' +
            copyBtn('no install ' + pkgRef(p), '安装可执行文件') +
            copyBtn('no add ' + pkgRef(p), '导入包') +
          '</div>' +
        '</div>' +
        '<div class="detail-body">' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">基本信息</h3>' +
            '<dl class="kv">' +
              kvRow('包名', escapeHtml(p.name), true) +
              kvRow('版本', escapeHtml(p.repoVersion), true) +
              kvRow('仓库', repoUrlOf(p)
                ? '<a class="inline-link" href="' + escapeHtml(repoUrlOf(p)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(repoUrlOf(p)) + '</a>'
                : '') +
              kvRow('主页', p.homepage
                ? '<a class="inline-link" href="' + escapeHtml(p.homepage) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(p.homepage) + '</a>'
                : '') +
              '<dt>关键词</dt><dd><div class="pkg-tags" style="margin:0">' + (keywords || emptyDep) + '</div></dd>' +
              kvRow('分类', escapeHtml(p.category || '')) +
              kvRow('许可证', escapeHtml(p.license || '')) +
              kvRow('发布状态', p.publish ? '已发布' : '未发布') +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">作者</h3>' +
            '<dl class="kv">' +
              kvRow('作者', escapeHtml(p.author || '')) +
              kvRow('邮箱', escapeHtml(p.email || '')) +
              kvRow('组织', escapeHtml(p.organization || '')) +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">依赖</h3>' +
            '<dl class="kv">' +
              '<dt>dependencies</dt><dd><div class="dep-list">' + deps + '</div></dd>' +
              '<dt>dev-deps</dt><dd><div class="dep-list">' + devDeps + '</div></dd>' +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">编译选项</h3>' +
            '<dl class="kv">' +
              kvRow('compiler', escapeHtml(compiler.version || ''), true) +
              kvRow('link-libs', linkLibs, true) +
              kvRow('匿名函数类型', compiler['anonymous-fn-type'] === true ? '开启' : '关闭') +
              kvRow('output', escapeHtml(p.output || ''), true) +
              kvRow('ignore', (p.ignore || []).length ? escapeHtml(p.ignore.join(', ')) : '', true) +
            '</dl>' +
          '</div>' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">快照</h3>' +
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
  }

  function showDetailLoading(name) {
    detailPane.innerHTML =
      '<div class="detail-card"><div class="detail-empty" style="padding:40px 0">正在加载 ' +
      escapeHtml(name) + ' 的详情…</div></div>';
    if (isMobileDetail()) {
      detailPane.classList.add('open');
      ensureBackdrop().classList.add('show');
    }
  }

  function showDetailError(err) {
    detailPane.innerHTML =
      '<div class="detail-card"><div class="detail-empty" style="padding:40px 0">加载失败：' +
      escapeHtml(String((err && err.message) || err || '')) + '</div></div>';
  }

  /**
   * gh-pages 延迟加载：点击卡片后才请求该包的 latest.noml（版本索引）
   * 与默认版本的 package.noml（详情），随后渲染详情与版本切换。
   */
  function openGroup(group) {
    if (!group) return;
    if (group.loading) return;
    if (group.loaded && group.default && !group.default.listOnly) {
      selectPackage(group.default);
      return;
    }
    if (!group.default) return;

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
      group.loaded = true;
      group.loading = false;

      renderResults();
      selectPackage(record);
    }).catch(function (err) {
      group.loading = false;
      showDetailError(err);
    });
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
        btn.textContent = '已复制';
        setTimeout(function () {
          btn.classList.remove('copied');
          btn.innerHTML = original;
        }, 1400);
      }).catch(function () {
        btn.textContent = '复制失败';
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
    loadVersion(rec).then(function (record) {
      selectPackage(record);
    }).catch(function () {
      chip.textContent = '加载失败';
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
    state.category = '全部';
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
      if (!res.ok) throw new Error(url + ' 加载失败（HTTP ' + res.status + '）');
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
  function loadVersion(rec) {
    var group = GROUPS[state.groupKey];
    if (!group) return Promise.reject(new Error('缺少包分组信息'));
    if (rec.entry) return Promise.resolve(rec.entry);
    if (rec.loading) return rec.loading;
    if (!rec.snapshot) return Promise.reject(new Error('缺少快照地址'));
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
    if (!window.NOML) return Promise.reject(new Error('noml.js 未加载，无法解析数据'));
    return fetchText('index.noml')
      .then(function (text) { return window.NOML.parse(text); })
      .then(function (manifest) {
        var entries = manifest && Array.isArray(manifest.packages) ? manifest.packages : [];
        var packages = entries.map(recordFromIndexEntry);
        return {
          generatedAt: manifest && manifest.generated_at ? manifest.generated_at : '',
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
    if (title) title.textContent = '数据加载失败';
    var sub = document.querySelector('.empty-sub');
    if (sub) sub.textContent = String((err && err.message) || err || '');
  }

  // ---------- 启动 ----------
  function boot() {
    buildGroups();
    renderHeader();
    renderChips();
    renderResults();
    renderDetail();
  }

  // 本地预览：data.js 已注入 window.NOHUB_INDEX，直接渲染；
  // gh-pages：无 data.js，走 fetch + noml 解析。
  if (INDEX) {
    boot();
  } else {
    var metaEl = document.getElementById('resultsMeta');
    if (metaEl) metaEl.textContent = '正在加载 noml 数据…';
    loadNomlIndex().then(function (idx) {
      INDEX = idx;
      PKGS = idx.packages || [];
      boot();
    }).catch(showLoadError);
  }
})();
