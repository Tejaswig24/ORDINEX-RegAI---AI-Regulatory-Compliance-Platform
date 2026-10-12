#!/usr/bin/env node
/**
 * ORDINEX — configure.js
 * Reads .env and:
 *   1. Writes .firebaserc with your project ID
 *   2. Injects firebaseConfig AND geminiConfig into public/ordinex.html
 *
 * NOTE on the Gemini key: this build has no Cloud Functions (Spark/free
 * plan only — see SETUP.md), so there is no server to hold GEMINI_API_KEY
 * as a secret. It gets written directly into public/ordinex.html and
 * shipped to the browser. Restrict the key (HTTP referrer restriction) in
 * Google AI Studio before deploying — see SETUP.md.
 *
 * Safe to re-run any time you change .env.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const HTML_PATH = path.join(ROOT, 'public', 'ordinex.html');
const FIREBASERC_PATH = path.join(ROOT, '.firebaserc');

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

// ---- 1. Load and parse .env ----
if (!fs.existsSync(ENV_PATH)) {
  fail(`No .env file found at ${ENV_PATH}\nRun: cp .env.example .env   then fill in real values.`);
}

const env = {};
fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach((line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  env[key] = value;
});

const REQUIRED_FOR_FRONTEND = [
  'FIREBASE_API_KEY', 'FIREBASE_AUTH_DOMAIN', 'FIREBASE_PROJECT_ID',
  'FIREBASE_MESSAGING_SENDER_ID', 'FIREBASE_APP_ID',
];
const missing = REQUIRED_FOR_FRONTEND.filter((k) => !env[k]);
if (missing.length > 0) {
  fail(`.env is missing values for: ${missing.join(', ')}\nFill these in from Firebase Console -> Project Settings -> General -> Your apps.`);
}
if (!env.GEMINI_API_KEY) {
  console.warn('⚠ GEMINI_API_KEY is not set in .env — AI features (analysis, chat, reports, risk) will not work until you add it and re-run this script.');
}

// ---- 2. Write .firebaserc ----
fs.writeFileSync(
  FIREBASERC_PATH,
  JSON.stringify({ projects: { default: env.FIREBASE_PROJECT_ID } }, null, 2) + '\n'
);
console.log('✓ Wrote .firebaserc with project: ' + env.FIREBASE_PROJECT_ID);

// ---- 3. Inject firebaseConfig + geminiConfig into public/ordinex.html ----
if (!fs.existsSync(HTML_PATH)) {
  fail(`Could not find ${HTML_PATH}`);
}
let html = fs.readFileSync(HTML_PATH, 'utf8');

// firebaseConfig block (idempotent: replaces whatever's currently there)
const fbMatch = html.match(/const firebaseConfig = \{[\s\S]*?\};/);
if (!fbMatch) fail('Could not locate the firebaseConfig block in ordinex.html — the file may have been modified unexpectedly.');
const newFbBlock = `const firebaseConfig = {
  apiKey: "${env.FIREBASE_API_KEY}",
  authDomain: "${env.FIREBASE_AUTH_DOMAIN}",
  projectId: "${env.FIREBASE_PROJECT_ID}",
  storageBucket: "${env.FIREBASE_STORAGE_BUCKET || ''}",
  messagingSenderId: "${env.FIREBASE_MESSAGING_SENDER_ID}",
  appId: "${env.FIREBASE_APP_ID}",
};`;
html = html.replace(/const firebaseConfig = \{[\s\S]*?\};/, newFbBlock);
console.log('✓ Wrote firebaseConfig into public/ordinex.html');

// geminiConfig block (idempotent, same pattern)
const geminiMatch = html.match(/const geminiConfig = \{[\s\S]*?\};/);
if (!geminiMatch) fail('Could not locate the geminiConfig block in ordinex.html — the file may have been modified unexpectedly.');
const newGeminiBlock = `const geminiConfig = {
  apiKey: "${env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY'}",
  model: "gemini-flash-lite-latest",
  modelFast: "gemini-flash-lite-latest",
  embedModel: "gemini-embedding-001",
};`;
html = html.replace(/const geminiConfig = \{[\s\S]*?\};/, newGeminiBlock);
console.log('✓ Wrote geminiConfig into public/ordinex.html');

fs.writeFileSync(HTML_PATH, html);

// ---- 4. Emit a resolved file for deploy.sh to `source` (project id only —
// there's no secret left to hand off, GEMINI_API_KEY already went straight
// into the HTML file above) ----
function shellEscape(value) {
  return "'" + String(value).replace(/'/g, `'\\''`) + "'";
}
fs.writeFileSync(
  path.join(ROOT, '.env.resolved.sh'),
  `FIREBASE_PROJECT_ID=${shellEscape(env.FIREBASE_PROJECT_ID)}\n`
);

console.log('\nDone. The app will run in LIVE mode the next time it loads.');
