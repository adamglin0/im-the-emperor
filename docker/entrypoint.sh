#!/bin/sh
# 按 ROLE 启动对应进程：hub | gateway | dept（dept 另需 DEPT=<部门 id>）
set -e
ROLE="${ROLE:-hub}"
case "$ROLE" in
  hub|gateway|dept|sandbox) ;;
  *) echo "未知 ROLE=$ROLE（应为 hub|gateway|dept|sandbox）" >&2; exit 64 ;;
esac
MAIN="/app/dist/$ROLE/main.js"
if [ ! -f "$MAIN" ]; then
  echo "镜像中没有 $MAIN（构建时该角色入口缺失？）" >&2
  exit 66
fi
exec node --enable-source-maps "$MAIN" "$@"
