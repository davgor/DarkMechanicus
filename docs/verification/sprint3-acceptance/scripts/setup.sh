#!/bin/bash
# DM-149 scratch repositories. Re-runnable: wipes and rebuilds everything under $S except setup files.
set -euo pipefail
S=/private/tmp/sc-epic/scratch/DM-149
cd "$S"
rm -rf scratch-stall2 clones scratch-c origin-c.git scratch-gh push-sink.git scratch-lines scratch-sel scratch-rebase scratch-pathspec scratch-merge scratch-stall
export GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=t@e.st GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=t@e.st
init() { git init -q -b main "$1"; git -C "$1" config user.name Tester; git -C "$1" config user.email t@e.st; git -C "$1" config core.autocrlf false; git -C "$1" config rerere.enabled false; }

mkdir clones

# scratch-c: origin is a local bare repo holding refs/pull/1/head (a commit no local branch has)
init scratch-c
echo 'hello' > scratch-c/README.md && git -C scratch-c add -A && git -C scratch-c commit -qm 'Initial commit'
git init -q --bare -b main origin-c.git
git -C scratch-c remote add origin "$S/origin-c.git"
git -C scratch-c push -q -u origin main
git -C scratch-c switch -qc contributor
echo 'from a fork' > scratch-c/fork.txt && git -C scratch-c add -A && git -C scratch-c commit -qm 'Fork change for pull request 1'
git -C scratch-c push -q origin contributor:refs/pull/1/head
git -C scratch-c switch -q main && git -C scratch-c branch -qD contributor

# scratch-gh: origin https://github.com/octocat/Hello-World.git, an unpublished local branch, pushes go to a local bare repo
git clone -q https://github.com/octocat/Hello-World.git scratch-gh
git -C scratch-gh config user.name Tester; git -C scratch-gh config user.email t@e.st
git init -q --bare push-sink.git
git -C scratch-gh config remote.origin.pushurl "$S/push-sink.git"
git -C scratch-gh switch -qc feature-unpublished
echo 'unpublished' > scratch-gh/unpublished.txt && git -C scratch-gh add -A && git -C scratch-gh commit -qm 'Add unpublished file'

# scratch-lines (c5): notes.txt (LF) and crlf.txt (CRLF), 20 lines each; then 5 changed lines over two hunks each
init scratch-lines
for f in notes.txt crlf.txt; do
  eol=$'\n'; [ $f = crlf.txt ] && eol=$'\r\n'
  : > scratch-lines/$f; for i in $(seq 1 20); do printf "line %s%s" $i "$eol" >> scratch-lines/$f; done
done
git -C scratch-lines add -A && git -C scratch-lines commit -qm 'Twenty lines'
for f in notes.txt crlf.txt; do
  eol=$'\n'; [ $f = crlf.txt ] && eol=$'\r\n'
  : > scratch-lines/$f.new
  for i in $(seq 1 20); do
    if [ $i = 3 ]; then printf "A1 new third line%s" "$eol" >> scratch-lines/$f.new; continue; fi   # -line 3 +A1
    printf "line %s%s" $i "$eol" >> scratch-lines/$f.new
    if [ $i = 17 ]; then printf "B1 added%sB2 added%sB3 added%s" "$eol" "$eol" "$eol" >> scratch-lines/$f.new; fi
  done
  mv scratch-lines/$f.new scratch-lines/$f
done

# scratch-sel (c6): one file with changes in two hunks
init scratch-sel
for i in $(seq 1 20); do echo "row $i"; done > scratch-sel/list.txt
git -C scratch-sel add -A && git -C scratch-sel commit -qm 'List'
{ for i in $(seq 1 20); do [ $i = 2 ] && echo 'X1 inserted' && echo 'X2 inserted'; echo "row $i"; [ $i = 18 ] && echo 'Y1 inserted' && echo 'Y2 inserted'; done; true; } > scratch-sel/list.txt

# scratch-rebase (c12): `git rebase -r` stopped at a conflicting merge (MERGE_HEAD and rebase-merge/ both exist)
init scratch-rebase
R=scratch-rebase
echo base > $R/a.txt && git -C $R add -A && git -C $R commit -qm Base
git -C $R branch side && git -C $R branch feature
echo 'main only' > $R/b.txt && git -C $R add -A && git -C $R commit -qm 'Main moves on'
git -C $R switch -q side && echo side > $R/a.txt && git -C $R commit -qam 'Side edits a'
git -C $R switch -q feature && echo feature > $R/a.txt && git -C $R commit -qam 'Feature edits a'
git -C $R merge -q side >/dev/null 2>&1 || true
echo resolved > $R/a.txt && git -C $R add a.txt && git -C $R commit -q --no-edit
git -C $R rebase -r main >/dev/null 2>&1 || true

# scratch-pathspec (c13): files ':/a' and 'a', both changed
init scratch-pathspec
P=scratch-pathspec
mkdir "$P/:" && echo one > "$P/:/a" && echo one > $P/a
git -C $P add -A && git -C $P commit -qm 'Two files'
echo two > "$P/:/a" && echo two > $P/a

# scratch-merge (c14): main and feature/conflict both edit c.txt
init scratch-merge
M=scratch-merge
echo base > $M/c.txt && git -C $M add -A && git -C $M commit -qm Base
git -C $M switch -qc feature/conflict && echo theirs > $M/c.txt && git -C $M commit -qam 'Theirs edits c'
git -C $M switch -q main && echo mine > $M/c.txt && git -C $M commit -qam 'Mine edits c'

# scratch-stall (c15): origin is an ext:: helper that prints nothing and never answers
init scratch-stall
echo x > scratch-stall/x.txt && git -C scratch-stall add -A && git -C scratch-stall commit -qm X
git -C scratch-stall config protocol.ext.allow always
git -C scratch-stall remote add origin "ext::$S/stall.sh"
git -C scratch-stall config branch.main.remote origin && git -C scratch-stall config branch.main.merge refs/heads/main

# scratch-stall2 (c15 variant): the helper prints one stderr line before it stalls, so git has a detail line
init scratch-stall2
echo x > scratch-stall2/x.txt && git -C scratch-stall2 add -A && git -C scratch-stall2 commit -qm X
git -C scratch-stall2 config protocol.ext.allow always
git -C scratch-stall2 remote add origin "ext::$S/stall2.sh"
git -C scratch-stall2 config branch.main.remote origin && git -C scratch-stall2 config branch.main.merge refs/heads/main

echo SETUP-DONE
