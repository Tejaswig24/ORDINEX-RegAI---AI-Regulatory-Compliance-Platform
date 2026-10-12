#!/usr/bin/env bash
# ORDINEX — one-command deploy.
# Runs configure.js, then deploys Firestore rules/indexes + Hosting to your
# Firebase project. Spark (free) plan only — no Cloud Functions, no Cloud
# Storage, nothing that requires the Blaze plan or a billing card.
set -euo pipefail
cd "$(dirname "$0")/.."

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
step() { echo -e "\n${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
die()  { echo -e "${RED}✗ $1${NC}"; exit 1; }

# ---- 0. Pre-flight checks ----
step "Checking prerequisites"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Install it from https://nodejs.org first."
command -v firebase >/dev/null 2>&1 || die "Firebase CLI is not installed. Run: npm install -g firebase-tools"

if [ ! -f .env ]; then
  die ".env not found. Run: cp .env.example .env   then fill in real values, and re-run this script."
fi

if ! firebase projects:list >/dev/null 2>&1; then
  die "Not logged in to Firebase (or no access). Run: firebase login   then re-run this script."
fi
echo "  Node, Firebase CLI, and Firebase login all OK."

# ---- 1. Inject config into the frontend + .firebaserc ----
step "Configuring project (writing .firebaserc and public/ordinex.html)"
node scripts/configure.js

[ -f .env.resolved.sh ] || die "configure.js did not produce .env.resolved.sh — check its output above for errors."
# shellcheck disable=SC1091
source .env.resolved.sh
rm -f .env.resolved.sh

[ -n "${FIREBASE_PROJECT_ID:-}" ] || die "FIREBASE_PROJECT_ID is empty in .env"

# ---- 2. Select the Firebase project ----
step "Selecting Firebase project: $FIREBASE_PROJECT_ID"
firebase use "$FIREBASE_PROJECT_ID" || die "Could not select project '$FIREBASE_PROJECT_ID'. Does it exist and do you have access? (Make sure the project is still on the Spark plan, or Blaze if you chose to upgrade.)"

# ---- 3. Deploy everything this build needs — rules, indexes, hosting.
#         No 'functions' or 'storage' targets: this build doesn't use
#         either, so it never asks Firebase to touch anything that would
#         require the Blaze plan. ----
step "Deploying to Firebase (Firestore rules/indexes + Hosting) — usually under a minute"
firebase deploy --only firestore:rules,firestore:indexes,hosting

echo -e "\n${GREEN}✓ Deployment complete.${NC}"
echo "  Your app is live at: https://${FIREBASE_PROJECT_ID}.web.app"
echo "  (Or just open public/ordinex.html directly — it's already configured for live mode.)"
echo ""
echo "  Reminder: restrict your Gemini API key to your site's domain(s) in"
echo "  Google AI Studio if you haven't already — see SETUP.md."
