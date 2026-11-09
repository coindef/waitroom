#!/usr/bin/env bash
# Real Claude Code check for wait-anchor's $.store.
#
# Not claude plugin test, and not demo/host.ts.
#
# Test-only barrier (never set in production):
#   WAIT_ANCHOR_STORE_BARRIER     directory for stamp files
#   WAIT_ANCHOR_STORE_BARRIER_OK  must be 1 or the gate is off
#
# When both are set, persistNote rendezvouses (arrive/release), stamps `start`
# immediately before $.store.set/delete, then stamps `done` after it returns.
# Overlap means max(start) < min(done) for the two writers. That is the only
# "concurrent store" claim this script may print. It is not proof that two
# writers of one key are safe.
#
# Each of the three cases runs ATTEMPTS times (default 20). Every attempt must
# pass fresh-process readback isolation. The script prints overlap as k/N per
# case. Exit 0 requires isolation on every attempt. Exit 2 is a failed opening
# probe (not logged in, or any other probe failure). Exit 2 is not a pass.
#
# Cases:
#   1. Two directories named app, different parents, different session ids.
#   2. One project directory, two session ids. set against set.
#   3. That same project, set against delete.
#
# Foreground --resume of one id can attach while that session is still open.
# That was observed separately. This script does not claim two writers of one
# key are safe.

set -euo pipefail
shopt -s inherit_errexit

here=$(cd "$(dirname "$0")" && pwd)
plugin=$(cd "$here/.." && pwd)
claude=${CLAUDE:-claude}
attempts=${ATTEMPTS:-20}

new_uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
    return
  fi
  say "real-store-race: no uuid source (/proc/sys/kernel/random/uuid or uuidgen)"
  exit 2
}

say() { printf '%s\n' "$*"; }

probe_status=0
probe=$("$claude" -p 'hi' --max-turns 1 --output-format text 2>&1) || probe_status=$?
if [ "$probe_status" -ne 0 ]; then
  say "real-store-race: prerequisite failed (exit ${probe_status}). No store result."
  printf '%s\n' "$probe"
  exit 2
fi

if [ -n "${WORKDIR:-}" ]; then
  work=$WORKDIR
  mkdir -p "$work"
  owned_work=0
else
  work=$(mktemp -d "${TMPDIR:-/tmp}/wait-anchor-store.XXXXXX")
  owned_work=1
fi

cleanup() {
  # Only remove a workdir we created. Keep an explicit WORKDIR for diagnosis.
  if [ "$owned_work" -eq 1 ] && [ -d "$work" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT

mkdir -p "$work/left/app" "$work/right/app" "$work/same/app"
left_root="$work/left/app"
right_root="$work/right/app"
same_root="$work/same/app"

say "workdir $work"
say "attempts $attempts"

require() {
  local file=$1 needle=$2
  if ! grep -F -q -- "$needle" "$file"; then
    say "missing [$needle] in $file"
    say "workdir $work"
    exit 1
  fi
}

forbid() {
  local file=$1 needle=$2
  if grep -F -q -- "$needle" "$file"; then
    say "leaked [$needle] in $file"
    say "workdir $work"
    exit 1
  fi
}

# Both processes start immediately. The wait is inside persistNote.
pair() {
  local gate=$1
  local dir_a=$2 sid_a=$3 text_a=$4 out_a=$5
  local dir_b=$6 sid_b=$7 text_b=$8 out_b=$9
  local how_a=${10} how_b=${11}
  mkdir -p "$gate"
  one() {
    local how=$1 dir=$2 sid=$3 text=$4 out=$5
    (
      cd "$dir"
      export WAIT_ANCHOR_STORE_BARRIER="$gate"
      export WAIT_ANCHOR_STORE_BARRIER_OK=1
      if [ "$how" = first ]; then
        "$claude" --plugin-dir "$plugin" --session-id "$sid" -p "$text" --max-turns 1 --output-format text
      else
        "$claude" --plugin-dir "$plugin" --resume "$sid" -p "$text" --max-turns 1 --output-format text
      fi
    ) > "$out" 2>&1
  }
  one "$how_a" "$dir_a" "$sid_a" "$text_a" "$out_a" &
  local pa=$!
  one "$how_b" "$dir_b" "$sid_b" "$text_b" "$out_b" &
  local pb=$!
  wait "$pa"
  wait "$pb"
}

read_fresh() {
  local dir=$1 sid=$2 out=$3
  (
    cd "$dir"
    "$claude" --plugin-dir "$plugin" --resume "$sid" -p '/anchor' --max-turns 1 --output-format text
  ) > "$out" 2>&1
}

# Prints "overlap 1" or "overlap 0". Exit 1 on malformed stamps.
check_gate() {
  local gate=$1
  python3 - "$gate" << 'PY'
import pathlib, sys
gate = pathlib.Path(sys.argv[1])
def load(kind):
    found = []
    for path in sorted(gate.glob(kind + '-*')):
        parts = path.read_text().split()
        if len(parts) != 2:
            print(f'barrier: bad stamp {path.name}')
            sys.exit(1)
        op, ms = parts
        found.append((path.name[len(kind) + 1 :], op, int(ms)))
    return found
arrive, release, start, done = load('arrive'), load('release'), load('start'), load('done')
print(f'gate {gate.name}')
for kind, rows in (('arrive', arrive), ('release', release), ('start', start), ('done', done)):
    for sid, op, ms in rows:
        print(f'  {kind} {sid} {op} {ms}')
if len(arrive) != 2 or len(release) != 2 or len(start) != 2 or len(done) != 2:
    print('barrier: expected 2 arrive, 2 release, 2 start, 2 done')
    sys.exit(1)
if max(ms for _, _, ms in arrive) > min(ms for _, _, ms in release):
    print('barrier: a writer released before both had arrived')
    sys.exit(1)
starts = [ms for _, _, ms in start]
dones = [ms for _, _, ms in done]
# Genuine store overlap: both store calls had started before either finished.
overlapped = max(starts) < min(dones)
print(f'overlap {1 if overlapped else 0}')
print('not proven: two writers of one session id')
PY
}

run_case_roots() {
  local i=$1
  local gate="$work/gate-roots-$i"
  local left_id right_id
  left_id=$(new_uuid)
  right_id=$(new_uuid)
  rm -rf "$gate"
  pair "$gate" \
    "$left_root" "$left_id" '/anchor left goal · check: left check' "$work/left-set-$i.txt" \
    "$right_root" "$right_id" '/anchor right goal · check: right check' "$work/right-set-$i.txt" \
    first first
  local overlap_line
  overlap_line=$(check_gate "$gate" | tee "$work/gate-roots-$i.log" | awk '/^overlap /{print $2; found=1} END{if(!found) exit 1}')
  read_fresh "$left_root" "$left_id" "$work/left-read-$i.txt"
  read_fresh "$right_root" "$right_id" "$work/right-read-$i.txt"
  require "$work/left-read-$i.txt" 'left goal'
  require "$work/left-read-$i.txt" 'left check'
  forbid "$work/left-read-$i.txt" 'right goal'
  require "$work/right-read-$i.txt" 'right goal'
  require "$work/right-read-$i.txt" 'right check'
  forbid "$work/right-read-$i.txt" 'left goal'
  # clear notes so the next attempt is clean
  (
    cd "$left_root"
    "$claude" --plugin-dir "$plugin" --resume "$left_id" -p '/anchor clear' --max-turns 1 --output-format text
  ) > "$work/left-clear-$i.txt" 2>&1 || true
  (
    cd "$right_root"
    "$claude" --plugin-dir "$plugin" --resume "$right_id" -p '/anchor clear' --max-turns 1 --output-format text
  ) > "$work/right-clear-$i.txt" 2>&1 || true
  printf '%s' "$overlap_line"
}

run_case_same_set() {
  local i=$1
  local gate="$work/gate-same-set-$i"
  local same_a same_b
  same_a=$(new_uuid)
  same_b=$(new_uuid)
  rm -rf "$gate"
  pair "$gate" \
    "$same_root" "$same_a" '/anchor same-a goal · check: same-a check' "$work/same-a-set-$i.txt" \
    "$same_root" "$same_b" '/anchor same-b goal · check: same-b check' "$work/same-b-set-$i.txt" \
    first first
  local overlap_line
  overlap_line=$(check_gate "$gate" | tee "$work/gate-same-set-$i.log" | awk '/^overlap /{print $2; found=1} END{if(!found) exit 1}')
  read_fresh "$same_root" "$same_a" "$work/same-a-read-$i.txt"
  read_fresh "$same_root" "$same_b" "$work/same-b-read-$i.txt"
  require "$work/same-a-read-$i.txt" 'same-a goal'
  forbid "$work/same-a-read-$i.txt" 'same-b goal'
  require "$work/same-b-read-$i.txt" 'same-b goal'
  forbid "$work/same-b-read-$i.txt" 'same-a goal'
  (
    cd "$same_root"
    "$claude" --plugin-dir "$plugin" --resume "$same_a" -p '/anchor clear' --max-turns 1 --output-format text
    "$claude" --plugin-dir "$plugin" --resume "$same_b" -p '/anchor clear' --max-turns 1 --output-format text
  ) > "$work/same-set-clear-$i.txt" 2>&1 || true
  printf '%s' "$overlap_line"
}

run_case_same_delete() {
  local i=$1
  local gate="$work/gate-same-delete-$i"
  local same_a same_b
  same_a=$(new_uuid)
  same_b=$(new_uuid)
  # Seed both notes first (sequential), then race set vs clear.
  (
    cd "$same_root"
    "$claude" --plugin-dir "$plugin" --session-id "$same_a" -p '/anchor same-a goal · check: same-a check' --max-turns 1 --output-format text
  ) > "$work/same-a-seed-$i.txt" 2>&1
  (
    cd "$same_root"
    "$claude" --plugin-dir "$plugin" --session-id "$same_b" -p '/anchor same-b goal · check: same-b check' --max-turns 1 --output-format text
  ) > "$work/same-b-seed-$i.txt" 2>&1
  rm -rf "$gate"
  pair "$gate" \
    "$same_root" "$same_a" '/anchor same-a again · check: same-a still' "$work/same-a-replace-$i.txt" \
    "$same_root" "$same_b" '/anchor clear' "$work/same-b-clear-$i.txt" \
    resume resume
  local overlap_line
  overlap_line=$(check_gate "$gate" | tee "$work/gate-same-delete-$i.log" | awk '/^overlap /{print $2; found=1} END{if(!found) exit 1}')
  read_fresh "$same_root" "$same_a" "$work/same-a-after-$i.txt"
  read_fresh "$same_root" "$same_b" "$work/same-b-after-$i.txt"
  require "$work/same-a-after-$i.txt" 'same-a again'
  require "$work/same-a-after-$i.txt" 'same-a still'
  forbid "$work/same-a-after-$i.txt" 'same-b goal'
  require "$work/same-b-after-$i.txt" "/anchor what you're doing · check: what to verify"
  forbid "$work/same-b-after-$i.txt" 'same-b goal'
  forbid "$work/same-b-after-$i.txt" 'same-a again'
  (
    cd "$same_root"
    "$claude" --plugin-dir "$plugin" --resume "$same_a" -p '/anchor clear' --max-turns 1 --output-format text
    "$claude" --plugin-dir "$plugin" --resume "$same_b" -p '/anchor clear' --max-turns 1 --output-format text
  ) > "$work/same-delete-clear-$i.txt" 2>&1 || true
  printf '%s' "$overlap_line"
}

overlap_roots=0
overlap_same_set=0
overlap_same_delete=0

for i in $(seq 1 "$attempts"); do
  say "case roots attempt $i/$attempts"
  o=$(run_case_roots "$i")
  overlap_roots=$((overlap_roots + o))
done
say "overlap roots: ${overlap_roots}/${attempts}"

for i in $(seq 1 "$attempts"); do
  say "case same-set attempt $i/$attempts"
  o=$(run_case_same_set "$i")
  overlap_same_set=$((overlap_same_set + o))
done
say "overlap same-set: ${overlap_same_set}/${attempts}"

for i in $(seq 1 "$attempts"); do
  say "case same-delete attempt $i/$attempts"
  o=$(run_case_same_delete "$i")
  overlap_same_delete=$((overlap_same_delete + o))
done
say "overlap same-delete: ${overlap_same_delete}/${attempts}"

say "real-store-race: isolation passed all ${attempts} attempts per case"
say "overlap summary roots=${overlap_roots}/${attempts} same-set=${overlap_same_set}/${attempts} same-delete=${overlap_same_delete}/${attempts}"
say "workdir $work"
