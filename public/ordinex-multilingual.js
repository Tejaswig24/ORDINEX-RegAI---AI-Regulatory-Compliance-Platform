/*!
 * ORDINEX — multilingual (English + Kannada) module for the browser (Spark plan, no Cloud Functions).
 *
 * Put this file in /public next to ordinex.html and load it BEFORE your main script:
 *     <script src="ordinex-multilingual.js"></script>
 * It exposes window.OrdinexML. It has NO Firebase dependency: saving/loading the results
 * in Firestore stays in ordinex.html (see the saveIndex/loadIndex examples in the instructions).
 *
 * How it works: gemini-embedding-001 is multilingual, so a Kannada passage and an English
 * regulation clause land close together in the same vector space — no translation step.
 * Embeddings find candidate matches; Gemini makes the final covered / partial / gap call.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OrdinexML = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const SUPPORTED_LANGS = ['en', 'kn'];
  const MAX_INLINE_BYTES = 14 * 1024 * 1024; // base64 inflates ~33%; Gemini inline request limit is ~20 MB

  const cfg = {
    getApiKey: () => '',                     // set via init(): () => yourGeminiKey
    embedModel: 'gemini-embedding-001',
    genModel: 'gemini-flash-lite-latest',    // use whichever model ordinex.html already uses
    embedDim: 768,                           // keep constant: vectors of different sizes can't be compared
    embedBatch: 50,
    fetchImpl: null,                         // tests can inject a fake fetch
  };

  /** init({ getApiKey: () => KEY, genModel: '...' }) */
  function init(opts) { Object.assign(cfg, opts || {}); }

  /* ------------------------------------------------------------------
     Language + text helpers (pure functions)
     ------------------------------------------------------------------ */

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

  /** True when extraction clearly failed: empty/scanned, or legacy-font Kannada
   * (Nudi/Baraha) which extracts as Latin-1 junk. */
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

  function l2Normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
  }

  function meanVector(vectors) {
    if (!vectors.length) return null;
    const out = new Array(vectors[0].length).fill(0);
    for (const v of vectors) for (let i = 0; i < out.length; i++) out[i] += v[i];
    return l2Normalize(out);
  }

  /** Returns 0 for missing/mismatched vectors instead of throwing. */
  function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0, ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
    if (ma === 0 || mb === 0) return 0;
    return dot / (Math.sqrt(ma) * Math.sqrt(mb));
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

  function safeJsonParse(raw, fallback) {
    try { return JSON.parse(raw); }
    catch {
      // Gemini occasionally wraps JSON in markdown fences despite JSON mode.
      const m = String(raw || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
      return { ...fallback, rawResponse: raw };
    }
  }

  /* ------------------------------------------------------------------
     Gemini REST (browser). Key goes in a header, not the URL.
     Retries 429/503 with backoff — the free tier rate-limits aggressively.
     ------------------------------------------------------------------ */

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function postJson(url, body, { retries = 3, baseDelayMs = 1500 } = {}) {
    const key = cfg.getApiKey();
    if (!key || /^(PASTE|YOUR)[_-]/i.test(String(key))) throw new Error('Gemini API key is not set. Put your key in geminiConfig.apiKey near the top of public/ordinex.html, then reload.');
    const f = cfg.fetchImpl || fetch;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await f(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (res.ok) return res.json();
      const errText = await res.text();
      lastErr = new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
      lastErr.status = res.status;
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  async function callGemini({ prompt, system, jsonOutput = false, model, maxOutputTokens = 8192, inlineData = null }) {
    const parts = [{ text: prompt }];
    if (inlineData) parts.unshift({ inlineData });
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens, // Kannada is token-heavy: 2048 would truncate JSON replies
        ...(jsonOutput ? { responseMimeType: 'application/json' } : {}),
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const json = await postJson(`${API}/models/${model || cfg.genModel}:generateContent`, body);
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  }

  /* ------------------------------------------------------------------
     Embeddings
     ------------------------------------------------------------------ */

  /** taskType: 'RETRIEVAL_DOCUMENT' for stored text, 'RETRIEVAL_QUERY' for questions. */
  async function embedTexts(texts, taskType = 'RETRIEVAL_DOCUMENT') {
    const out = [];
    for (let i = 0; i < texts.length; i += cfg.embedBatch) {
      const batch = texts.slice(i, i + cfg.embedBatch);
      const json = await postJson(`${API}/models/${cfg.embedModel}:batchEmbedContents`, {
        requests: batch.map((t) => ({
          model: `models/${cfg.embedModel}`,
          content: { parts: [{ text: String(t).slice(0, 4000) }] },
          taskType,
          outputDimensionality: cfg.embedDim,
        })),
      });
      if (!json.embeddings || json.embeddings.length !== batch.length) {
        throw new Error('Embedding response did not match the request size.');
      }
      out.push(...json.embeddings.map((e) => l2Normalize(e.values)));
    }
    return out;
  }

  async function embedQuery(text) {
    const [v] = await embedTexts([text], 'RETRIEVAL_QUERY');
    return v;
  }

  /** Top-k items ranked by cosine similarity. items: [{ embedding, ... }] */
  function rankByEmbedding(queryVec, items, k = 5) {
    return items
      .map((item) => ({ item, sim: cosineSimilarity(queryVec, item.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);
  }

  /* ------------------------------------------------------------------
     Document indexing (call when a document is uploaded / analyzed)
     ------------------------------------------------------------------ */

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  /** If the text your existing extractor produced is empty/garbled (scanned PDF, legacy-font
   * Kannada), let Gemini transcribe the file directly. Otherwise returns text unchanged. */
  async function ensureReadableText(text, file) {
    if (!looksGarbled(text)) return text;
    if (!file || file.size > MAX_INLINE_BYTES) return text;
    const data = await fileToBase64(file);
    const prompt = 'Transcribe all text in this document exactly as written, in its original language and script (Kannada, English or mixed). Do not translate, summarize or add commentary. Separate paragraphs with a blank line.';
    const inlineData = { mimeType: file.type || 'application/pdf', data };
    let transcribed = '';
    try {
      transcribed = await callGemini({ prompt, inlineData, maxOutputTokens: 16384 });
    } catch (e) {
      if (e.status === 400) transcribed = await callGemini({ prompt, inlineData, maxOutputTokens: 8192 }); // model rejected the larger cap
      else throw e;
    }
    return transcribed || text;
  }

  /** Chunks + embeds a document. Returns what you should save in Firestore:
   *   { lang, chunks:[{idx,text,embedding}], embedding (whole-doc mean vector), embedModel } */
  async function buildDocumentIndex(text) {
    const lang = detectLang(text);
    const chunks = chunkText(text);
    const embedModel = `${cfg.embedModel}@${cfg.embedDim}`;
    if (!chunks.length) return { lang, chunks: [], embedding: null, embedModel };
    const vecs = await embedTexts(chunks, 'RETRIEVAL_DOCUMENT');
    return {
      lang,
      chunks: chunks.map((t, i) => ({ idx: i, text: t, embedding: vecs[i] })),
      embedding: meanVector(vecs),
      embedModel,
    };
  }

  /** requirements: [{ title, desc }] -> same array with an `embedding` on each (embed once, cache it). */
  async function embedRequirements(requirements) {
    const vecs = await embedTexts(requirements.map((r) => `${r.title}. ${r.desc || ''}`), 'RETRIEVAL_DOCUMENT');
    return requirements.map((r, i) => ({ ...r, embedding: vecs[i] }));
  }

  /* ------------------------------------------------------------------
     Regulation gap check (English or Kannada documents)
     ------------------------------------------------------------------ */

  function matchRequirements(requirements, chunks) {
    return requirements.map((rq) => {
      const top = rankByEmbedding(rq.embedding, chunks, 2);
      return {
        ref: rq.title,
        requirement: rq.desc,
        bestSimilarity: Number((top[0]?.sim || 0).toFixed(3)),
        passages: top.map((t) => String(t.item.text).slice(0, 700)),
      };
    });
  }

  async function judgeCandidates(candidates, lang) {
    const results = [];
    for (let i = 0; i < candidates.length; i += 8) {
      const batch = candidates.slice(i, i + 8);
      const prompt = `You are a compliance analyst. For each requirement, decide whether the candidate passages from the organization's document (English and/or Kannada) satisfy it. A low similarity score suggests the document does not address the requirement, but judge by the passages' actual content.
${langInstruction(lang)}
Respond ONLY as JSON: {"results":[{"ref":"<requirement ref exactly as given>","status":"covered|partial|gap","risk":"low|medium|high","evidence":"...","recommendation":"..."}]}

${JSON.stringify(batch.map(({ ref, requirement, passages }) => ({ ref, requirement, passages })))}`;
      const raw = await callGemini({ prompt, jsonOutput: true });
      const parsed = safeJsonParse(raw, { results: [] });
      const arr = Array.isArray(parsed) ? parsed : (parsed.results || []);
      arr.forEach((v) => {
        const c = batch.find((b) => b.ref === v.ref);
        results.push({ ...v, bestSimilarity: c ? c.bestSimilarity : null });
      });
    }
    return results;
  }

  /** requirements: with embeddings (see embedRequirements). chunks: [{text, embedding}] from the saved index.
   * outputLang: 'en' | 'kn' | 'auto'. */
  async function analyzeAgainstRegulation({ requirements, chunks, docLang = 'en', outputLang = 'en' }) {
    if (!chunks || !chunks.length) throw new Error('This document has no embeddings yet. Re-run analysis on it first.');
    if (!requirements || !requirements.length) throw new Error('No regulation requirements to check.');
    const lang = resolveOutputLang(outputLang, docLang);
    const candidates = matchRequirements(requirements, chunks);
    const results = await judgeCandidates(candidates, lang);
    return { results, lang };
  }

  /* ------------------------------------------------------------------
     Compliance analysis + chat helpers (bilingual versions of your prompts)
     ------------------------------------------------------------------ */

  async function analyzeDocumentText(text, outputLang = 'en') {
    const lang = resolveOutputLang(outputLang, detectLang(text));
    const prompt = `You are a regulatory compliance analyst. The document may be in English, Kannada, or both. Analyze the following document text and:
1. Identify which regulatory domain it most likely relates to (Data Privacy, Finance, HR, Cybersecurity, or Corporate Governance).
2. Give an overall compliance score from 0-100 based on how well the content reflects sound compliance practice.
3. List up to 5 specific gaps or risks found, each with a severity of High, Medium, or Low.
${langInstruction(lang)}
Respond ONLY as JSON in this exact shape:
{"domain":"...","score":0,"gaps":[{"title":"...","severity":"High","description":"..."}]}

DOCUMENT TEXT:
"""
${text.slice(0, 15000)}
"""`;
    const raw = await callGemini({ prompt, jsonOutput: true });
    return safeJsonParse(raw, { domain: 'Unclassified', score: null, gaps: [] });
  }

  /** Answers a question using the best passages. passages: [{ source, text }].
   * Replies in whatever language (English/Kannada) the user wrote in. */
  async function answerWithPassages(question, passages, history = []) {
    const context = passages.map((p) => `- [${p.source}] ${String(p.text).slice(0, 600)}`).join('\n');
    const historyText = history.slice(-8).map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n');
    const system = `You are the ORDINEX compliance assistant. Answer using the context below when relevant. Be concise, cite which document you're drawing from, and never invent legal citations you are not given. The user may write in English or Kannada. Always reply in the same language as the user's latest message.

CONTEXT:
${context || '(no relevant passages found)'}`;
    return callGemini({ prompt: `${historyText ? historyText + '\n' : ''}User: ${question}`, system });
  }

  return {
    init,
    // helpers
    normalizeText, kannadaRatio, detectLang, looksGarbled, chunkText, l2Normalize, meanVector,
    cosineSimilarity, resolveOutputLang, langInstruction, safeJsonParse,
    // gemini
    callGemini, embedTexts, embedQuery, rankByEmbedding,
    // pipeline
    ensureReadableText, buildDocumentIndex, embedRequirements,
    matchRequirements, analyzeAgainstRegulation, analyzeDocumentText, answerWithPassages,
  };
});