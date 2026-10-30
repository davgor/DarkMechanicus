#!/bin/bash
# c5: search the recorded Autonomous ACP exchange for the person's identity, then prove the same grep
# finds a planted copy (positive control). Prints labels and counts only, never the searched values.
set -u
WT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
REC="$WT/src/main/agents/adapters/__mocks__/autonomousRecordings.ts"
REPORT="$WT/docs/reports/autonomous-acp.md"
USERNAME_VAL="$(whoami)"
GITNAME_VAL="$(git -C "$WT" config user.name)"
EMAIL_VAL="$(git -C "$WT" config user.email)"
EMAIL_LOCAL_VAL="${EMAIL_VAL%@*}"
HOME_VAL="$HOME"
TMP="$(mktemp -d)"

echo "commit: $(git -C "$WT" rev-parse HEAD)"
for f in "$REC" "$REPORT"; do
  echo "exists: ${f#$WT/} ($(wc -c < "$f" | tr -d ' ') bytes)"
done

check() { # label value file -> prints count of matching lines (case-insensitive fixed string)
  local n
  n=$(grep -c -i -F -- "$2" "$3")
  echo "  $1: $n matching line(s)"
}

for target in "$REC" "$REPORT"; do
  echo "grep -c -i -F <value> ${target#$WT/}"
  check "<user name (whoami)>" "$USERNAME_VAL" "$target"
  check "<git user.name>" "$GITNAME_VAL" "$target"
  check "<email>" "$EMAIL_VAL" "$target"
  check "<email local part>" "$EMAIL_LOCAL_VAL" "$target"
  check "<home path>" "$HOME_VAL" "$target"
done

echo "positive control: a copy of the recording with one planted value each, same grep"
for label in user email home; do
  case $label in
    user) v="$USERNAME_VAL" ;;
    email) v="$EMAIL_VAL" ;;
    home) v="$HOME_VAL/.local/bin/claude" ;;
  esac
  cp "$REC" "$TMP/planted-$label.ts"
  printf '// planted: %s\n' "$v" >> "$TMP/planted-$label.ts"
  case $label in
    user) check "<user name> in planted-$label.ts" "$USERNAME_VAL" "$TMP/planted-$label.ts" ;;
    email) check "<email> in planted-$label.ts" "$EMAIL_VAL" "$TMP/planted-$label.ts" ;;
    home) check "<home path> in planted-$label.ts" "$HOME_VAL" "$TMP/planted-$label.ts" ;;
  esac
done
rm -rf "$TMP"
