#!/usr/bin/env bash
set -euo pipefail

runner_ids=(1 2 3 4)

for runner_id in "${runner_ids[@]}"; do
  runner_dir="$HOME/actions-runner-$runner_id"

  if [[ ! -d "$runner_dir" ]]; then
    echo "[WARN] Runner directory not found: $runner_dir"
    continue
  fi

  if [[ ! -x "$runner_dir/svc.sh" ]]; then
    echo "[WARN] svc.sh not found for runner $runner_id in $runner_dir"
    continue
  fi

  echo "===== Starting runner $runner_id ====="
  (cd "$runner_dir" && ./svc.sh install || true)
  (cd "$runner_dir" && ./svc.sh start || true)
  (cd "$runner_dir" && ./svc.sh status || true)
  echo
done
