#!/usr/bin/env bash
# nohub 校验器离线测试（fixture 模式，不访问网络，不碰共享 repos/ 目录）。
# 用法：validate/tests/run.sh [编译器路径] [校验器源码]
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
TESTROOT="$HERE/testroot"
NO="${1:-/Users/lizongying/IdeaProjects/no/bin/no}"
SRC="${2:-$ROOT/validate/main.no}"
BIN="$HERE/_validate-bin"
FIX="$HERE/fixture"

PASS=0
FAIL=0

ok() { echo "  ok   - $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL - $1"; FAIL=$((FAIL + 1)); }

echo "== build =="
"$NO" build -o "$BIN" "$SRC" >/dev/null || { echo "build failed"; exit 1; }
ok "build"

run() {
  # run <author> <repos-file-rel-to-testroot>
  NOHUB_VALIDATE_FIXTURE="$FIX" "$BIN" "$1" "$2" "$TESTROOT"
}

echo "== 通过路径 =="
OUT=$(run lizongying repos/github.com/lizongying.noml 2>&1)
RC=$?
[ "$RC" -eq 0 ] && ok "四项全通过时退出码 0" || bad "通过路径退出码应为 0，实际 $RC"
echo "$OUT" | grep -q 'PASS 作者 repos/github.com/lizongying.noml' && ok "作者校验通过" || bad "作者校验未通过"
echo "$OUT" | grep -q 'PASS 仓库存在 lizongying/nolang' && ok "仓库存在校验通过" || bad "仓库存在校验未通过"
echo "$OUT" | grep -q 'PASS 工作区存在 lizongying/nolang' && ok "工作区存在校验通过" || bad "工作区存在校验未通过"
echo "$OUT" | grep -q 'PASS 至少一个 package lizongying/nolang' && ok "package 校验通过" || bad "package 校验未通过"

echo "== 失败路径：作者不匹配 =="
OUT=$(run badactor repos/github.com/lizongying.noml 2>&1)
RC=$?
[ "$RC" -ne 0 ] && ok "作者不匹配时退出码非 0" || bad "作者不匹配应失败"
echo "$OUT" | grep -q 'FAIL 作者.*badactor.*lizongying' && ok "报告作者不匹配原因" || bad "未报告作者不匹配"

echo "== 失败路径：仓库不存在 =="
OUT=$(NOHUB_VALIDATE_FIXTURE="$FIX" "$BIN" lizongying repos/github.com/lizongying.noml "$TESTROOT/ghost" 2>&1)
RC=$?
[ "$RC" -ne 0 ] && ok "仓库不存在时退出码非 0" || bad "仓库不存在应失败"
echo "$OUT" | grep -q 'FAIL 仓库存在 lizongying/ghostrepo.*404' && ok "报告仓库 404" || bad "未报告仓库 404"

echo "== 失败路径：仓库根无 workspace.noml =="
OUT=$(NOHUB_VALIDATE_FIXTURE="$FIX" "$BIN" lizongying repos/github.com/lizongying.noml "$TESTROOT/noworkspace" 2>&1)
RC=$?
[ "$RC" -ne 0 ] && ok "工作区缺失时退出码非 0" || bad "工作区缺失应失败"
echo "$OUT" | grep -q 'FAIL 工作区存在 lizongying/noworkspace' && ok "报告工作区缺失" || bad "未报告工作区缺失"

echo "== 失败路径：workspace.noml 无 package =="
OUT=$(NOHUB_VALIDATE_FIXTURE="$FIX" "$BIN" lizongying repos/github.com/lizongying.noml "$TESTROOT/emptyrepo" 2>&1)
RC=$?
[ "$RC" -ne 0 ] && ok "空工作区时退出码非 0" || bad "空工作区应失败"
echo "$OUT" | grep -q 'FAIL 至少一个 package lizongying/emptyrepo' && ok "报告无 package" || bad "未报告无 package"

rm -f "$BIN"

echo ""
echo "result: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
