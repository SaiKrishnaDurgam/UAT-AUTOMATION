#!/bin/bash

REGION="${DAZN_REGION:-IN}"
ENV="${DAZN_ENV:-prod}"
SPEC="tests/new_user/newuser.ppv.spec.ts"
CONFIG_DIR="config/$ENV"

echo "🚀 Discovering all PPV configs in: $CONFIG_DIR"
echo "🌍 Region: $REGION"
echo "🌐 Env:    $ENV"
echo ""

configs=()
while IFS= read -r -d '' file; do
  configs+=("$file")
done < <(find "$CONFIG_DIR" -name "*.json" -print0)

if [ ${#configs[@]} -eq 0 ]; then
  echo "❌ No config files found in $CONFIG_DIR"
  exit 1
fi

echo "📁 Found ${#configs[@]} config(s):"
for config in "${configs[@]}"; do
  echo "   → $config"
done
echo ""

pids=()
for config in "${configs[@]}"; do
  filename=$(basename "$config")
  echo "▶️  Starting: $filename"
  DAZN_ENV=$ENV DAZN_REGION=$REGION PPV_CONFIG=$filename npx playwright test $SPEC &
  pids+=($!)
done

echo ""
echo "⏳ Waiting for all ${#pids[@]} tests to complete..."

failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    ((failed++))
  fi
done

echo ""
echo "═══════════════════════════════════════"
if [ $failed -eq 0 ]; then
  echo "✅ All ${#configs[@]} tests passed"
else
  echo "❌ $failed / ${#configs[@]} tests failed"
fi
echo "═══════════════════════════════════════"
