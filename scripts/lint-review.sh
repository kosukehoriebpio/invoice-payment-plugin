#!/bin/bash
# lint-review.sh — プラグインスクリプトの自動レビューチェッカー
# 過去のレビューで見つかったパターンを網羅的に検査する
#
# Usage: bash scripts/lint-review.sh
# Exit code: 0 = all pass, 1 = issues found

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPTS_DIR")"
ISSUES=0
WARNINGS=0

red() { echo -e "\033[31m  FAIL: $1\033[0m"; ISSUES=$((ISSUES+1)); }
yellow() { echo -e "\033[33m  WARN: $1\033[0m"; WARNINGS=$((WARNINGS+1)); }
green() { echo -e "\033[32m  OK: $1\033[0m"; }

echo "=== Plugin Lint Review ==="
echo ""

# ============================================================
# Security checks
# ============================================================
echo "--- Security ---"

# S1: Path traversal — no script should use workDir without '..' check
for f in "$SCRIPTS_DIR"/*.ts "$SCRIPTS_DIR"/*.py; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  # Skip sync-references (no workDir)
  [[ "$base" == "sync-references.ts" || "$base" == "lint-review.sh" ]] && continue
  if grep -q "workDir\|work_dir" "$f"; then
    if ! grep -q '\.\.' "$f"; then
      red "$base: uses workDir but has no '..' traversal check"
    else
      green "$base: path traversal guard present"
    fi
  fi
done

# S2: No CLI token args (should use env vars only)
for f in "$SCRIPTS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -qiE '\-\-token|\-\-api[_-]?key|\-\-secret|\-\-password' "$f"; then
    # Check if it's commented out or removed
    if grep -E '^\s*(//|#).*\-\-.*token' "$f" > /dev/null; then
      green "$base: token CLI arg commented out"
    else
      red "$base: CLI arg for secret/token found (use env vars)"
    fi
  else
    green "$base: no CLI secret args"
  fi
done

# S3: URL validation for external API calls
for f in "$SCRIPTS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -q 'apiUrl\|api_url' "$f"; then
    if grep -q 'https\?:\/\/' "$f" | grep -q 'test\|regex\|match\|startsWith'; then
      green "$base: API URL validated"
    elif grep -qE 'https\?:\\/' "$f"; then
      green "$base: API URL validation present"
    else
      yellow "$base: uses apiUrl but validation unclear"
    fi
  fi
done

# S4: Drive query injection
for f in "$SCRIPTS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -q "folderId" "$f"; then
    if grep -q "safeFolderId\|sanitize\|replace.*a-zA-Z" "$f"; then
      green "$base: folderId sanitized"
    else
      red "$base: folderId used without sanitization"
    fi
  fi
done

echo ""

# ============================================================
# Null safety / Error handling
# ============================================================
echo "--- Null Safety ---"

# N1: Property access on potentially null objects (bankAccount, dueDate, etc.)
for f in "$SCRIPTS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  # Check for bare .bankAccount. access without null check
  if grep -qE '\.bankAccount\.' "$f"; then
    if grep -qE 'bankAccount\s*(\?\.|&&|!==\s*null|\|\||if\s*\()' "$f" || grep -q 'ba\.' "$f"; then
      green "$base: bankAccount access has guard"
    else
      yellow "$base: bankAccount accessed — verify null safety"
    fi
  fi
done

# N2: JSON.parse without try-catch on file reads
for f in "$SCRIPTS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  count=$(grep -c 'JSON.parse' "$f" || true)
  guarded=$(grep -c 'try\|existsSync' "$f" || true)
  if [ "$count" -gt 0 ] && [ "$guarded" -eq 0 ]; then
    yellow "$base: JSON.parse without try-catch or existsSync"
  fi
done

# N3: Division by zero
for f in "$SCRIPTS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -qE '/ (reg\.normalAmount|normalAmount|base)' "$f"; then
    if grep -qE 'normalAmount.*=== 0|!normalAmount|normalAmount > 0' "$f"; then
      green "$base: division denominator checked"
    else
      yellow "$base: potential division by zero (normalAmount)"
    fi
  fi
done

echo ""

# ============================================================
# Data integrity
# ============================================================
echo "--- Data Integrity ---"

# D1: Empty records guard (0 件でファイル生成しない)
for f in "$SCRIPTS_DIR"/generate-fb.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -q 'records.length.*=== 0\|records.length < 1\|!records.length\|validRecords.length === 0\|validRecords.length < 1' "$f"; then
    green "$base: empty records guard present"
  else
    red "$base: no guard for 0 records — empty FB file will be generated"
  fi
done

# D2: API response shape validation
for f in "$SCRIPTS_DIR"/reconcile.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -qE 'transfers.*\?\.|Array\.isArray|\.transfers \|\|' "$f"; then
    green "$base: API response shape validated"
  else
    yellow "$base: API response destructured without shape check"
  fi
done

# D3: Amount sanity — no negative amounts should be in FB
for f in "$SCRIPTS_DIR"/generate-fb.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if grep -q 'amount.*<= 0\|amount.*> 0\|amount.*< 0' "$f"; then
    green "$base: negative amount check present"
  else
    yellow "$base: no negative/zero amount guard for FB records"
  fi
done

echo ""

# ============================================================
# FB spec compliance
# ============================================================
echo "--- FB Spec ---"

for f in "$SCRIPTS_DIR"/generate-fb.ts; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  # Check record length
  if grep -q '120' "$f"; then
    green "$base: 120-byte record length referenced"
  else
    yellow "$base: 120-byte record length not explicitly checked"
  fi
done

echo ""

# ============================================================
# Python checks
# ============================================================
echo "--- Python ---"

for f in "$SCRIPTS_DIR"/*.py; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  # P1: Duplicate imports
  dups=$(grep -E '^\s*import ' "$f" | sort | uniq -d)
  if [ -n "$dups" ]; then
    red "$base: duplicate top-level imports: $dups"
  else
    green "$base: no duplicate imports"
  fi
  # P2: Bare except
  if grep -qE 'except\s*:' "$f"; then
    yellow "$base: bare 'except:' found (should specify exception type)"
  fi
done

echo ""

# ============================================================
# Summary
# ============================================================
echo "=== Summary ==="
echo "  Issues (FAIL): $ISSUES"
echo "  Warnings: $WARNINGS"
if [ $ISSUES -gt 0 ]; then
  echo "  Status: FAILED"
  exit 1
else
  echo "  Status: PASSED (with $WARNINGS warnings)"
  exit 0
fi
