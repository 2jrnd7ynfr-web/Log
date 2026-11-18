// NZ Skies Live — tiny server that relays the adsb.fi open data feed for New Zealand.
//
// opendata.adsb.fi doesn't send CORS headers, so browsers can't call it directly.
// This server polls it (respecting the 1 request/second limit), merges the
// overlapping regional queries into one NZ-wide snapshot, and serves that plus
// the static page from the same origin.
//
// Usage: node server.js            (Node 18+; no dependencies)
//        PORT=8080 node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const API = "https://opendata.adsb.fi/api/v2";
const RADIUS_NM = 250; // API maximum
const REQUEST_GAP_MS = 1100; // adsb.fi asks for at most 1 request per second
const IDLE_AFTER_MS = 2 * 60 * 1000; // stop polling when nobody is watching

// Overlapping 250 nm circles that together cover the NZ mainland and surrounds
const REGIONS = [
  { name: "Northland / Auckland", lat: -36.2, lon: 174.6 },
  { name: "Central North Island", lat: -39.4, lon: 176.0 },
  { name: "Upper South Island", lat: -42.6, lon: 172.6 },
  { name: "Lower South Island", lat: -45.6, lon: 169.4 },
];

const regionData = REGIONS.map(() => ({ now: 0, aircraft: [] }));
let regionIdx = 0;
let lastClientAt = 0;
let lastOkAt = 0;
let lastError = null;
let polling = false;

async function pollOnce() {
  const i = regionIdx;
  regionIdx = (regionIdx + 1) % REGIONS.length;
  const r = REGIONS[i];
  const url = `${API}/lat/${r.lat}/lon/${r.lon}/dist/${RADIUS_NM}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "nz-skies-live/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) {
    const err = new Error("rate limited");
    err.backoff = 5000;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const now = typeof data.now === "number" ? (data.now > 1e11 ? data.now / 1000 : data.now) : Date.now() / 1000;
  regionData[i] = { now, aircraft: data.aircraft || data.ac || [] };
  lastOkAt = Date.now();
  lastError = null;
}

async function loop() {
  if (Date.now() - lastClientAt > IDLE_AFTER_MS) {
    polling = false;
    return;
  }
  let wait = REQUEST_GAP_MS;
  try {
    await pollOnce();
  } catch (e) {
    lastError = e.message;
    wait = e.backoff || 3000;
    console.warn(`[adsb.fi] ${e.message}`);
  }
  setTimeout(loop, wait);
}

function ensurePolling() {
  lastClientAt = Date.now();
  if (!polling) {
    polling = true;
    loop();
  }
}

// Merge regions: the same aircraft appears in overlapping circles; keep the
// freshest position report, with times normalised to absolute epoch seconds.
function snapshot() {
  const byHex = new Map();
  let newest = 0;
  for (const { now, aircraft } of regionData) {
    if (!now) continue;
    newest = Math.max(newest, now);
    for (const ac of aircraft) {
      if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue;
      const posTime = now - (ac.seen_pos ?? ac.seen ?? 0);
      const prev = byHex.get(ac.hex);
      if (prev && prev._posTime >= posTime) continue;
      byHex.set(ac.hex, { ...ac, _posTime: posTime, _seenTime: now - (ac.seen ?? 0) });
    }
  }
  const now = newest || Date.now() / 1000;
  const aircraft = [...byHex.values()].map(({ _posTime, _seenTime, dst, dir, ...ac }) => ({
    ...ac,
    seen_pos: +(now - _posTime).toFixed(1),
    seen: +(now - _seenTime).toFixed(1),
  }));
  return { now, aircraft, ok: !!lastOkAt, lastOkAt, error: lastError };
}

const PAGE = path.join(__dirname, "index.html");

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/aircraft") {
      ensurePolling();
      const body = JSON.stringify(snapshot());
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(body);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      ensurePolling(); // warm the feed while the page loads
      return fs.readFile(PAGE, (err, buf) => {
        if (err) {
          res.writeHead(500);
          return res.end("index.html missing");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(buf);
      });
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  })
  .listen(PORT, () => {
    console.log(`NZ Skies Live → http://localhost:${PORT}`);
  });
