#!/bin/bash
# DM-149: the full Definition of Done at the sprint 3 tip, one check at a time. Logs and a summary under /tmp/sc-epic/logs.
cd /Users/davidgorden/Documents/GitHub/DarkMechanicus-worktrees/source-control-sprint-3 || exit 1
L=/tmp/sc-epic/logs
TAG=${TAG:-DM-149}
SUM=$L/$TAG-dod-summary.txt
echo "tip $(git rev-parse HEAD) $(date)" > "$SUM"
for c in lint typecheck test coverage deadcode build; do
  if [ $c = test ]; then cmd="npm test"; else cmd="npm run $c"; fi
  start=$(date +%s)
  echo "start $c: $(uptime)" >> "$SUM"
  NO_COLOR=1 $cmd > "$L/$TAG-$c.log" 2>&1
  rc=$?
  echo "$c rc=$rc secs=$(( $(date +%s)-start )) end: $(uptime)" >> "$SUM"
done
echo DONE >> "$SUM"
