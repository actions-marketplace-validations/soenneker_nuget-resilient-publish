#!/usr/bin/env bash
set -euo pipefail

# Allocate a new integer tag atomically. Concurrent pushes cannot overwrite tags.
VERSION=''
for ATTEMPT in {1..50}; do
  TAGS=$(git ls-remote --tags --refs origin)
  EXISTING=$(awk -v sha="$GITHUB_SHA" '$1 == sha && $2 ~ /^refs\/tags\/v[1-9][0-9]*$/ {sub("refs/tags/", "", $2); print $2}' <<< "$TAGS" | sort -V | tail -n 1)
  if [[ -n "$EXISTING" ]]; then
    VERSION="$EXISTING"
    break
  fi

  LATEST=$(awk '$2 ~ /^refs\/tags\/v[1-9][0-9]*$/ {sub("refs/tags/v", "", $2); print $2}' <<< "$TAGS" | sort -n | tail -n 1)
  CANDIDATE="v$(( ${LATEST:-0} + 1 ))"
  git tag "$CANDIDATE" "$GITHUB_SHA"
  if git push origin "refs/tags/$CANDIDATE"; then
    VERSION="$CANDIDATE"
    break
  fi
  git tag --delete "$CANDIDATE"
  sleep 1
done

if [[ -z "$VERSION" ]]; then
  echo 'Unable to allocate the next version tag.' >&2
  exit 1
fi

# A rerun reuses the tag for this commit and completes any interrupted release.
if IS_DRAFT=$(gh release view "$VERSION" --json isDraft --jq .isDraft 2>/dev/null); then
  if [[ "$IS_DRAFT" == true ]]; then
    gh release edit "$VERSION" --draft=false
  fi
else
  gh release create "$VERSION" --verify-tag --title "$VERSION" --generate-notes
fi

echo "Published [$VERSION]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/tag/$VERSION)." >> "$GITHUB_STEP_SUMMARY"
