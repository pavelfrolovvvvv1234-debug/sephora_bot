#!/bin/sh
# Replace require("@/database") with require("./database") in dist so Node can resolve the module.
# Run from project root: sh scripts/fix-database-require.sh
# Or on VPS after build: cd /root/sephora-tg && sed -i 's|require("@/database")|require("./database")|g' dist/index.js

set -e
DIST_INDEX="${1:-dist/index.js}"
if [ ! -f "$DIST_INDEX" ]; then
  echo "[fix-database-require] $DIST_INDEX not found"
  exit 1
fi
if grep -q 'require("@/database")' "$DIST_INDEX" 2>/dev/null; then
  sed -i.bak 's|require("@/database")|require("./database")|g' "$DIST_INDEX"
  rm -f "${DIST_INDEX}.bak"
  echo "[fix-database-require] Replaced @/database in $DIST_INDEX"
else
  echo "[fix-database-require] No @/database found in $DIST_INDEX (already fixed?)"
fi
