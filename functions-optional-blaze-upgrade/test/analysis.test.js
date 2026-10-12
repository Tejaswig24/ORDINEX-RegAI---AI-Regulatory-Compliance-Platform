/**
 * Real, runnable unit tests using Node's built-in test runner (no extra
 * dependency needed — ships with Node 18+, and functions/package.json
 * already pins Node 20).
 *
 * Scope, honestly: this covers the pure, side-effect-free helpers only
 * (safeJsonParse, isPlausibleEmail). The Cloud Functions themselves
 * (chatWithAssistant, generateReport, onDocumentUploaded, etc.) call
 * Gemini, Firestore, and Storage directly and are NOT covered here —
 * testing those properly needs the Firebase emulator suite (firebase
 * emulators:start) plus firebase-functions-test, which needs network
 * access to download emulator binaries that this sandbox doesn't have.
 * That's a real gap, not a rounding error — see SETUP.md.
 *
 * Run with: npm test  (from functions/)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// index.js calls admin.initializeApp() at module load time, which throws
// without a project/bucket configured. These env vars give it enough to
// initialize without needing real GCP credentials — no network call is
// made unless a test actually invokes a Firestore/Storage/Auth method,
// which these tests deliberately don't.
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ storageBucket: 'test.appspot.com', projectId: 'test-project' });
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';

const { safeJsonParse, isPlausibleEmail, cosineSimilarity, checkRateWindow } = require('../index.js')._testables;

test('safeJsonParse: parses valid JSON', () => {
  const result = safeJsonParse('{"score": 82, "gaps": []}', { score: null, gaps: [] });
  assert.equal(result.score, 82);
  assert.deepEqual(result.gaps, []);
});

test('safeJsonParse: falls back on invalid JSON instead of throwing', () => {
  const raw = 'Sure, here is the analysis: {score: 82} (not valid JSON)';
  const result = safeJsonParse(raw, { score: null, gaps: [] });
  assert.equal(result.score, null);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.rawResponse, raw); // original text preserved for debugging, not silently dropped
});

test('safeJsonParse: falls back on empty string', () => {
  const result = safeJsonParse('', { score: null, gaps: [] });
  assert.equal(result.score, null);
});

test('safeJsonParse: does not mutate the fallback object it was given', () => {
  const fallback = { score: null, gaps: [] };
  safeJsonParse('not json', fallback);
  assert.deepEqual(fallback, { score: null, gaps: [] }); // no rawResponse leaked onto the caller's object
});

test('isPlausibleEmail: accepts well-formed addresses', () => {
  assert.equal(isPlausibleEmail('sarah.chen@techcorp.com'), true);
  assert.equal(isPlausibleEmail('a@b.co'), true);
});

test('isPlausibleEmail: rejects missing @ or domain', () => {
  assert.equal(isPlausibleEmail('not-an-email'), false);
  assert.equal(isPlausibleEmail('missing-domain@'), false);
  assert.equal(isPlausibleEmail('@missing-local.com'), false);
});

test('isPlausibleEmail: rejects non-string input rather than throwing', () => {
  assert.equal(isPlausibleEmail(undefined), false);
  assert.equal(isPlausibleEmail(null), false);
  assert.equal(isPlausibleEmail(12345), false);
});

test('isPlausibleEmail: rejects whitespace inside the address', () => {
  assert.equal(isPlausibleEmail('sarah chen@techcorp.com'), false);
});

test('cosineSimilarity: identical vectors score 1', () => {
  const v = [1, 2, 3];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
});

test('cosineSimilarity: orthogonal vectors score 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
});

test('cosineSimilarity: opposite vectors score -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2], [-1, -2]) - (-1)) < 1e-9);
});

test('cosineSimilarity: mismatched lengths return 0 instead of throwing', () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
});

test('cosineSimilarity: missing/non-array input returns 0 instead of throwing', () => {
  assert.equal(cosineSimilarity(null, [1, 2]), 0);
  assert.equal(cosineSimilarity(undefined, undefined), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test('cosineSimilarity: zero vector returns 0 instead of NaN (division by zero)', () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test('cosineSimilarity: ranks a closer vector above a farther one (the actual retrieval use case)', () => {
  const query = [1, 0, 0];
  const closeDoc = [0.9, 0.1, 0];
  const farDoc = [0, 1, 0];
  assert.ok(cosineSimilarity(query, closeDoc) > cosineSimilarity(query, farDoc));
});

test('checkRateWindow: allows requests under the limit', () => {
  const now = 1_000_000;
  const result = checkRateWindow([], now, 60000, 3);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.timestamps, [now]);
});

test('checkRateWindow: blocks the request once the limit is hit within the window', () => {
  const now = 1_000_000;
  const recent = [now - 1000, now - 2000, now - 3000]; // 3 requests already, limit is 3
  const result = checkRateWindow(recent, now, 60000, 3);
  assert.equal(result.allowed, false);
  assert.ok(result.retryAfterMs > 0);
});

test('checkRateWindow: old requests outside the window do not count against the limit', () => {
  const now = 1_000_000;
  const recent = [now - 120000]; // 2 minutes ago, outside a 1-minute window
  const result = checkRateWindow(recent, now, 60000, 1);
  assert.equal(result.allowed, true); // the stale timestamp aged out, so this one request is allowed
  assert.deepEqual(result.timestamps, [now]); // stale entry dropped, not carried forward
});

test('checkRateWindow: retryAfterMs reflects when the oldest request ages out', () => {
  const now = 1_000_000;
  const recent = [now - 50000]; // 50s ago, in a 60s window, limit 1
  const result = checkRateWindow(recent, now, 60000, 1);
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterMs, 10000); // ages out in 10 more seconds
});
