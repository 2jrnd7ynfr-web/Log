# Recovery Doses

A single-file, phone-first web app for logging tramadol, celecoxib and
paracetamol doses during surgery recovery.

- One-tap dose logging per medication, with an "earlier time" option
- "Ready" / "next dose from" status based on a configurable minimum gap
- Rolling 24-hour totals against a configurable per-medication limit,
  with soft warnings (logging is never blocked — the record reflects reality)
- Day-grouped history with edit/delete, plain-text export for a care team
- All data stays in the browser's localStorage; nothing is sent anywhere

Everything lives in `index.html` — no build step, no dependencies beyond
Google Fonts.
