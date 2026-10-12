# Not used by this build

This folder is the original Cloud Functions backend. It is **not deployed**
by `npm run deploy` and `firebase.json` no longer references it — this
project now runs entirely on the free Spark plan, with all the logic that
used to live here (Gemini calls, document text extraction, report/DOCX
generation, rate limiting, etc.) moved into `public/ordinex.html` and
running directly in the browser instead. See `SETUP.md` at the project
root for the full explanation of why, and what the trade-offs are.

It's kept here only as a reference / upgrade path: if you later decide the
Blaze plan is worth it for you (hidden API key, server-enforced rate
limits, storing original uploaded files), this is close to a working
starting point again — you'd need to point it at Cloud Storage triggers
once you re-enable Storage, and re-add `"functions"` and `"storage"` blocks
to `firebase.json`.
