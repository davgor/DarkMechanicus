#!/bin/bash
# DM-400 scratch repositories. Re-runnable: wipes and rebuilds everything under $S except the setup files.
set -euo pipefail
S=/private/tmp/sc-epic/scratch/DM-400
cd "$S"
rm -rf c1-origin.git c1-seed scratch-pull scratch-symlink scratch-stash
export GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=t@e.st GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=t@e.st
init() { git init -q -b main "$1"; git -C "$1" config user.name Tester; git -C "$1" config user.email t@e.st; git -C "$1" config core.autocrlf false; git -C "$1" config rerere.enabled false; }

# c1: scratch-pull and its origin both edit c.txt (pull conflicts); origin is served through slow-upload-pack.sh.
git init -q --bare -b main c1-origin.git
git clone -q c1-origin.git c1-seed 2>/dev/null
git -C c1-seed config user.name Tester; git -C c1-seed config user.email t@e.st
echo base > c1-seed/c.txt && git -C c1-seed add -A && git -C c1-seed commit -qm Base && git -C c1-seed push -q origin main
git clone -q c1-origin.git scratch-pull
git -C scratch-pull config user.name Tester; git -C scratch-pull config user.email t@e.st
echo theirs > c1-seed/c.txt && git -C c1-seed commit -qam 'Origin edits c' && git -C c1-seed push -q origin main
echo mine > scratch-pull/c.txt && git -C scratch-pull commit -qam 'Local edits c'
echo 'ready to commit' > scratch-pull/notes.txt   # untracked file to commit while the pull runs
git -C scratch-pull config protocol.ext.allow always
git -C scratch-pull remote set-url origin "ext::$S/slow-upload-pack.sh %S $S/c1-origin.git"
SLOW_SECONDS=0 git -C scratch-pull fetch -q   # so the app offers "Pull origin ↓1 ↑1"

# c2: a committed symlink l -> /
init scratch-symlink
echo hi > scratch-symlink/README.md && ln -s / scratch-symlink/l
git -C scratch-symlink add -A && git -C scratch-symlink commit -qm 'Readme and l -> /'

# c3: stash restore conflict on s.txt (stashed edit vs a later commit)
init scratch-stash
echo base > scratch-stash/s.txt && git -C scratch-stash add -A && git -C scratch-stash commit -qm Base
echo 'stashed content' > scratch-stash/s.txt && git -C scratch-stash stash push -q -m 'stashed edit'
echo 'committed content' > scratch-stash/s.txt && git -C scratch-stash commit -qam 'Commit edits s'
git -C scratch-stash stash pop >/dev/null 2>&1 || true

echo SETUP-DONE
