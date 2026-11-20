#!/usr/bin/env node
/**
 * nohub CLI。
 *
 *   nohub sync [host/owner/repo] [--root <dir>] [--dry-run] [--strict]
 *
 * sync 读取 repos/<host>/<owner>.noml 的收录记录，拉取上游 workspace.noml /
 * package.noml，按仓库版本写快照、更新 latest.noml 与 state/sync.noml。
 */
import { sync } from '../lib/sync.mjs';

const USAGE = `用法：
  nohub sync [host/owner/repo] [选项]   同步收录的仓库
  nohub --help                          显示帮助
  nohub --version                       显示版本

选项：
  --root <dir>    实例仓库根目录（缺省：本仓库）
  --dry-run       只报告，不写盘
  --strict        有仓库失败或部分成功（有包被跳过）时以非零码退出

说明：
  位置参数可写 host/owner/repo，也可简写 owner/repo（缺省 github.com）。
  留空表示全量同步。全量同步会清理已不在收录记录里的仓库快照；
  指定仓库时只做增量，不清理其它仓库。

  参考实现里用 node bin/nohub.mjs sync 调用；工作流直接跑同一入口。
`;

const VERSION = '0.1.0';

async function main(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(`nohub ${VERSION}`);
    return 0;
  }
  if (cmd !== 'sync') {
    process.stderr.write(`未知命令：${cmd}\n\n${USAGE}`);
    return 2;
  }

  const opts = parseSyncArgs(rest);
  if (!opts.ok) {
    process.stderr.write(`${opts.error}\n\n${USAGE}`);
    return 2;
  }

  const report = await sync({
    root: opts.root,
    filter: opts.filter,
    dryRun: opts.dryRun,
    strict: opts.strict,
  });

  printReport(report, opts);
  return opts.strict && !report.ok ? 1 : 0;
}

function parseSyncArgs(args) {
  const opts = { root: undefined, filter: '', dryRun: false, strict: false, ok: true, error: '' };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--root') {
      const v = args[++i];
      if (!v) return { ...opts, ok: false, error: '--root 缺少目录参数' };
      opts.root = v;
    } else if (a.startsWith('--root=')) {
      opts.root = a.slice('--root='.length);
    } else if (a.startsWith('--')) {
      return { ...opts, ok: false, error: `未知选项：${a}` };
    } else {
      positional.push(a);
    }
  }

  if (positional.length > 1) return { ...opts, ok: false, error: '只能有一个位置参数（host/owner/repo）' };
  if (positional.length === 1) {
    const text = positional[0].trim();
    if (text) opts.filter = text;
  }
  return opts;
}

function printReport(report, opts) {
  const out = process.stdout;
  out.write(`\nnohub sync${report.filter ? ` ${report.filter}` : ''}${opts.dryRun ? '（dry-run）' : ''}\n`);

  if (report.repos.length === 0) {
    out.write('  没有匹配的收录记录。\n');
    return;
  }

  for (const r of report.repos) {
    const where = `${r.host}/${r.owner}/${r.repo}`;
    if (r.status === 'skipped') {
      out.write(`  - ${where} 跳过（${r.reason}）\n`);
      continue;
    }
    if (r.status === 'error') {
      out.write(`  ✗ ${where} 失败：${r.error}\n`);
      continue;
    }
    const mark = r.status === 'partial' ? '!' : '✓';
    const pkgs = r.packages.map((p) => p.name).join(', ');
    out.write(`  ${mark} ${where} ${r.version}（${r.branch}）包：${pkgs}\n`);
    for (const s of r.skipped ?? []) {
      out.write(`    - 跳过 ${s.key}（${s.path}）：${s.reason}\n`);
    }
    for (const w of r.warnings) out.write(`    ! ${w}\n`);
  }

  if (report.removed.length > 0) {
    out.write(`  清理已删除仓库：${report.removed.join('、')}\n`);
  }
  if (report.latest) {
    out.write(`  latest.noml：${report.latest.count} 条${report.latest.changed ? '（已更新）' : '（无变化）'}\n`);
  }

  const okCount = report.repos.filter((r) => r.status === 'ok').length;
  out.write(`  结果：${okCount} 成功，${report.partial} 部分，${report.errors} 失败，${report.warnings} 告警\n`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`\nnohub: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
