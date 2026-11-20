/* ============================================================
   nohub 搜索页交互逻辑
   数据来源：data.js（由 web/build.mjs 从 packages/ 快照生成）
   说明：package.noml 的 version 字段与 release 相关，页面不展示；
        版本以快照目录的仓库版本（repoVersion）为准，可切换。
   ============================================================ */
(function () {
  'use strict';

  var INDEX = window.NOHUB_INDEX || { packages: [], generatedAt: '', source: '' };
  var PKGS = INDEX.packages || [];

  // ---------- 按包分组（同名同仓库的多个版本快照归为一组） ----------
  var GROUPS = {};
  PKGS.forEach(function (p) {
    var repoKey = p.repoKey || (p.host + '/' + p.owner + '/' + p.repo);
    var k = p.name + '@' + repoKey;
    if (!GROUPS[k]) GROUPS[k] = { key: k, repoKey: repoKey, name: p.name, versions: [] };
    GROUPS[k].versions.push(p);
  });
  Object.keys(GROUPS).forEach(function (k) {
    GROUPS[k].versions.sort(function (a, b) {
      return compareVersions(b.repoVersion, a.repoVersion);
    });
    GROUPS[k].default = GROUPS[k].versions[0];
  });
  var GROUP_LIST = Object.keys(GROUPS).map(function (k) { return GROUPS[k]; })
    .sort(function (a, b) {
      var byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.repoKey.localeCompare(b.repoKey);
    });

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
      var c = g.default.category || '未分类';
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
    PKGS.forEach(function (p) {
      var k = p.repoKey || (p.host + '/' + p.owner + '/' + p.repo);
      repos[k] = true;
    });
    headerStats.innerHTML =
      '<span class="stat-pill"><b>' + PKGS.length + '</b> 个包</span>' +
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
      var keywords = (p.keywords || []).slice(0, 5).map(function (k) {
        return '<span class="tag">' + highlight(k, tokens) + '</span>';
      }).join('');
      var badges = '<span class="badge">' + escapeHtml(p.repoVersion) + '</span>';
      if (!p.publish) badges += '<span class="badge gray">未发布</span>';
      if (p.category) badges += '<span class="badge green">' + escapeHtml(p.category) + '</span>';

      var verCount = g.versions.length;
      var verHint = verCount > 1 ? ' · ' + verCount + ' 个版本' : '';

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
          '<span class="dot">' + escapeHtml(p.repoVersion) + ' 快照' + verHint + '</span>' +
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

  function linkIf(url, text, ghost) {
    if (!url) return '';
    return '<a class="link-btn' + (ghost ? ' ghost' : '') + '" href="' + escapeHtml(url) +
      '" target="_blank" rel="noopener noreferrer">' + escapeHtml(text) +
      ' <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg></a>';
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

    // 文档入口：docs → homepage → repository 回退链取值
    var docsLabel = '文档入口';
    var linkLibs = Array.isArray(compiler['link-libs']) && compiler['link-libs'].length
      ? compiler['link-libs'].map(escapeHtml).join(', ') : '无';
    var keywords = (p.keywords || []).map(function (k) {
      return '<span class="tag">' + highlight(k, tokens) + '</span>';
    }).join('');

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
            '<span class="badge">' + escapeHtml(p.repoVersion) + '</span>' +
            (p.category ? '<span class="badge green">' + escapeHtml(p.category) + '</span>' : '') +
            (p.publish ? '' : '<span class="badge gray">未发布</span>') +
          '</div>' +
          (p.description ? '<p class="detail-desc">' + highlight(p.description, tokens) + '</p>' : '') +
        '</div>' +
        '<div class="detail-links">' +
          linkIf(repoUrlOf(p), '源码仓库') +
          linkIf(p.docsUrl, docsLabel, true) +
          (p.homepage && p.homepage !== p.docsUrl ? linkIf(p.homepage, '主页', true) : '') +
          copyBtn('no install ' + pkgRef(p), '安装可执行文件') +
          copyBtn('no add ' + pkgRef(p), '导入包') +
        '</div>' +
        '<div class="detail-body">' +
          '<div class="detail-section">' +
            '<h3 class="detail-section-title">基本信息</h3>' +
            '<dl class="kv">' +
              kvRow('包名', escapeHtml(p.name), true) +
              '<dt>版本</dt><dd><div class="ver-list">' + verChips + '</div></dd>' +
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
              kvRow('主页', p.homepage
                ? '<a class="inline-link" href="' + escapeHtml(p.homepage) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(p.homepage) + '</a>'
                : '') +
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
            '<div class="snapshot-path">' + escapeHtml(p.snapshotPath) + '</div>' +
            '<dl class="kv" style="margin-top:10px">' +
              kvRow('readme', escapeHtml(p.readme || ''), true) +
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
    state.selected = pkg;
    var repoKey = pkg.repoKey || (pkg.host + '/' + pkg.owner + '/' + pkg.repo);
    state.groupKey = pkg.name + '@' + repoKey;
    renderDetail();
    if (isMobileDetail()) {
      var card = detailPane.querySelector('.detail-card');
      if (card) card.scrollTop = 0;
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
    if (rec && rec !== state.selected) selectPackage(rec);
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

  // ---------- 初始化 ----------
  renderHeader();
  renderChips();
  renderResults();
  renderDetail();
})();
