#!/usr/bin/env bash
# release.sh — bump version, tag, and push to trigger the Release workflow.
#
# Usage:
#   ./scripts/release.sh patch   # 1.4.0 -> 1.4.1
#   ./scripts/release.sh minor   # 1.4.0 -> 1.5.0
#   ./scripts/release.sh major   # 1.4.0 -> 2.0.0
#   ./scripts/release.sh 1.5.0   # explicit version

set -euo pipefail

BUMP="${1:-}"

if [[ -z "$BUMP" ]]; then
  echo "Usage: $0 <patch|minor|major|x.y.z>"
  exit 1
fi

# Read current version from package.json
CURRENT=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  *.*.*)  NEW_VERSION="$BUMP" ;;
  *)
    echo "Error: invalid bump type '$BUMP'. Use patch, minor, major, or x.y.z."
    exit 1
    ;;
esac

echo "New version: $NEW_VERSION"

# Confirm
read -rp "Create tag v$NEW_VERSION and push? [y/N] " CONFIRM
if [[ "${CONFIRM,,}" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

# Ensure working tree is clean
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Bump version in package.json (cross-platform via node)
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "Updated package.json to $NEW_VERSION"

# Commit, tag, push
git add package.json
git commit -m "release: v$NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin HEAD
git push origin "v$NEW_VERSION"

echo ""
echo "Done! Tag v$NEW_VERSION pushed. The Release workflow will start shortly."
echo "Check: https://github.com/\$(git remote get-url origin | sed 's/.*[:/]\(.*\)\.git/\1/')/actions"
