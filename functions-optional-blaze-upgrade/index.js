/**
 * ORDINEX — Cloud Functions (2nd gen)
 * ============================================================
 * This is the real backend: Firebase Auth triggers, Firestore-backed
 * services, Storage-triggered document processing, and Gemini-backed
 * AI services (compliance analysis, risk assessment, report generation,
 * and the AI assistant chat).
 *
 * SETUP (see ../SETUP.md for the full walkthrough):
 *   1. cd functions && npm install
 *   2. firebase functions:secrets:set GEMINI_API_KEY
 *   3. firebase deploy --only functions
 *
 * Get a Gemini API key at https://aistudio.google.com/apikey
 * Verify the current model name there too — model names change over
 * time, so GEMINI_MODEL / GEMINI_MODEL_FAST below are configurable
 * rather than hardcoded assumptions.
 * ============================================================
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { defineSecret } = require('firebase-functions/params');
const functionsV1 = require('firebase-functions/v1');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();
// NOTE: admin.storage().bucket() is resolved lazily inside
// onDocumentUploaded() rather than here at module load time —
// calling it eagerly means any bucket-config issue would prevent
// ALL functions in this file from loading, not just this one.

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

// Configurable model names — check https://aistudio.google.com for current
// model IDs available to your API key before deploying.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const GEMINI_MODEL_FAST = process.env.GEMINI_MODEL_FAST || 'gemini-flash-lite-latest';
const GEMINI_EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';

// Multilingual (English + Kannada) embedding settings.
const EMBED_DIM = 768;            // keep constant: vectors of different sizes can't be compared
const EMBED_BATCH = 50;           // texts per batchEmbedContents call
const SUPPORTED_LANGS = ['en', 'kn'];

/* ============================================================
   SHARED HELPERS
   ============================================================ */

/**
 * Gets a real embedding vector for a piece of text via Gemini's embedding
 * API. This is what makes RAG in chatWithAssistant "real" retrieval
 * instead of "last 5 documents" — no separate vector database (ChromaDB,
 * Pinecone, etc.) needs to be deployed; the vectors are just stored as a
 * float array field on each document and compared with plain cosine
 * similarity in cosineSimilarity() below. That's brute-force, not an
 * indexed ANN search, so it's the right call for tens-to-low-hundreds of
 * documents per org, not millions — see the note in chatWithAssistant.
 */
function l2Normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** taskType: 'RETRIEVAL_DOCUMENT' for stored text, 'RETRIEVAL_QUERY' for questions.
 * Returns an L2-normalized EMBED_DIM vector, or null if the API call fails. */
async function embedText(text, taskType = 'RETRIEVAL_DOCUMENT') {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'GEMINI_API_KEY secret is not configured. See SETUP.md.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:embedContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: String(text).slice(0, 4000) }] },
      taskType,
      outputDimensionality: EMBED_DIM,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    logger.error('Gemini embedding API error', { status: res.status, errText });
    return null; // embedding is an enhancement, not a hard requirement — callers fall back gracefully
  }
  const json = await res.json();
  return json.embedding?.values ? l2Normalize(json.embedding.values) : null;
}

/** Embeds many texts in batches. Returns an array of vectors, or null if any batch fails. */
async function embedMany(texts, taskType = 'RETRIEVAL_DOCUMENT') {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) throw new HttpsError('failed-precondition', 'GEMINI_API_KEY secret is not configured. See SETUP.md.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBED_MODEL}:batchEmbedContents?key=${apiKey}`;
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: batch.map((t) => ({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text: String(t).slice(0, 4000) }] },
          taskType,
          outputDimensionality: EMBED_DIM,
        })),
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error('Gemini batch embedding error', { status: res.status, errText });
      return null;
    }
    const json = await res.json();
    if (!json.embeddings || json.embeddings.length !== batch.length) return null;
    out.push(...json.embeddings.map((e) => l2Normalize(e.values)));
  }
  return out;
}

/** Pure, side-effect-free: standard cosine similarity between two equal-
 * length numeric vectors. Returns 0 for mismatched/missing input rather
 * than throwing, so a document with no embedding just sorts last instead
 * of crashing retrieval for the whole org. See functions/test/analysis.test.js. */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; magA += a[i] * a[i]; magB += b[i] * b[i]; }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* ============================================================
   LANGUAGE (English + Kannada) AND CHUNKING HELPERS
   Pure, side-effect-free functions — see functions/test/.
   ============================================================ */

function normalizeText(t) {
  // Keep ZWJ/ZWNJ (U+200D/U+200C): they matter for Kannada conjuncts.
  return String(t || '')
    .normalize('NFC')
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Share of letters/marks that are Kannada (U+0C80–U+0CFF). */
function kannadaRatio(text) {
  const letters = String(text || '').match(/[\p{L}\p{M}]/gu) || [];
  if (!letters.length) return 0;
  const kn = letters.filter((ch) => /[\u0C80-\u0CFF]/.test(ch)).length;
  return kn / letters.length;
}

function detectLang(text) { return kannadaRatio(text) >= 0.3 ? 'kn' : 'en'; }

/** True when PDF text extraction clearly failed: empty/scanned, or legacy-font
 * Kannada (Nudi/Baraha) which extracts as Latin-1 junk. */
function looksGarbled(text) {
  const s = String(text || '').replace(/\s/g, '');
  if (s.length < 50) return true;
  const junk = (s.match(/[\u0080-\u00FF\uFFFD]/g) || []).length;
  return junk / s.length > 0.15;
}

function splitLong(p, max) {
  const sentences = p.split(/(?<=[.!?।])\s+/);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > max) {
      if (cur) { out.push(cur); cur = ''; }
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(' ', max);
        if (cut < max * 0.5) cut = max;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).trim();
      }
      cur = rest;
    } else if (cur && (cur.length + 1 + s.length) > max) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** ~900-char chunks (Kannada is token-heavy), split on paragraph/sentence boundaries. */
function chunkText(text, max = 900, maxChunks = 200) {
  const units = normalizeText(text)
    .split(/\n\s*\n/)
    .flatMap((p) => (p.length <= max ? [p] : splitLong(p, max)));
  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (cur && (cur.length + 2 + u.length) > max) { chunks.push(cur); cur = u; }
    else cur = cur ? `${cur}\n\n${u}` : u;
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length >= 20).slice(0, maxChunks);
}

function meanVector(vectors) {
  if (!vectors.length) return null;
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return l2Normalize(out);
}

/** requested: 'en' | 'kn' | 'auto' (= same language as the document). */
function resolveOutputLang(requested, detected) {
  if (requested === 'auto') return detected === 'kn' ? 'kn' : 'en';
  return SUPPORTED_LANGS.includes(requested) ? requested : 'en';
}

function langInstruction(lang) {
  return lang === 'kn'
    ? 'Write all human-readable text values (titles, descriptions, evidence, recommendations, summaries) in Kannada (ಕನ್ನಡ). Keep JSON keys and fixed values (High/Medium/Low, covered/partial/gap, domain names) in English exactly as specified.'
    : 'Write all human-readable text values in English.';
}

/** Pure, side-effect-free: parses a JSON string, returning `fallback` (with
 * rawResponse attached) if parsing fails. Gemini is asked for JSON output
 * but LLMs occasionally wrap it in prose or markdown fences regardless, so
 * every call site needs this same fallback — pulled out once so it has
 * one real, tested implementation instead of three copies that could drift.
 * See functions/test/analysis.test.js. */
function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return { ...fallback, rawResponse: raw };
  }
}

/** Pure, side-effect-free: validates an email address is at least
 * plausibly well-formed. Deliberately permissive (this is a UX sanity
 * check, not the source of truth for deliverability) — see
 * functions/test/analysis.test.js. */
function isPlausibleEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Pure, side-effect-free: given a list of past request timestamps (ms)
 * and a window, returns whether a new request is allowed and how many ms
 * until the oldest one ages out if not. No Firestore/network involved —
 * see functions/test/analysis.test.js. */
function checkRateWindow(recentTimestamps, now, windowMs, maxRequests) {
  const inWindow = (recentTimestamps || []).filter((t) => now - t < windowMs);
  if (inWindow.length < maxRequests) {
    return { allowed: true, timestamps: [...inWindow, now] };
  }
  const oldest = Math.min(...inWindow);
  return { allowed: false, retryAfterMs: windowMs - (now - oldest), timestamps: inWindow };
}

/**
 * Firestore-backed rate limit for expensive (Gemini-calling) callable
 * functions. Not a full production rate limiter (Cloud Armor / App Check
 * would enforce this before the function even runs, at the network edge)
 * but a real, working per-user cap that costs nothing extra to deploy —
 * no new infrastructure, just a small doc per user+function.
 */
async function enforceRateLimit(uid, bucket, { maxRequests, windowMs }) {
  const ref = db.collection('rateLimits').doc(`${uid}_${bucket}`);
  const snap = await ref.get();
  const now = Date.now();
  const result = checkRateWindow(snap.exists ? snap.data().timestamps : [], now, windowMs, maxRequests);
  if (!result.allowed) {
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    throw new HttpsError('resource-exhausted', `Too many requests — try again in ${seconds}s.`);
  }
  await ref.set({ timestamps: result.timestamps }, { merge: true });
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to call this function.');
  }
  return request.auth;
}

async function requireOrgMembership(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists || !userSnap.data().organizationId) {
    throw new HttpsError('failed-precondition', 'You must belong to an organization to do this.');
  }
  return userSnap.data();
}

async function writeAuditLog({ organizationId, actorUid, action, target, status = 'success', metadata = {} }) {
  await db.collection('auditLogs').add({
    organizationId,
    actorUid,
    action,
    target,
    status,
    metadata,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Minimal Gemini REST wrapper. No SDK dependency — plain fetch against
 * the public Generative Language API, matching Google's documented
 * request/response shape as of this writing.
 */
async function callGemini({ prompt, systemInstruction, model = GEMINI_MODEL, jsonOutput = false, imageBuffer = null, imageMimeType = null, maxOutputTokens = 8192 }) {
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY secret is not configured. See SETUP.md.');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];
  if (imageBuffer && imageMimeType) {
    parts.unshift({ inlineData: { mimeType: imageMimeType, data: imageBuffer.toString('base64') } });
  }

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens,
      ...(jsonOutput ? { responseMimeType: 'application/json' } : {}),
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error('Gemini API error', { status: res.status, errText });
    throw new HttpsError('internal', `AI service error (${res.status}). Check GEMINI_MODEL is valid for your API key.`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    logger.warn('Gemini returned no text', { json });
  }
  return text;
}

/** Best-effort text extraction. PDFs and DOCX are parsed with well-known
 * libraries; images (scans/photos) are transcribed via Gemini's vision
 * capability — no separate OCR service or API needs to be enabled, it
 * reuses the same GEMINI_API_KEY secret already configured for analysis.
 * Anything else is treated as plain text. */
async function extractText(buffer, contentType, fileName) {
  try {
    if (contentType === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      let text = '';
      try { text = (await pdfParse(buffer)).text; } catch (e) { logger.warn('pdf-parse failed', { fileName, err: e.message }); }
      if (!looksGarbled(text)) return text;
      // Scanned PDF, or a Kannada PDF in a legacy font (Nudi/Baraha): let Gemini read it directly.
      if (buffer.length > 15 * 1024 * 1024) return text; // too big to send inline
      const transcribed = await callGemini({
        prompt: 'Transcribe all text in this document exactly as written, in its original language and script (Kannada, English or mixed). Do not translate, summarize or add commentary. Separate paragraphs with a blank line.',
        model: GEMINI_MODEL_FAST,
        imageBuffer: buffer,
        imageMimeType: 'application/pdf',
        maxOutputTokens: 16384, // lower to 8192 if your model rejects this value
      });
      return transcribed || text;
    }
    if (
      contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      fileName.toLowerCase().endsWith('.docx')
    ) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    const lowerName = fileName.toLowerCase();
    const looksLikeImage = IMAGE_TYPES.includes(contentType) || /\.(jpe?g|png|webp|heic|heif)$/.test(lowerName);
    if (looksLikeImage) {
      const mimeType = IMAGE_TYPES.includes(contentType) ? contentType
        : lowerName.endsWith('.png') ? 'image/png'
        : lowerName.endsWith('.webp') ? 'image/webp'
        : 'image/jpeg';
      const transcribed = await callGemini({
        prompt: 'Transcribe every word of readable text in this image exactly as it appears, in reading order. Output ONLY the transcribed text — no commentary, no description of the image, no markdown. If there is no readable text, output nothing.',
        model: GEMINI_MODEL_FAST,
        imageBuffer: buffer,
        imageMimeType: mimeType,
      });
      return transcribed || '';
    }
    // txt / csv / anything else readable as plain text
    return buffer.toString('utf8');
  } catch (err) {
    logger.error('Text extraction failed', { fileName, err: err.message });
    return '';
  }
}

/**
 * Shared compliance-analysis call: given extracted document text, asks
 * Gemini to classify domain, score, and gaps. Used both by the automatic
 * on-upload pipeline and by manual/bulk re-analysis.
 */
async function runComplianceAnalysis(text, outputLang = 'en') {
  const prompt = `You are a regulatory compliance analyst. The document may be in English, Kannada, or both. Analyze the following document text and:
1. Identify which regulatory domain it most likely relates to (Data Privacy, Finance, HR, Cybersecurity, or Corporate Governance).
2. Give an overall compliance score from 0-100 based on how well the content reflects sound compliance practice.
3. List up to 5 specific gaps or risks found, each with a severity of High, Medium, or Low.
${langInstruction(outputLang)}
Respond ONLY as JSON in this exact shape:
{"domain":"...","score":0,"gaps":[{"title":"...","severity":"High","description":"..."}]}

DOCUMENT TEXT:
"""
${text.slice(0, 15000)}
"""`;

  const raw = await callGemini({ prompt, model: GEMINI_MODEL, jsonOutput: true });
  return safeJsonParse(raw, { domain: 'Unclassified', score: null, gaps: [] });
}

/**
 * Splits text into chunks, embeds each (English or Kannada — same model), stores
 * them under documents/{id}/chunks, and returns a whole-document vector (mean of
 * chunk vectors) used for coarse retrieval. Best-effort: on embedding failure it
 * returns embedding: null and the caller still saves the analysis.
 */
async function storeDocumentChunks(docRef, sourceText) {
  const lang = detectLang(sourceText);
  const chunks = chunkText(sourceText);
  const vectors = chunks.length ? await embedMany(chunks, 'RETRIEVAL_DOCUMENT') : null;
  if (!vectors || vectors.length !== chunks.length) return { lang, embedding: null, chunkCount: 0 };

  const old = await docRef.collection('chunks').listDocuments();
  for (let i = 0; i < old.length; i += 400) {
    const b = db.batch();
    old.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
  for (let i = 0; i < chunks.length; i += 400) {
    const b = db.batch();
    chunks.slice(i, i + 400).forEach((text, j) => {
      const idx = i + j;
      b.set(docRef.collection('chunks').doc(String(idx).padStart(4, '0')), { idx, text, embedding: vectors[idx] });
    });
    await b.commit();
  }
  return { lang, embedding: meanVector(vectors), chunkCount: chunks.length };
}

/**
 * Writes an analysis result to a document and fans out its High-severity
 * gaps as complianceIssues. If this document already has open issues from
 * a previous analysis (re-analysis case), those are closed out first so
 * re-running analysis doesn't pile up duplicate issues over time.
 */
async function applyAnalysisResult({ docRef, docId, orgId, fileName, analysis, actorUid, domainOverride, sourceText, outputLang = 'en' }) {
  // Embedding is best-effort: a transient embedding-API failure never blocks
  // the analysis itself from being saved.
  const idx = sourceText ? await storeDocumentChunks(docRef, sourceText) : null;

  await docRef.set(
    {
      status: 'analyzed',
      domain: domainOverride || analysis.domain || 'Unclassified', // user's explicit choice wins over the AI's guess
      score: typeof analysis.score === 'number' ? analysis.score : null,
      gaps: analysis.gaps || [],
      analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
      lang: idx?.lang || 'en',
      outputLang,
      ...(idx?.embedding
        ? { embedding: idx.embedding, chunkCount: idx.chunkCount, embedModel: `${GEMINI_EMBED_MODEL}@${EMBED_DIM}` }
        : {}),
    },
    { merge: true }
  );

  // Superseded issues from a prior run of this same document get marked
  // Resolved (not deleted — deleting would erase the audit trail of what
  // was previously flagged) before the fresh set is opened below.
  const staleSnap = await db.collection('complianceIssues')
    .where('documentId', '==', docId)
    .where('status', '==', 'Open')
    .get();
  const batch = db.batch();
  staleSnap.docs.forEach((d) => batch.update(d.ref, { status: 'Resolved', resolvedAt: admin.firestore.FieldValue.serverTimestamp(), resolvedReason: 'superseded-by-reanalysis' }));

  (analysis.gaps || [])
    .filter((g) => g.severity === 'High')
    .forEach((g) => {
      const issueRef = db.collection('complianceIssues').doc();
      batch.set(issueRef, {
        organizationId: orgId,
        documentId: docId,
        title: g.title,
        description: g.description || '',
        severity: g.severity,
        status: 'Open',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  await batch.commit();

  await writeAuditLog({ organizationId: orgId, actorUid, action: 'Document analyzed', target: fileName });
}

/* ============================================================
   AUTH TRIGGERS
   ============================================================ */

/** Creates the /users/{uid} profile document the moment someone signs up. */
exports.onUserCreate = functionsV1.auth.user().onCreate(async (user) => {
  await db.collection('users').doc(user.uid).set({
    uid: user.uid,
    email: user.email || null,
    displayName: user.displayName || (user.email ? user.email.split('@')[0] : 'New User'),
    photoURL: user.photoURL || null,
    role: null, // assigned once they create/join an organization
    organizationId: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});

/** Clean up the profile doc when a user is deleted. */
exports.onUserDelete = functionsV1.auth.user().onDelete(async (user) => {
  await db.collection('users').doc(user.uid).delete();
});

/* ============================================================
   ORGANIZATION MANAGEMENT
   ============================================================ */

exports.createOrganization = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const { name, plan = 'starter' } = request.data || {};
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    throw new HttpsError('invalid-argument', 'Organization name is required.');
  }

  const orgRef = db.collection('organizations').doc();
  await orgRef.set({
    name: name.trim(),
    plan,
    seats: plan === 'enterprise' ? 999 : plan === 'professional' ? 25 : 5,
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('users').doc(uid).update({
    organizationId: orgRef.id,
    role: 'admin',
  });

  // Custom claims let Storage Rules and the client check org/role
  // without an extra Firestore read on every request.
  await auth.setCustomUserClaims(uid, { orgId: orgRef.id, role: 'admin' });

  await writeAuditLog({
    organizationId: orgRef.id,
    actorUid: uid,
    action: 'Organization created',
    target: name.trim(),
  });

  return { organizationId: orgRef.id };
});

exports.inviteTeamMember = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can invite team members.');
  }

  const { email, role = 'user' } = request.data || {};
  if (!isPlausibleEmail(email)) {
    throw new HttpsError('invalid-argument', 'A valid email address is required.');
  }
  const ALLOWED_ROLES = ['admin', 'compliance_officer', 'analyst', 'user'];
  if (!ALLOWED_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', `Role must be one of: ${ALLOWED_ROLES.join(', ')}.`);
  }

  const inviteRef = db.collection('organizations').doc(caller.organizationId).collection('invites').doc();
  await inviteRef.set({
    email,
    role,
    invitedBy: uid,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // NOTE: actually emailing the invite requires an email provider
  // (e.g. the official "Trigger Email" Firebase Extension, or SendGrid).
  // Wire that here once you've installed an extension — this function
  // already creates the invite record it would read from.

  await writeAuditLog({
    organizationId: caller.organizationId,
    actorUid: uid,
    action: 'Team member invited',
    target: email,
  });

  return { inviteId: inviteRef.id };
});

/**
 * Removes a member's access to the organization. Deliberately does NOT
 * delete their Firebase Auth account (irreversible, and they may belong
 * to other orgs in a multi-org future) — it clears their org membership
 * and role, and revokes the custom claims Storage Rules rely on, which is
 * enough to fully cut off access to this org's data.
 */
exports.removeTeamMember = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can remove team members.');
  }
  const { targetUid } = request.data || {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid is required.');
  if (targetUid === uid) throw new HttpsError('invalid-argument', "You can't remove yourself. Ask another admin.");

  const targetSnap = await db.collection('users').doc(targetUid).get();
  if (!targetSnap.exists || targetSnap.data().organizationId !== caller.organizationId) {
    throw new HttpsError('not-found', 'That user is not a member of your organization.');
  }

  await db.collection('users').doc(targetUid).update({ organizationId: null, role: null });
  await auth.setCustomUserClaims(targetUid, { orgId: null, role: null });

  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Team member removed', target: targetSnap.data().email || targetUid,
  });

  return { removed: true };
});

/** Cancels a pending invite before it's accepted. */
exports.cancelInvite = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can cancel invites.');
  }
  const { inviteId } = request.data || {};
  if (!inviteId) throw new HttpsError('invalid-argument', 'inviteId is required.');
  await db.collection('organizations').doc(caller.organizationId).collection('invites').doc(inviteId).delete();
  return { cancelled: true };
});

/* ============================================================
   DOCUMENT PROCESSING PIPELINE
   ============================================================ */

/**
 * Fires automatically when a file lands in Storage at
 * organizations/{orgId}/documents/{docId}/{fileName}
 * (the client uploads directly to that path, then this function
 * extracts text, runs the AI compliance analysis, and writes the
 * result to Firestore).
 */
exports.onDocumentUploaded = onObjectFinalized(
  { secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 300 },
  async (event) => {
    const filePath = event.data.name; // organizations/{orgId}/documents/{docId}/{fileName}
    const contentType = event.data.contentType || '';
    const sizeBytes = Number(event.data.size || 0);
    const customMetadata = event.data.metadata || {}; // set client-side via uploadBytes(..., { customMetadata })
    const match = filePath.match(/^organizations\/([^/]+)\/documents\/([^/]+)\/(.+)$/);
    if (!match) return; // not a document upload path, ignore

    const [, orgId, docId, fileName] = match;
    const docRef = db.collection('documents').doc(docId);

    try {
      await docRef.set(
        {
          status: 'processing', organizationId: orgId, name: fileName, storagePath: filePath, contentType,
          size: sizeBytes > 0 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : null,
          country: customMetadata.country || null,
          domain: customMetadata.domain || null, // may be overwritten below once Gemini classifies the actual content
          uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const [buffer] = await admin.storage().bucket().file(filePath).download();
      const text = await extractText(buffer, contentType, fileName);

      if (!text || text.trim().length < 20) {
        await docRef.set({ status: 'error', errorMessage: 'Could not extract readable text from this file.' }, { merge: true });
        return;
      }

      const outputLang = resolveOutputLang(customMetadata.outputLang, detectLang(text));
      const analysis = await runComplianceAnalysis(text, outputLang);
      await applyAnalysisResult({ docRef, docId, orgId, fileName, analysis, actorUid: 'system', domainOverride: customMetadata.domain, sourceText: text, outputLang });
    } catch (err) {
      logger.error('Document processing failed', { filePath, err: err.message });
      await docRef.set({ status: 'error', errorMessage: err.message }, { merge: true });
    }
  }
);

/** Lets the frontend analyze pasted/typed text directly (no file upload). */
exports.analyzeText = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'analyzeText', { maxRequests: 20, windowMs: 60 * 60 * 1000 });
  const { text, country, domain, outputLang } = request.data || {};
  const lang = resolveOutputLang(outputLang, detectLang(text || ''));
  if (!text || text.trim().length < 20) {
    throw new HttpsError('invalid-argument', 'Provide at least a few sentences of text to analyze.');
  }

  const prompt = `You are a regulatory compliance analyst reviewing a policy excerpt for an organization operating in ${country || 'an unspecified jurisdiction'}, in the ${domain || 'general'} domain.
Identify compliance gaps and give an overall score 0-100. The text may be in English, Kannada, or both.
${langInstruction(lang)}
Respond ONLY as JSON: {"score":0,"gaps":[{"title":"...","severity":"High|Medium|Low","description":"..."}],"summary":"..."}

TEXT:
"""
${text.slice(0, 15000)}
"""`;

  const raw = await callGemini({ prompt, jsonOutput: true });
  const result = safeJsonParse(raw, { score: null, gaps: [], summary: raw });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Ad-hoc text analysis', target: `${text.slice(0, 40)}...` });
  return result;
});

/* ============================================================
   AI ASSISTANT CHAT
   ============================================================ */

/* ============================================================
   PLATFORM ADMIN — deliberately separate from the per-org 'admin' role.
   Gated by membership in the `platformAdmins` collection, which has NO
   client write rule at all (see firestore.rules) — it can only be
   populated by someone with direct Firebase Admin SDK / console access
   to your project, i.e. you, manually, after deploying. That's
   intentional: a regular org admin must never be able to grant
   themselves platform-wide access to every other customer's data, and
   an app button can't be trusted to enforce that boundary — only a
   step outside the app can. See SETUP.md §9 for how to add yourself.
   ============================================================ */
async function requirePlatformAdmin(uid) {
  const snap = await db.collection('platformAdmins').doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'This requires platform admin access.');
  }
}

/** Real counts only — no fabricated MRR or AI-usage numbers. This project
 * has no billing integration (Stripe etc.) and no per-request usage
 * logging, so those genuinely can't be reported; returning null for them
 * here (and the frontend showing "Not tracked") is honest, a made-up
 * number would not be. */
exports.getPlatformStats = onCall(async (request) => {
  const { uid } = requireAuth(request);
  await requirePlatformAdmin(uid);

  const [orgsSnap, usersSnap] = await Promise.all([
    db.collection('organizations').count().get(),
    db.collection('users').count().get(),
  ]);

  return {
    organizationCount: orgsSnap.data().count,
    userCount: usersSnap.data().count,
    mrr: null, // no billing integration wired in — see SETUP.md
    aiRequestsLast24h: null, // no usage logging wired in — see SETUP.md
  };
});

/** Real organization list (name, plan, seats, createdAt) — no fabricated
 * per-org MRR since there's no billing integration to source it from. */
exports.listAllOrganizations = onCall(async (request) => {
  const { uid } = requireAuth(request);
  await requirePlatformAdmin(uid);

  const orgsSnap = await db.collection('organizations').orderBy('createdAt', 'desc').limit(200).get();
  return {
    organizations: orgsSnap.docs.map((d) => {
      const v = d.data();
      return { id: d.id, name: v.name || 'Unnamed', plan: v.plan || 'starter', seats: v.seats || 0, createdAt: v.createdAt ? v.createdAt.toDate().toISOString() : null };
    }),
  };
});

exports.chatWithAssistant = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'chatWithAssistant', { maxRequests: 60, windowMs: 60 * 60 * 1000 });
  const { message, conversationId, history = [] } = request.data || {};
  if (!message || !message.trim()) {
    throw new HttpsError('invalid-argument', 'Message is required.');
  }

  // Real retrieval: embed the question, compare against every analyzed
  // document's stored embedding with cosine similarity, and use the
  // closest matches as context — not just whichever documents were
  // uploaded most recently. Brute-force over up to 200 docs (bounded so
  // an org with a very large document set can't blow up latency/cost on
  // every chat message); genuinely large orgs would want an indexed ANN
  // vector store instead of comparing every document on every message —
  // see the note on embedText() for why that's not deployed here.
  const [docsSnap, regsSnap] = await Promise.all([
    db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').orderBy('uploadedAt', 'desc').limit(200).get(),
    db.collection('regulations').limit(10).get(),
  ]);

  let relevantDocs = docsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const queryEmbedding = await embedText(message, 'RETRIEVAL_QUERY');
  if (queryEmbedding) {
    // Documents with old-size or missing vectors score 0 until re-analyzed.
    relevantDocs = relevantDocs
      .map((v) => ({ v, sim: cosineSimilarity(queryEmbedding, v.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5)
      .map((x) => x.v);
  } else {
    // Embedding API unavailable this call — fall back to recency rather
    // than failing the whole chat message.
    relevantDocs = relevantDocs.slice(0, 5);
  }

  // Pull the best passages from the top documents (works across English/Kannada).
  const passages = [];
  if (queryEmbedding) {
    await Promise.all(relevantDocs.slice(0, 3).map(async (v) => {
      const cs = await db.collection('documents').doc(v.id).collection('chunks').get();
      cs.docs
        .map((c) => ({ text: c.get('text'), sim: cosineSimilarity(queryEmbedding, c.get('embedding')) }))
        .filter((c) => c.sim > 0)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 2)
        .forEach((c) => passages.push(`[${v.name}] ${String(c.text).slice(0, 600)}`));
    }));
  }

  const docContext = relevantDocs.map((v) => {
    return `- ${v.name}: domain=${v.domain || 'n/a'}, score=${v.score ?? 'n/a'}, gaps=${(v.gaps || []).map((g) => g.title).join('; ')}`;
  }).join('\n') + (passages.length ? `\n\nRELEVANT PASSAGES:\n${passages.map((p) => `- ${p}`).join('\n')}` : '');

  const regContext = regsSnap.docs.map((d) => {
    const v = d.data();
    return `- ${v.shortName || v.name} (${v.country || 'global'}): ${v.description || ''}`;
  }).join('\n');

  const historyText = history.slice(-8).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');

  const systemInstruction = `You are the ORDINEX compliance assistant for the organization "${caller.organizationName || ''}". Answer using the organization's document context and the regulation reference context below when relevant. Be concise, cite which document or regulation you're drawing from, and never invent legal citations you are not given. The user may write in English or Kannada. Always reply in the same language as the user's latest message.

ORGANIZATION DOCUMENTS (most relevant to this question):
${docContext || '(no analyzed documents yet)'}

REGULATION REFERENCE:
${regContext || '(no regulations loaded yet)'}`;

  const prompt = `${historyText ? historyText + '\n' : ''}User: ${message}`;

  const reply = await callGemini({ prompt, systemInstruction, model: GEMINI_MODEL_FAST });

  const convRef = conversationId
    ? db.collection('chatConversations').doc(conversationId)
    : db.collection('chatConversations').doc();

  await convRef.set({ userId: uid, organizationId: caller.organizationId, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  const messagesRef = convRef.collection('messages');
  await messagesRef.add({ role: 'user', text: message, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await messagesRef.add({ role: 'assistant', text: reply, createdAt: admin.firestore.FieldValue.serverTimestamp() });

  return { conversationId: convRef.id, reply };
});

/* ============================================================
   RISK ASSESSMENT
   ============================================================ */

exports.assessRisk = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'assessRisk', { maxRequests: 10, windowMs: 60 * 60 * 1000 });

  const docsSnap = await db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').get();
  const docsSummary = docsSnap.docs.map((d) => {
    const v = d.data();
    return `- ${v.name} (domain: ${v.domain}, score: ${v.score}): ${(v.gaps || []).map((g) => `${g.severity}: ${g.title}`).join('; ')}`;
  }).join('\n') || '(no analyzed documents yet — general baseline assessment)';

  const prompt = `Based on the following analyzed compliance documents for an organization, produce an overall risk assessment.
Respond ONLY as JSON:
{"overallScore":0,"confidence":0,"categories":[{"name":"Regulatory Compliance","score":0,"level":"High Risk|Medium Risk|Low Risk","findings":["..."]},{"name":"Operational Risk","score":0,"level":"...","findings":["..."]},{"name":"Data Security","score":0,"level":"...","findings":["..."]},{"name":"Vendor Risk","score":0,"level":"...","findings":["..."]}],"recommendations":["...","...","...","..."]}

DOCUMENTS:
${docsSummary}`;

  const raw = await callGemini({ prompt, jsonOutput: true });
  const result = safeJsonParse(raw, { overallScore: null, categories: [], recommendations: [] });

  const riskRef = db.collection('riskAssessments').doc();
  await riskRef.set({
    organizationId: caller.organizationId,
    ...result,
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Risk assessment generated', target: riskRef.id });

  return { riskAssessmentId: riskRef.id, ...result };
});

/* ============================================================
   REPORT GENERATION
   ============================================================ */

exports.generateReport = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'generateReport', { maxRequests: 15, windowMs: 60 * 60 * 1000 });
  const { title, type = 'Compliance Report' } = request.data || {};
  if (!title) throw new HttpsError('invalid-argument', 'Report title is required.');

  const reportRef = db.collection('complianceReports').doc();
  await reportRef.set({
    organizationId: caller.organizationId,
    title,
    type,
    status: 'generating',
    createdBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const [docsSnap, riskSnap] = await Promise.all([
    db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').get(),
    db.collection('riskAssessments').where('organizationId', '==', caller.organizationId).orderBy('createdAt', 'desc').limit(1).get(),
  ]);

  const docsSummary = docsSnap.docs.map((d) => d.data()).map((v) => `- ${v.name}: score ${v.score}, gaps: ${(v.gaps || []).length}`).join('\n');
  const riskSummary = riskSnap.empty ? '(no risk assessment on file)' : JSON.stringify(riskSnap.docs[0].data());

  const prompt = `Write an executive summary (250-400 words) for a "${type}" titled "${title}" for an organization, based on:

DOCUMENT ANALYSES:
${docsSummary || '(none yet)'}

LATEST RISK ASSESSMENT:
${riskSummary}

Write in a professional, board-ready tone. Do not use markdown headers.`;

  const summary = await callGemini({ prompt });

  await reportRef.update({
    status: 'completed',
    summary,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Report generated', target: title });

  return { reportId: reportRef.id, summary };
});

/**
 * Real DOCX export — previously only PDF existed (client-side via jsPDF).
 * Builds an actual OOXML .docx with the `docx` package and returns it as
 * base64 for the client to decode into a Blob and download, the same way
 * the PDF path already works client-side.
 */
exports.exportReportDocx = onCall(async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  const { reportId } = request.data || {};
  if (!reportId) throw new HttpsError('invalid-argument', 'reportId is required.');

  const reportSnap = await db.collection('complianceReports').doc(reportId).get();
  if (!reportSnap.exists) throw new HttpsError('not-found', 'Report not found.');
  const report = reportSnap.data();
  if (report.organizationId !== caller.organizationId) {
    throw new HttpsError('permission-denied', 'This report does not belong to your organization.');
  }

  const bodyParagraphs = (report.summary || '').split('\n').filter((p) => p.trim().length > 0)
    .map((p) => new Paragraph({ children: [new TextRun(p)], spacing: { after: 200 } }));

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: 'ORDINEX', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: report.title || 'Untitled Report', heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: `${report.type || 'Report'} • Generated ${report.createdAt && report.createdAt.toDate ? report.createdAt.toDate().toISOString().slice(0, 10) : ''}`, spacing: { after: 300 } }),
        new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_3 }),
        ...(bodyParagraphs.length ? bodyParagraphs : [new Paragraph({ text: '(No content yet.)' })]),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  return { base64: buffer.toString('base64'), filename: `${(report.title || 'report').replace(/[^a-z0-9]/gi, '_')}.docx` };
});

/**
 * Report editor: AI-regenerates the executive summary from the org's
 * current documents/risk data (same inputs as generateReport), and keeps
 * the previous version in versionHistory rather than silently overwriting
 * it — this is the "version history" + "regenerate with AI" half of the
 * report editor; saving manual text edits is a plain client-side updateDoc
 * (already permitted by firestore.rules for admin/compliance_officer),
 * no Cloud Function needed for that part.
 */
exports.reviseReportSummary = onCall({ secrets: [GEMINI_API_KEY] }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'reviseReportSummary', { maxRequests: 20, windowMs: 60 * 60 * 1000 });
  const { reportId, instructions } = request.data || {};
  if (!reportId) throw new HttpsError('invalid-argument', 'reportId is required.');

  const reportRef = db.collection('complianceReports').doc(reportId);
  const reportSnap = await reportRef.get();
  if (!reportSnap.exists) throw new HttpsError('not-found', 'Report not found.');
  const report = reportSnap.data();
  if (report.organizationId !== caller.organizationId) {
    throw new HttpsError('permission-denied', 'This report does not belong to your organization.');
  }

  const [docsSnap, riskSnap] = await Promise.all([
    db.collection('documents').where('organizationId', '==', caller.organizationId).where('status', '==', 'analyzed').get(),
    db.collection('riskAssessments').where('organizationId', '==', caller.organizationId).orderBy('createdAt', 'desc').limit(1).get(),
  ]);
  const docsSummary = docsSnap.docs.map((d) => d.data()).map((v) => `- ${v.name}: score ${v.score}, gaps: ${(v.gaps || []).length}`).join('\n');
  const riskSummary = riskSnap.empty ? '(no risk assessment on file)' : JSON.stringify(riskSnap.docs[0].data());

  const prompt = `Rewrite the executive summary (250-400 words) for a "${report.type}" titled "${report.title}", based on:

DOCUMENT ANALYSES:
${docsSummary || '(none yet)'}

LATEST RISK ASSESSMENT:
${riskSummary}

PREVIOUS VERSION OF THIS SUMMARY (for context, don't just repeat it — reflect the latest data above):
${report.summary || '(none yet)'}
${instructions ? `\nADDITIONAL INSTRUCTIONS FROM THE EDITOR: ${instructions}` : ''}

Write in a professional, board-ready tone. Do not use markdown headers.`;

  const newSummary = await callGemini({ prompt });

  await reportRef.update({
    summary: newSummary,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    versionHistory: admin.firestore.FieldValue.arrayUnion({
      summary: report.summary || '',
      savedAt: new Date().toISOString(), // client-readable timestamp; arrayUnion can't hold serverTimestamp() sentinels
      editedBy: uid,
    }),
  });

  await writeAuditLog({ organizationId: caller.organizationId, actorUid: uid, action: 'Report section regenerated by AI', target: report.title });

  return { summary: newSummary };
});

/**
 * Re-downloads the original file from Storage, re-extracts its text, and
 * asks Gemini to rewrite the FULL document addressing every gap that was
 * found during the original analysis. Returns the revised text for the
 * client to package into a downloadable file (the frontend renders it to
 * PDF via jsPDF — see downloadTextAsPdf() in ordinex.html).
 */
exports.reviseDocument = onCall({ secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 300 }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'reviseDocument', { maxRequests: 10, windowMs: 60 * 60 * 1000 });
  const { documentId } = request.data || {};
  if (!documentId) throw new HttpsError('invalid-argument', 'documentId is required.');

  const docSnap = await db.collection('documents').doc(documentId).get();
  if (!docSnap.exists) throw new HttpsError('not-found', 'Document not found.');
  const docData = docSnap.data();

  if (docData.organizationId !== caller.organizationId) {
    throw new HttpsError('permission-denied', 'This document does not belong to your organization.');
  }
  if (!docData.storagePath) {
    throw new HttpsError('failed-precondition', 'This document has no stored file to revise.');
  }
  if (!docData.gaps || docData.gaps.length === 0) {
    throw new HttpsError('failed-precondition', 'No compliance gaps were found for this document — nothing to revise.');
  }

  const [buffer] = await admin.storage().bucket().file(docData.storagePath).download();
  const text = await extractText(buffer, docData.contentType || '', docData.name || '');
  if (!text || text.trim().length < 20) {
    throw new HttpsError('failed-precondition', 'Could not re-extract readable text from the original file.');
  }

  const gapsText = docData.gaps
    .map((g, i) => `${i + 1}. [${g.severity}] ${g.title}: ${g.description || ''}`)
    .join('\n');

  const prompt = `You are a compliance editor. Below is the original text of a policy document, followed by a list of compliance gaps found in it.
Rewrite the FULL document, preserving its structure and tone, but revising it to address every gap listed.
Output ONLY the revised document text itself — no commentary, no headers like "Revised Document", no explanations, ready to replace the original.

COMPLIANCE GAPS TO FIX:
${gapsText}

ORIGINAL DOCUMENT TEXT:
"""
${text.slice(0, 15000)}
"""`;

  const revisedText = await callGemini({ prompt, model: GEMINI_MODEL });
  if (!revisedText || revisedText.trim().length < 20) {
    throw new HttpsError('internal', 'The AI did not return a usable revision. Try again.');
  }

  await writeAuditLog({
    organizationId: caller.organizationId,
    actorUid: uid,
    action: 'Document revised by AI',
    target: docData.name || documentId,
  });

  return { revisedText, documentName: docData.name || 'document', gapsAddressed: docData.gaps.length };
});

/* ============================================================
   BULK RE-ANALYSIS — real backend for the "New Analysis" button on the
   Compliance Gap Analysis page, which previously only showed a toast.
   ============================================================ */
exports.reanalyzeAllDocuments = onCall({ secrets: [GEMINI_API_KEY], memory: '1GiB', timeoutSeconds: 540 }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'reanalyzeAllDocuments', { maxRequests: 5, windowMs: 60 * 60 * 1000 });

  const docsSnap = await db.collection('documents')
    .where('organizationId', '==', caller.organizationId)
    .where('status', 'in', ['analyzed', 'error'])
    .limit(25) // cap per run to stay inside the function timeout; re-run to cover more
    .get();

  if (docsSnap.empty) {
    return { reanalyzed: 0, failed: 0, message: 'No previously-analyzed documents to re-run.' };
  }

  let reanalyzed = 0;
  const failures = [];

  // Sequential, not Promise.all: Gemini calls are rate-limited per project,
  // and this keeps memory bounded regardless of how many documents exist.
  for (const doc of docsSnap.docs) {
    const docData = doc.data();
    try {
      if (!docData.storagePath) throw new Error('No stored file for this document.');
      const [buffer] = await admin.storage().bucket().file(docData.storagePath).download();
      const text = await extractText(buffer, docData.contentType || '', docData.name || '');
      if (!text || text.trim().length < 20) throw new Error('Could not extract readable text.');

      const outputLang = resolveOutputLang(docData.outputLang, detectLang(text));
      const analysis = await runComplianceAnalysis(text, outputLang);
      await applyAnalysisResult({
        docRef: doc.ref, docId: doc.id, orgId: caller.organizationId,
        fileName: docData.name || doc.id, analysis, actorUid: uid, domainOverride: docData.domain, sourceText: text, outputLang,
      });
      reanalyzed += 1;
    } catch (err) {
      logger.error('Re-analysis failed for document', { docId: doc.id, err: err.message });
      failures.push({ documentId: doc.id, name: docData.name, error: err.message });
    }
  }

  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Bulk re-analysis run', target: `${reanalyzed} document(s)`,
  });

  return { reanalyzed, failed: failures.length, failures };
});

/* ============================================================
   REGULATION DATABASE SYNC — real backend for the Regulation Comparison
   and Knowledge Base pages, which previously only ever read a hardcoded
   JS array baked into the frontend. This seeds a curated starter set into
   Firestore; the frontend now reads live from the `regulations` collection.
   Swap the REGULATION_SEED_SET below for a real scheduled fetch from
   official sources (eur-lex.europa.eu, oag.ca.gov, etc.) when you're ready
   to automate updates — this is intentionally a manual-trigger starting
   point, not a scraper, since automated legal-text ingestion needs a
   licensing/compliance review this project can't make for you.
   ============================================================ */
const REGULATION_SEED_SET = [
  { id: 'reg_gdpr', name: 'General Data Protection Regulation', short: 'GDPR', country: 'Germany', countryCode: 'DE', domain: 'Data Privacy', status: 'active',
    description: 'EU regulation on data protection and privacy, protecting personal data of EU citizens.',
    tags: ['Data Protection', 'Privacy', 'EU', 'Personal Data'],
    requirements: [
      { title: 'Article 5 — Principles relating to processing of personal data', desc: 'Personal data shall be processed lawfully, fairly and in a transparent manner.', status: 'met' },
      { title: 'Article 6 — Lawfulness of processing', desc: 'Processing shall be lawful only if consent is given or a legal obligation exists.', status: 'met' },
      { title: 'Article 7 — Conditions for consent', desc: 'Consent must be freely given, specific, informed and unambiguous.', status: 'gap' },
      { title: 'Article 33 — Breach notification', desc: 'Notify the supervisory authority within 72 hours of becoming aware of a breach.', status: 'partial' },
    ] },
  { id: 'reg_ccpa', name: 'California Consumer Privacy Act', short: 'CCPA', country: 'United States', countryCode: 'US', domain: 'Data Privacy', status: 'active',
    description: 'California state law enhancing privacy rights and consumer protection for residents.',
    tags: ['Privacy', 'Consumer Rights', 'California', 'Data Sales'],
    requirements: [
      { title: 'Right to Know', desc: 'Consumers have the right to know what personal information is being collected.', status: 'met' },
      { title: 'Right to Delete', desc: 'Consumers may request deletion of personal information collected.', status: 'met' },
      { title: 'Right to Opt-Out', desc: 'Consumers may opt out of the sale of personal information.', status: 'partial' },
    ] },
  { id: 'reg_sox', name: 'Sarbanes-Oxley Act', short: 'SOX', country: 'United States', countryCode: 'US', domain: 'Finance', status: 'active',
    description: 'US federal law mandating strict reforms to improve financial disclosures and prevent accounting fraud.',
    tags: ['Financial Reporting', 'Internal Controls', 'Auditing', 'Corporate Governance'],
    requirements: [
      { title: 'Section 302 — Corporate Responsibility', desc: 'Officers must certify accuracy of financial statements.', status: 'met' },
      { title: 'Section 404 — Internal Controls', desc: 'Management must document and assess internal control structure.', status: 'gap' },
    ] },
  { id: 'reg_pcidss', name: 'Payment Card Industry Data Security Standard', short: 'PCI DSS', country: 'United Kingdom', countryCode: 'UK', domain: 'Cybersecurity', status: 'active',
    description: 'Information security standard for organizations that handle credit card data.',
    tags: ['Card Data', 'Security', 'Payments', 'Encryption'],
    requirements: [
      { title: 'Requirement 3 — Protect stored cardholder data', desc: 'Render PAN unreadable anywhere it is stored.', status: 'met' },
      { title: 'Requirement 10 — Track and monitor access', desc: 'Log and monitor all access to network resources and cardholder data.', status: 'partial' },
    ] },
  { id: 'reg_pipl', name: 'Personal Information Protection Law', short: 'PIPL', country: 'Japan', countryCode: 'JP', domain: 'Data Privacy', status: 'active',
    description: 'Law governing the handling of personal information by businesses.',
    tags: ['Privacy', 'Japan', 'Personal Information', 'Consent'],
    requirements: [
      { title: 'Purpose limitation', desc: 'Personal information may only be used for the stated purpose of collection.', status: 'met' },
    ] },
  { id: 'reg_mas', name: 'Monetary Authority of Singapore Guidelines', short: 'MAS Guidelines', country: 'Singapore', countryCode: 'SG', domain: 'Finance', status: 'active',
    description: 'Central bank guidelines on technology risk management and cybersecurity for financial institutions.',
    tags: ['Financial Services', 'Technology Risk', 'Singapore', 'Cybersecurity'],
    requirements: [
      { title: 'TRM Guideline 6.2', desc: 'Establish incident management and response processes.', status: 'partial' },
    ] },
];

exports.seedRegulations = onCall({ secrets: [GEMINI_API_KEY], timeoutSeconds: 300 }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  if (caller.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only an organization admin can sync the regulation database.');
  }

  const batch = db.batch();
  REGULATION_SEED_SET.forEach((reg) => {
    const { id, ...data } = reg;
    batch.set(db.collection('regulations').doc(id), {
      ...data,
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'manual-seed', // flip to a real source name once a live feed is wired in
    }, { merge: true });
  });
  await batch.commit();

  // Embed every requirement once (title + description) so documents in English
  // or Kannada can be matched against them by meaning, without translation.
  const reqItems = [];
  REGULATION_SEED_SET.forEach((reg) => (reg.requirements || []).forEach((r, i) =>
    reqItems.push({ regId: reg.id, i, title: r.title, desc: r.desc, text: `${r.title}. ${r.desc}` })));
  const vecs = reqItems.length ? await embedMany(reqItems.map((r) => r.text), 'RETRIEVAL_DOCUMENT') : [];
  let requirementsEmbedded = 0;
  if (vecs && vecs.length === reqItems.length) {
    for (let k = 0; k < reqItems.length; k += 400) {
      const b = db.batch();
      reqItems.slice(k, k + 400).forEach((r, j) => b.set(
        db.collection('regulations').doc(r.regId).collection('requirements').doc(String(r.i).padStart(3, '0')),
        { i: r.i, title: r.title, desc: r.desc, embedding: vecs[k + j], embedModel: `${GEMINI_EMBED_MODEL}@${EMBED_DIM}` }
      ));
      await b.commit();
    }
    requirementsEmbedded = reqItems.length;
  } else {
    logger.warn('Regulation requirement embedding failed; gap matching will be unavailable until re-synced.');
  }

  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Regulation database synced', target: `${REGULATION_SEED_SET.length} regulation(s)`,
  });

  return { synced: REGULATION_SEED_SET.length, requirementsEmbedded };
});

/* ============================================================
   REGULATION GAP CHECK — English or Kannada documents vs. a regulation.
   For each requirement, finds the most similar passages in the document
   (cross-lingual embeddings, no translation), then asks Gemini to make
   the final covered / partial / gap call. Similarity is only a hint.
   ============================================================ */
exports.analyzeAgainstRegulation = onCall({ secrets: [GEMINI_API_KEY], timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  const { uid } = requireAuth(request);
  const caller = await requireOrgMembership(uid);
  await enforceRateLimit(uid, 'analyzeAgainstRegulation', { maxRequests: 10, windowMs: 60 * 60 * 1000 });
  const { documentId, regulationId, outputLang = 'en' } = request.data || {};
  if (!documentId || !regulationId) throw new HttpsError('invalid-argument', 'documentId and regulationId are required.');

  const docRef = db.collection('documents').doc(documentId);
  const docSnap = await docRef.get();
  if (!docSnap.exists || docSnap.data().organizationId !== caller.organizationId) {
    throw new HttpsError('not-found', 'Document not found.');
  }

  const [chunkSnap, reqSnap] = await Promise.all([
    docRef.collection('chunks').get(),
    db.collection('regulations').doc(regulationId).collection('requirements').get(),
  ]);
  if (chunkSnap.empty) throw new HttpsError('failed-precondition', 'This document has no embeddings yet. Re-run analysis on it first.');
  if (reqSnap.empty) throw new HttpsError('failed-precondition', 'This regulation has no embedded requirements. An admin must run the regulation sync first.');

  const chunks = chunkSnap.docs.map((c) => ({ text: c.get('text'), embedding: c.get('embedding') }));
  const lang = resolveOutputLang(outputLang, docSnap.data().lang || 'en');

  const candidates = reqSnap.docs.map((r) => {
    const rq = r.data();
    const top = chunks
      .map((c) => ({ text: c.text, sim: cosineSimilarity(rq.embedding, c.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2);
    return {
      ref: rq.title,
      requirement: rq.desc,
      bestSimilarity: Number((top[0]?.sim || 0).toFixed(3)),
      passages: top.map((t) => String(t.text).slice(0, 700)),
    };
  });

  const results = [];
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = candidates.slice(i, i + 8);
    const prompt = `You are a compliance analyst. For each requirement, decide whether the candidate passages from the organization's document (English and/or Kannada) satisfy it. A low similarity score suggests the document does not address the requirement, but judge by the passages' actual content.
${langInstruction(lang)}
Respond ONLY as JSON: {"results":[{"ref":"<requirement ref exactly as given>","status":"covered|partial|gap","risk":"low|medium|high","evidence":"...","recommendation":"..."}]}

${JSON.stringify(batch.map(({ ref, requirement, passages }) => ({ ref, requirement, passages })))}`;
    const raw = await callGemini({ prompt, model: GEMINI_MODEL, jsonOutput: true });
    const parsed = safeJsonParse(raw, { results: [] });
    const arr = Array.isArray(parsed) ? parsed : (parsed.results || []);
    arr.forEach((v) => {
      const c = batch.find((b) => b.ref === v.ref);
      results.push({ ...v, bestSimilarity: c ? c.bestSimilarity : null });
    });
  }

  await docRef.collection('regulationChecks').doc(regulationId).set({
    results, lang, checkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    organizationId: caller.organizationId, actorUid: uid,
    action: 'Regulation gap check', target: `${docSnap.data().name || documentId} vs ${regulationId}`,
  });
  return { results, lang };
});

/* ============================================================
   NOTIFICATIONS — fan out on new high-severity issues
   ============================================================ */

exports.onComplianceIssueCreated = onDocumentCreated('complianceIssues/{issueId}', async (event) => {
  const issue = event.data.data();
  if (issue.severity !== 'High') return;

  const sourceDocSnap = issue.documentId
    ? await db.collection('documents').doc(issue.documentId).get()
    : null;
  const sourceDocumentName = sourceDocSnap && sourceDocSnap.exists
    ? (sourceDocSnap.data().name || null)
    : null;

  const usersSnap = await db.collection('users').where('organizationId', '==', issue.organizationId).get();
  const batch = db.batch();
  usersSnap.docs.forEach((u) => {
    const notifRef = db.collection('notifications').doc();
    batch.set(notifRef, {
      userId: u.id,
      organizationId: issue.organizationId,
      title: 'Critical Compliance Gap Detected',
      body: issue.title,
      documentId: issue.documentId || null,
      documentName: sourceDocumentName,
      issueId: event.params.issueId,
      level: 'Critical',
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
});

/* ============================================================
   Exported for unit testing only (functions/test/analysis.test.js).
   Pure helpers with no Firebase/Gemini calls, so they're actually
   testable without an emulator or live credentials.
   ============================================================ */
exports._testables = { safeJsonParse, isPlausibleEmail, cosineSimilarity, checkRateWindow, normalizeText, kannadaRatio, detectLang, looksGarbled, chunkText, meanVector, l2Normalize, resolveOutputLang };