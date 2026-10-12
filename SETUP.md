# ORDINEX — Setup & Deployment Guide (free-plan build)

This build runs entirely on Firebase's **free Spark plan** — Auth, Firestore,
and Hosting only. There is no Cloud Functions, no Cloud Storage, and no
Blaze plan anywhere in this deployment, so there is no linked billing
account and no possibility of a bill.

That required real architectural changes from a typical Firebase +
Cloud Functions app, not just a config flag — see "What changed and why"
below before you deploy, especially the security trade-offs.

Total time: roughly 10-15 minutes if you're starting from nothing.

---

## Why this needed a rewrite, not a setting

Two Firebase facts, as of mid-2026:

1. **Cloud Functions require the Blaze (pay-as-you-go) plan to deploy at
   all** — not just when they call external APIs. This is true even for a
   function that never leaves Firebase.
2. **As of February 3, 2026, Cloud Storage for Firebase also requires
   Blaze**, even just to create a bucket, regardless of how little you'd
   actually use it.

Blaze is usually free in practice (it keeps Spark's free quotas and only
charges past them), but it requires linking a credit card, and you asked
for zero chance of ever spending anything — so this build avoids Blaze
entirely rather than relying on staying under the free tier.

## What changed and why

The original design used ~20 Cloud Functions (Gemini calls, document text
extraction, report/DOCX generation, rate limiting, auth triggers) plus
Cloud Storage for uploaded files. All of that had to move somewhere that
isn't Firebase Functions/Storage. This build moves it **into the browser**:

- **Gemini calls go straight from the browser** to the public Generative
  Language API, using the same REST endpoints the old Cloud Functions
  called — just called client-side now (see `geminiConfig` near the
  bottom of `public/ordinex.html`).
- **Document text extraction happens client-side**: pdf.js for PDFs,
  mammoth.js for `.docx`, and Gemini's vision endpoint for OCR on images —
  all bundled as static files in `public/vendor/` (official pre-built
  browser bundles from each project, not custom-built).
- **No original files are stored anywhere.** Since there's no Storage
  bucket, only the *extracted text* of each upload is saved (on the
  document's own Firestore doc, truncated to ~200KB to stay under
  Firestore's 1MB-per-document limit). "Revise Document" and bulk
  re-analysis work from that saved text.
- **DOCX report export happens client-side** too, using the `docx`
  package's official browser build (`public/vendor/docx.iife.js`) and
  `Packer.toBlob()` instead of a server round-trip.
- **Avatar photos** are resized down client-side (canvas) and stored as a
  small base64 data URI directly on the user's Firestore document, instead
  of a Storage URL.
- **Auth triggers, org creation, team invites/removal, regulation sync,
  and audit logging** are now plain client-side Firestore writes, governed
  by `firestore.rules` instead of Admin-SDK-only Cloud Functions. The rules
  file has real new logic to cover this — worth skimming.
- The original `functions/` folder still exists, renamed to
  `functions-optional-blaze-upgrade/`, purely as a reference if you ever
  want to move back to a Cloud Functions design later. It is not deployed.

## The two trade-offs this makes — read this part

**1. The Gemini API key ships to every visitor's browser.** There's no
server left to hide it behind on the free plan. Mitigate this by
restricting the key to your domain:
`https://aistudio.google.com/apikey` → your key → **Set an application
restriction** → **HTTP referrers** → add `https://YOUR_PROJECT_ID.web.app/*`
and `https://YOUR_PROJECT_ID.firebaseapp.com/*` (and any custom domain).
This stops the key from being usable from anywhere except your own site,
even though the key text itself is visible in page source.

**2. Rate limiting is now a UX throttle, not a security control.** The old
Cloud Function enforced per-user request caps server-side, where a user
couldn't touch the code. Now the "rate limit" is a Firestore doc the
user's own browser reads and writes — a user who opens dev tools can
always bypass their own limit, the same way they could always call the
Gemini API directly with the key from the page. There's no way around this
without a server. If real abuse protection matters to you beyond "the key
is domain-restricted," that needs a paid tier (Blaze + App Check, or a
non-Firebase backend — see "Upgrading later" below).

Both of these are inherent to "no server at all," not bugs in this build.

---

## 1. Create your Firebase project

1. Go to https://console.firebase.google.com → **Add project** → name it → follow the prompts (Analytics optional, skip it).
2. Click the web icon (`</>`) to register a web app. **Don't** check "Firebase Hosting" yet.
3. Copy the shown `firebaseConfig` values (`apiKey`, `authDomain`, `projectId`, `messagingSenderId`, `appId`) — you'll paste these into `.env` in step 3. `storageBucket` isn't used by this build; ignore it.
4. In the Firebase Console, enable (left sidebar), **staying on the Spark plan** — don't accept any "upgrade to Blaze" prompt these steps might show you:
   - **Authentication** → Get started → enable **Email/Password** (and **Google** if you want that button to work)
   - **Firestore Database** → Create database → **production mode** → pick a region

Do **not** enable Cloud Storage — it's unused and, since Feb 2026, enabling it forces a Blaze upgrade.

## 2. Get a Gemini API key

1. https://aistudio.google.com/apikey → **Create API key**. Copy it.
2. Restrict it to your domain now (see trade-off #1 above) — you already know your project ID at this point, so you can add the exact `*.web.app` URL.
3. Check which model names your key currently has access to (they change over time — Google retires aliases, free-tier quota varies by model, and some aliases run overloaded/`503` for stretches at a time). `gemini-flash-lite-latest` / `gemini-embedding-001` are what's configured by default since they had the most reliable free-tier availability at setup time; adjust `geminiConfig` in `public/ordinex.html` if you see errors.

## 3. Configure

```bash
npm install -g firebase-tools   # if you don't already have it
firebase login

cp .env.example .env
# open .env and fill in the 5 Firebase values, plus GEMINI_API_KEY
```

## 4. Deploy — one command

```bash
npm run deploy
```

This:
1. Validates Node, the Firebase CLI, and that you're logged in
2. Writes `.firebaserc` and injects `firebaseConfig` + `geminiConfig` into `public/ordinex.html`
3. Selects your Firebase project
4. Deploys Firestore rules/indexes and Hosting — nothing else, so nothing here can ever ask for Blaze

You'll get a live URL: `https://YOUR_PROJECT_ID.web.app`.

**Prefer to do it by hand?** See §6 below for the manual steps.

---

## 5. Granting yourself platform admin access

Same as before: the Admin Console (cross-organization view) is
deliberately not reachable through any in-app action. Open Firebase
Console → Firestore Database → start a `platformAdmins` collection → add a
document whose **ID is your own Auth UID** (Authentication → Users) → any
field, e.g. `{ addedAt: <timestamp> }`. `firestore.rules` never lets a
client read or write this collection directly — only check their own
membership (`exists()`), which is what gates the nav item and the
cross-org queries. Do this only for people who should see every
customer's data.

---

## 6. Manual step-by-step (what `npm run deploy` automates)

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # select your project, alias it "default"
firebase deploy --only firestore:rules,firestore:indexes,hosting
```

Then manually edit `public/ordinex.html`: find `const firebaseConfig = {`
and `const geminiConfig = {` near the bottom of the last `<script>` block
and fill in your real values. Or run `npm run configure` to have
`scripts/configure.js` do just that file-editing part from `.env`.

---

## 7. Local development with the Firebase Emulator Suite

```bash
npm run emulate
```

Starts local Auth + Firestore emulators with a UI at `http://localhost:4000`.
Point the frontend at them by uncommenting the emulator-connector lines
near `fbApp = fb.initializeApp(...)` in `ordinex.html` (only during local
dev) — the same pattern as before, minus the Storage/Functions emulators,
which this build no longer uses.

---

## 8. Things you'll likely want to add next

- **Turning on invite emails.** `sendInvite` always creates the Firestore
  invite record (that's what actually grants access once the invitee
  signs up) and separately, optionally, emails it via
  [EmailJS](https://www.emailjs.com) — a service designed to be called
  with a public, domain-restrictable key straight from the browser, no
  backend required, same trade-off as the Gemini key already in this file.
  Free tier: 200 emails/month. To turn it on:
  1. Create a free EmailJS account and connect an email service (Gmail,
     Outlook, or your own SMTP).
  2. Create an email template with `{{to_email}}`, `{{org_name}}`,
     `{{role}}`, `{{inviter_name}}`, and `{{app_url}}` variables.
  3. Paste your Service ID, Template ID, and Public Key into
     `emailjsConfig` near the top of `public/ordinex.html` (next to
     `geminiConfig`).
  4. In EmailJS's dashboard, restrict the public key to your domain, the
     same way you'd restrict the Gemini key.

  Until configured, invites still work (the Firestore record is created
  and shows up as "Invited" in Team Management) — the invitee just isn't
  emailed, and the console logs that EmailJS isn't configured.
- **Real server-enforced rate limiting / abuse protection.** See trade-off
  #2 above — genuinely needs a server or Firebase App Check + Blaze.

## 9. Upgrading later, if you ever want to

If you decide the Blaze plan (or a non-Firebase backend) is worth it later:
- `functions-optional-blaze-upgrade/` is close to a working Cloud
  Functions backend again — see its own README.
- Re-enabling Cloud Storage lets you keep original uploaded files, not
  just extracted text.
- App Check + Blaze gets you real server-enforced rate limiting instead of
  the client-side throttle this build uses.

None of that is required to use this app for real today — it's just the
next rung up if your needs grow past what a fully static, free deployment
can offer.

## Project structure

```
.
├── package.json                Convenience scripts: npm run deploy / configure / emulate
├── .env.example                Copy to .env and fill in your real values
├── firebase.json                Firebase project config: hosting + firestore ONLY
├── .firebaserc                  Written automatically by `npm run configure`
├── firestore.rules              Firestore security rules (deny-by-default, org-scoped RBAC,
│                                 adapted for a no-Cloud-Functions build — see comments inline)
├── firestore.indexes.json       Composite indexes the app's queries need
├── scripts/
│   ├── configure.js             Injects .env values into .firebaserc + public/ordinex.html
│   └── deploy.sh                One-command deploy pipeline (rules + hosting only)
├── functions-optional-blaze-upgrade/   Old Cloud Functions backend — NOT deployed, kept
│                                        for reference only (see its README)
└── public/
    ├── ordinex.html             The entire frontend — Chart.js, jsPDF, the Firebase SDK,
    │                             AND now the Gemini calls / document pipeline / DOCX export
    │                             that used to live in Cloud Functions, all bundled inline
    └── vendor/                  Official pre-built browser bundles: pdf.js (+ its worker),
                                  mammoth.js, and docx.js — used for client-side PDF/DOCX
                                  text extraction and DOCX report export
```
