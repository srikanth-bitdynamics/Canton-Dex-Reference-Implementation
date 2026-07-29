#!/usr/bin/env bash

# Rejects commit messages carrying assistant attribution or internal chatter.
# This repository is a public reference implementation; its history is read by
# integrators and reviewers, so it carries no tooling artefacts.
#
# Usage: check-commit-hygiene.sh [<base-ref>]   (default: origin/main)

set -euo pipefail

BASE="${1:-origin/main}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "check-commit-hygiene: base ref '$BASE' not found; fetch it first" >&2
  exit 2
fi

RANGE="$BASE..HEAD"
FORBIDDEN='Co-Authored-By:[[:space:]]*Claude|Generated with \[Claude Code\]|🤖|[Cc]laude|[Aa]nthropic'

failed=0
while read -r sha; do
  [[ -z "$sha" ]] && continue
  hits="$(git log -1 --format='%s%n%b' "$sha" | grep -nEi "$FORBIDDEN" || true)"
  if [[ -n "$hits" ]]; then
    failed=1
    echo "✗ $(git log -1 --format='%h %s' "$sha")"
    echo "$hits" | sed 's/^/    /'
  fi
done < <(git rev-list "$RANGE")

if [[ "$failed" -ne 0 ]]; then
  cat >&2 <<'EOF'

Commit messages must not carry assistant attribution.

Remove the offending lines and rewrite the commits, e.g.

  git filter-branch -f --msg-filter \
    'sed -e "/^Co-[Aa]uthored-[Bb]y: Claude/d" -e "/Generated with \[Claude Code\]/d"' \
    origin/main..HEAD

then force-push with --force-with-lease.
EOF
  exit 1
fi

echo "commit messages clean over $RANGE"
