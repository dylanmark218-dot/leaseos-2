#!/usr/bin/env bash
# Gate 4's test-file type ratchet, keeping the compiler's exit status.
#
# The ratchet used to be one line:
#     TEST_TS_NOW=$(pnpm exec tsc --noEmit -p tsconfig.tests.json 2>&1 | grep -cE "\.test\.tsx?\(" || true)
# Reproduced on 2026-09-30 with a tsconfig that does not exist: tsc exits 1, prints no
# `.test.ts(` line, the count is 0, and the gate prints "clean". The `|| true` throws away the
# status that `pipefail` would otherwise have carried, so a compiler that could not run, or a
# type error in a NON-test file under this config, both read as a clean ratchet.
#
# Now: the compiler's output goes to a file and its exit status is kept. The verdict is:
#   - exit 0                          -> clean, whatever the count (it is 0);
#   - exit != 0 and test-file errors  -> the ratchet: fail only if the count exceeds the pin;
#   - exit != 0 and NO test-file error -> the compiler failed for another reason (it could not
#                                        run, or a non-test file is broken): show it and fail.
# Nothing here greps the output to decide whether the compiler succeeded.
#
# Usage: scripts/test-file-ratchet.sh [tsconfig] [pin]      (defaults: tsconfig.tests.json, 0)
set -uo pipefail
TSCONFIG="${1:-tsconfig.tests.json}"
PIN="${2:-0}"
OUT="$(mktemp "${TMPDIR:-/tmp}/leaseos-test-tsc.XXXXXX")"
trap 'rm -f "$OUT"' EXIT

pnpm exec tsc --noEmit -p "$TSCONFIG" >"$OUT" 2>&1
TSC_EXIT=$?
NOW=$(grep -cE "\.test\.tsx?\(" "$OUT" || true)
echo "test-file type errors: $NOW (pinned ceiling $PIN; tsc exit $TSC_EXIT)"

if [ "$TSC_EXIT" -ne 0 ] && [ "$NOW" -eq 0 ]; then
  echo "tsc exited $TSC_EXIT with no test-file error — it did not run cleanly, and that is not a clean ratchet:"
  head -20 "$OUT"
  exit 1
fi
if [ "$NOW" -gt "$PIN" ]; then
  echo "test-file type errors rose from $PIN to $NOW:"
  grep -E "\.test\.tsx?\(" "$OUT" | head -20
  exit 1
fi
echo "clean"
