#!/usr/bin/env bash
# Runs the E2E suite across both engines and both database modes.
set -euo pipefail
cd "$(dirname "$0")/../.."

fail=0
for spec in "33061 mysql8-create create" "33061 mysql8-connect connect" \
            "33062 mariadb-create create" "33062 mariadb-connect connect"; do
  set -- $spec
  echo ""
  node tests/e2e/run.js "$1" "$2" --mode "$3" || fail=1
done

exit $fail
