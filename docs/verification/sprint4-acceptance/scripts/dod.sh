#!/bin/bash
# DM-400: the full Definition of Done at the sprint 4 tip, one check at a time. Logs and a summary under /tmp/sc-epic/logs.
# CHECKS overrides the list (for example CHECKS="test" to rerun one check).
cd /Users/davidgorden/Documents/GitHub/DarkMechanicus-worktrees/source-control-sprint-4 || exit 1
L=/tmp/sc-epic/logs
TAG=${TAG:-DM-400}
SUM=$L/$TAG-dod-summary.txt
echo "tip $(git rev-parse HEAD) $(date)" > "$SUM"
for c in ${CHECKS:-lint typecheck test coverage deadcode build}; do
  if [ $c = test ]; then cmd="npm test"; else cmd="npm run $c"; fi
  start=$(date +%s)
  echo "start $c: $(uptime)" >> "$SUM"
  NO_COLOR=1 $cmd > "$L/$TAG-$c.txt" 2>&1
  rc=$?
  echo "$c rc=$rc secs=$(( $(date +%s)-start )) end: $(uptime)" >> "$SUM"
done
echo DONE >> "$SUM"
