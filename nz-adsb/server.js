// NZ Skies Live — tiny server that relays the adsb.fi open data feed for New Zealand,
// Australia and the south-west Pacific out to Fiji.
//
// opendata.adsb.fi doesn't send CORS headers, so browsers can't call it directly.
// It answers "aircraft within 250 nm of a point" at most once a second, so the
// region is covered by overlapping circles and the server only polls the circles
// someone is currently looking at (NZ by default). It merges the results and
// serves them, plus the static page, from the same origin.
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
const WANTED_FOR_MS = 15 * 1000; // keep polling a circle this long after a viewer asked for it
// Circles near the middle of someone's view are polled this many times as often as
// ones only clipping its edges, so the area you're looking at stays fresh
const EDGE_WEIGHT = 0.15;
const DROP_AFTER_S = 120; // forget aircraft not reported for this long

// Overlapping 250 nm circles. Longitudes run past 180 (Fiji) so the region is continuous.
const NZ_CIRCLES = [
  [-36.2, 174.6], // Northland / Auckland
  [-39.4, 176.0], // Central North Island
  [-42.6, 172.6], // Upper South Island
  [-45.6, 169.4], // Lower South Island
];
// Australia and the Pacific islands to Fiji: a honeycomb of circles, keeping only
// those near an airport with a weather station (so empty ocean isn't polled).
const OTHER_CIRCLES = [
  [-10.0, 130.8], [-10.0, 137.8], [-16.0, 120.7], [-16.0, 127.8],
  [-16.0, 134.9], [-16.0, 142.0], [-16.0, 170.4], [-17.0, 178.6],
  [-22.0, 117.4], [-22.0, 124.7], [-22.0, 132.1], [-22.0, 139.5],
  [-22.0, 146.8], [-22.0, 154.2], [-22.0, 161.6], [-22.0, 169.0],
  [-28.0, 113.9], [-28.0, 121.6], [-28.0, 129.3], [-28.0, 137.1],
  [-28.0, 144.8], [-28.0, 152.6], [-28.0, 160.3], [-28.0, 168.0],
  [-34.0, 118.2], [-34.0, 134.7], [-34.0, 143.0], [-34.0, 151.2],
  [-40.0, 141.2], [-40.0, 150.1],
];
const CIRCLES = [...NZ_CIRCLES, ...OTHER_CIRCLES].map(([lat, lon], i) => ({
  i, lat, lon, wantedUntil: 0, coreUntil: 0, polledAt: 0, nz: i < NZ_CIRCLES.length,
}));

const aircraftByHex = new Map(); // hex -> { ac, posTime, seenTime }
let lastOkAt = 0;
let lastError = null;
let polling = false;

const toRad = (d) => (d * Math.PI) / 180;
function distNm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(toRad(lat1)) * Math.sin(toRad(lat2)) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon1 - lon2));
  return Math.acos(Math.min(1, Math.max(-1, a))) * 3440.065;
}
// Distance from a circle centre to the nearest point of a lat/lon box
function distToBoxNm(c, box) {
  const lat = Math.min(Math.max(c.lat, box.s), box.n);
  const lon = Math.min(Math.max(c.lon, box.w), box.e);
  return distNm(c.lat, c.lon, lat, lon);
}
const normLon = (lon) => (lon < 0 ? lon + 360 : lon);

// The middle half of a box (a quarter trimmed from each side)
function innerBox(box) {
  const dLat = (box.n - box.s) / 4, dLon = (box.e - box.w) / 4;
  return { s: box.s + dLat, n: box.n - dLat, w: box.w + dLon, e: box.e - dLon };
}
// Which circles a view needs, and which of those are near its middle
function circlesFor(box) {
  if (!box) return CIRCLES.filter((c) => c.nz).map((c) => ({ c, core: true }));
  const inner = innerBox(box);
  return CIRCLES.filter((c) => distToBoxNm(c, box) < RADIUS_NM)
    .map((c) => ({ c, core: distToBoxNm(c, inner) < RADIUS_NM }));
}

function markWanted(box) {
  const until = Date.now() + WANTED_FOR_MS;
  for (const { c, core } of circlesFor(box)) {
    c.wantedUntil = until;
    if (core) c.coreUntil = until;
  }
}

async function pollCircle(c) {
  const lon = c.lon > 180 ? +(c.lon - 360).toFixed(2) : c.lon;
  const res = await fetch(`${API}/lat/${c.lat}/lon/${lon}/dist/${RADIUS_NM}`, {
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
  for (const ac of data.aircraft || data.ac || []) {
    if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue;
    // The same aircraft appears in overlapping circles; keep the freshest position
    const posTime = now - (ac.seen_pos ?? ac.seen ?? 0);
    const prev = aircraftByHex.get(ac.hex);
    if (prev && prev.posTime >= posTime) continue;
    const { dst, dir, ...rest } = ac;
    aircraftByHex.set(ac.hex, { ac: { ...rest, lon: normLon(ac.lon) }, posTime, seenTime: now - (ac.seen ?? 0) });
  }
  c.polledAt = Date.now();
  lastOkAt = Date.now();
  lastError = null;
}

async function loop() {
  const now = Date.now();
  // Poll the wanted circle that is most overdue (edge circles count as less urgent);
  // stop when nobody is watching
  const wanted = CIRCLES.filter((c) => c.wantedUntil > now);
  if (!wanted.length) {
    polling = false;
    return;
  }
  const urgency = (c) => (now - c.polledAt) * (c.coreUntil > now ? 1 : EDGE_WEIGHT);
  wanted.sort((a, b) => urgency(b) - urgency(a));
  let wait = REQUEST_GAP_MS;
  try {
    await pollCircle(wanted[0]);
  } catch (e) {
    lastError = e.message;
    wait = e.backoff || 3000;
    console.warn(`[adsb.fi] ${e.message}`);
  }
  const cutoff = Date.now() / 1000 - DROP_AFTER_S;
  for (const [hex, a] of aircraftByHex) if (a.seenTime < cutoff) aircraftByHex.delete(hex);
  setTimeout(loop, wait);
}

function ensurePolling(box) {
  markWanted(box);
  if (!polling) {
    polling = true;
    loop();
  }
}

// Aircraft inside the box (whole cache if no box), with times relative to "now"
function snapshot(box) {
  const now = Date.now() / 1000;
  const aircraft = [];
  for (const { ac, posTime, seenTime } of aircraftByHex.values()) {
    if (box && (ac.lat < box.s || ac.lat > box.n || ac.lon < box.w || ac.lon > box.e)) continue;
    aircraft.push({ ...ac, seen_pos: +(now - posTime).toFixed(1), seen: +(now - seenTime).toFixed(1) });
  }
  // Roughly how often the middle of the view refreshes, so the page can say so
  // (each poll takes one slot; edge circles take a fraction of the slots)
  const t = Date.now();
  const load = CIRCLES.reduce((sum, c) => sum + (c.wantedUntil > t ? (c.coreUntil > t ? 1 : EDGE_WEIGHT) : 0), 0);
  return {
    now, aircraft, ok: !!lastOkAt, lastOkAt, error: lastError,
    cycleSeconds: Math.max(1, Math.round(load * REQUEST_GAP_MS / 1000)),
    circlesInView: circlesFor(box).length,
  };
}

function parseBox(q) {
  const v = (q || "").split(",").map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  const [s, w, n, e] = v;
  if (s >= n || w >= e) return null;
  return { s, w, n, e };
}

// ---------- Airport weather (METAR/TAF from NOAA's Aviation Weather Center) ----------
// aviationweather.gov sends no CORS headers, so the browser can't call it directly.
// It only has the airports each country shares internationally (for NZ, the main
// ones). Bounding-box queries return an incomplete set, so every aerodrome with a
// weather station in the region is asked for by code; whichever report are shown.
const AWC = "https://aviationweather.gov/api/data";
const STATION_IDS = [
  "NFFN", "NFKD", "NFLB", "NFNA", "NFNK", "NFNL", "NFNM", "NFNR", "NFNS", "NFVB", "NLWF", "NVSC",
  "NVSG", "NVSL", "NVSP", "NVSS", "NVVA", "NVVV", "NVVW", "NWWD", "NWWE", "NWWK", "NWWL", "NWWM",
  "NWWN", "NWWR", "NWWU", "NWWV", "NWWW", "NZAA", "NZCH", "NZDN", "NZGS", "NZHK", "NZHN", "NZKI",
  "NZNP", "NZNV", "NZOH", "NZPP", "NZQN", "NZRO", "NZTG", "NZWN", "NZWP", "YABA", "YAMB", "YARG",
  "YAYE", "YAYT", "YBAF", "YBAS", "YBBN", "YBCG", "YBCS", "YBCV", "YBDV", "YBGL", "YBHI", "YBHM",
  "YBLN", "YBMA", "YBMK", "YBNA", "YBOK", "YBPN", "YBRK", "YBRM", "YBSU", "YBTL", "YBUD", "YBWP",
  "YBWW", "YBWX", "YCAR", "YCAS", "YCBA", "YCBB", "YCBP", "YCCY", "YCDU", "YCFS", "YCIN", "YCNM",
  "YCOM", "YDBY", "YDGV", "YDPO", "YDTC", "YDYL", "YEML", "YESP", "YFLI", "YFRT", "YGEL", "YGFN",
  "YGLA", "YGTE", "YGTH", "YHBA", "YHID", "YHUG", "YKRY", "YKSC", "YLEC", "YLHI", "YLIS", "YLRE",
  "YMAV", "YMAY", "YMDG", "YMEK", "YMEN", "YMER", "YMES", "YMHB", "YMIA", "YMLT", "YMLV", "YMMB",
  "YMMI", "YMML", "YMNG", "YMOR", "YMTG", "YMWY", "YNAR", "YNBR", "YNTN", "YNWN", "YOLD", "YPAD",
  "YPAL", "YPBH", "YPBO", "YPCD", "YPDB", "YPDN", "YPEA", "YPED", "YPFT", "YPGN", "YPGV", "YPJT",
  "YPKA", "YPKG", "YPKU", "YPLM", "YPMQ", "YPMR", "YPPD", "YPPF", "YPPH", "YPTN", "YPWR", "YRMD",
  "YSBK", "YSCB", "YSCM", "YSCN", "YSDU", "YSNF", "YSNW", "YSRI", "YSSY", "YSTW", "YSWG", "YSWM",
  "YSWS", "YTEF", "YTMU", "YTNK", "YTRE", "YWGT", "YWHA", "YWLM", "YWLP",
].join(",");
const AIRPORT_TTL_MS = 10 * 60 * 1000;
let airportCache = { fetchedAt: 0, airports: [], error: null };
let airportFetch = null;

async function awc(endpoint) {
  const res = await fetch(`${AWC}/${endpoint}`, {
    headers: { "User-Agent": "nz-skies-live/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`aviationweather.gov HTTP ${res.status}`);
  return res.json();
}

async function fetchAirports() {
  const [metars, tafs] = await Promise.all([
    awc(`metar?ids=${STATION_IDS}&format=json&hours=3`),
    awc(`taf?ids=${STATION_IDS}&format=json`).catch(() => []),
  ]);
  // Several hours are requested so hourly reporters are included; keep the newest per airport
  const latest = new Map();
  for (const m of metars) {
    const prev = latest.get(m.icaoId);
    if (!prev || m.obsTime > prev.obsTime) latest.set(m.icaoId, m);
  }
  const tafBy = new Map();
  for (const t of tafs) {
    const prev = tafBy.get(t.icaoId);
    if (!prev || t.issueTime > prev.issueTime) tafBy.set(t.icaoId, t);
  }
  const toUnix = (v) => (typeof v === "number" ? v : Math.floor(Date.parse(v) / 1000));
  const cleanName = (n) => String(n || "").replace(/,\s*[A-Z]{2,3},\s*[A-Z]{2}$/, "").replace(/\bIntl\b/, "International").replace(/\bArpt\b/, "Airport");
  const ids = new Set([...latest.keys(), ...tafBy.keys()]);
  return [...ids].sort().flatMap((icao) => {
    const m = latest.get(icao);
    const t = tafBy.get(icao);
    const base = m || t;
    // NZ codes also cover Antarctic fields (e.g. NZFX McMurdo), which are off this map
    if (!(base.lat > -53 && base.lat < -5)) return [];
    return [{
      icao,
      name: cleanName(base.name),
      lat: base.lat,
      lon: normLon(base.lon), // east of 180° (eastern Fiji) continues past 180
      metar: m ? {
        raw: m.rawOb, obsTime: toUnix(m.obsTime), fltCat: m.fltCat || null,
        wdir: m.wdir, wspd: m.wspd, wgst: m.wgst, visib: m.visib,
        clouds: m.clouds || [], cover: m.cover, wxString: m.wxString || null,
        temp: m.temp, dewp: m.dewp, altim: m.altim,
      } : null,
      taf: t ? { raw: t.rawTAF, issueTime: toUnix(t.issueTime) } : null,
    }];
  });
}

async function getAirports() {
  if (Date.now() - airportCache.fetchedAt < AIRPORT_TTL_MS) return airportCache;
  if (!airportFetch) {
    airportFetch = fetchAirports()
      .then((airports) => { airportCache = { fetchedAt: Date.now(), airports, error: null }; })
      .catch((e) => {
        console.warn(`[aviationweather] ${e.message}`);
        // Keep serving the last good data, and retry in a minute rather than on every request
        airportCache = { ...airportCache, error: e.message, fetchedAt: Date.now() - AIRPORT_TTL_MS + 60000 };
      })
      .finally(() => { airportFetch = null; });
  }
  await airportFetch;
  return airportCache;
}

// ---------- Flight routes (origin/destination) from hexdb.io ----------
// ADS-B doesn't carry a route, so it's looked up by callsign in hexdb.io's free
// community database. Cached here so hovering costs one lookup per flight, shared
// by all viewers. The database can be out of date, so the page also checks the
// route is plausible for where the aircraft actually is.
const HEXDB = "https://hexdb.io";
const ROUTE_TTL_MS = 6 * 3600 * 1000;
const ROUTE_MISS_TTL_MS = 3600 * 1000;
const routeCache = new Map(); // callsign -> { at, value, ttl }
const routeAirportCache = new Map(); // icao -> airport info or null
const inflight = new Map();

async function hexdb(pathAndQuery) {
  const res = await fetch(`${HEXDB}${pathAndQuery}`, {
    headers: { "User-Agent": "nz-skies-live/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`hexdb.io HTTP ${res.status}`);
  return res;
}

// Trim "Christchurch International Airport" to "Christchurch" for a short label
function shortAirportName(name) {
  return String(name || "")
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\b(International|Intl|Domestic|Regional|Municipal|Airport|Aerodrome|Airfield|Air Base)\b/gi, "")
    .replace(/\s{2,}/g, " ").trim();
}

async function airportInfo(icao) {
  if (routeAirportCache.has(icao)) return routeAirportCache.get(icao);
  let info = null;
  try {
    const a = await (await hexdb(`/api/v1/airport/icao/${encodeURIComponent(icao)}`)).json();
    if (a && a.icao) {
      info = {
        icao: a.icao, iata: a.iata || null, name: a.airport || a.icao,
        short: shortAirportName(a.airport) || a.region_name || a.icao,
        country: a.country_code || null, lat: a.latitude, lon: a.longitude,
      };
    }
  } catch (e) {
    console.warn(`[hexdb] airport ${icao}: ${e.message}`);
    return null; // don't cache failures
  }
  routeAirportCache.set(icao, info);
  return info;
}

async function lookupRoute(callsign) {
  // hexdb answers an unknown callsign with 404 "n/a": that's "no route", not a failure
  const res = await fetch(`${HEXDB}/callsign-route?callsign=${encodeURIComponent(callsign)}`, {
    headers: { "User-Agent": "nz-skies-live/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { callsign, airports: [] };
  if (!res.ok) throw new Error(`hexdb.io HTTP ${res.status}`);
  const text = (await res.text()).trim();
  const codes = text.split("-").map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z0-9]{4}$/.test(c));
  if (codes.length < 2) return { callsign, airports: [] };
  const airports = await Promise.all(codes.map(airportInfo));
  return { callsign, airports: airports.filter(Boolean) };
}

async function getHexdbRoute(callsign) {
  const hit = routeCache.get(callsign);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  if (inflight.has(callsign)) return inflight.get(callsign);
  const p = lookupRoute(callsign)
    .then((value) => {
      routeCache.set(callsign, { at: Date.now(), value, ttl: value.airports.length >= 2 ? ROUTE_TTL_MS : ROUTE_MISS_TTL_MS });
      if (routeCache.size > 5000) routeCache.delete(routeCache.keys().next().value);
      return value;
    })
    .finally(() => inflight.delete(callsign));
  inflight.set(callsign, p);
  return p;
}

// ---------- Flight routes from adsb.im (primary, when a contact email is configured) ----------
// adsb.im's route database (vradarserver standing data + live ACARS) has better coverage
// than hexdb.io. Its terms: a User-Agent that lets its maintainers contact you, plain
// http (not https, to reduce their load), and callsigns batched for at least 30 s per
// request. So the server collects callsigns (from hovers, and pre-fetches airline
// flights it's tracking) and sends one batch every 30 s; hexdb.io answers meanwhile.
// The contact address comes from the ROUTE_CONTACT_EMAIL environment variable (set it
// in the Render dashboard) so it isn't written into the code. Without it, only
// hexdb.io is used.
const ROUTE_CONTACT = (process.env.ROUTE_CONTACT_EMAIL || "").trim();
const ADSBIM_URL = process.env.ADSBIM_URL || "http://adsb.im/api/0/routeset";
const ADSBIM_BATCH_MS = 30 * 1000;
const ADSBIM_MAX_BATCH = 100;
const adsbimCache = new Map(); // callsign -> { at, ttl, value: { callsign, airports } }
const adsbimQueue = new Map(); // callsign -> { lat, lng }
let adsbimPausedUntil = 0;

const toApiLon = (lon) => (lon > 180 ? +(lon - 360).toFixed(4) : lon);
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d{1,4}[A-Z]{0,2}$/;

function adsbimFresh(cs) {
  const hit = adsbimCache.get(cs);
  return hit && Date.now() - hit.at < hit.ttl ? hit : null;
}
function queueAdsbim(cs, lat, lng) {
  if (!ROUTE_CONTACT || adsbimFresh(cs)) return false;
  adsbimQueue.set(cs, { lat: +(+lat || 0).toFixed(4), lng: toApiLon(+lng || 0) });
  return true;
}

// Turn one adsb.im route object into our airport list (tolerating field variations)
async function adsbimAirports(r) {
  if (!r || typeof r !== "object" || r.plausible === false || r.plausible === 0) return [];
  if (Array.isArray(r._airports) && r._airports.length >= 2) {
    return r._airports.map((a) => ({
      icao: a.icao || null, iata: a.iata || null, name: a.name || a.icao || "",
      short: a.location || shortAirportName(a.name) || a.icao,
      country: a.countryiso2 || null, lat: a.lat, lon: a.lon,
    })).filter((a) => typeof a.lat === "number" && typeof a.lon === "number");
  }
  // Only codes given: resolve them via hexdb's airport lookup
  const codes = String(r.airport_codes || "").split("-").filter((c) => /^[A-Z0-9]{4}$/.test(c));
  if (codes.length < 2) return [];
  return (await Promise.all(codes.map(airportInfo))).filter(Boolean);
}

async function adsbimBatch() {
  if (!ROUTE_CONTACT || Date.now() < adsbimPausedUntil) return;
  // Pre-fetch airline flights currently being tracked, so routes are ready before a hover
  if (polling) {
    const cutoff = Date.now() / 1000 - 60;
    for (const { ac, seenTime } of aircraftByHex.values()) {
      const cs = (ac.flight || "").trim();
      if (seenTime > cutoff && AIRLINE_CALLSIGN.test(cs) && !adsbimQueue.has(cs)) queueAdsbim(cs, ac.lat, ac.lon);
    }
  }
  if (!adsbimQueue.size) return;
  const batch = [...adsbimQueue].slice(0, ADSBIM_MAX_BATCH);
  const planes = batch.map(([callsign, p]) => ({ callsign, lat: p.lat, lng: p.lng }));
  try {
    const res = await fetch(ADSBIM_URL, {
      method: "POST",
      headers: {
        "User-Agent": `nz-skies-live/1.0 (contact: ${ROUTE_CONTACT})`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ planes }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
      // Refused or overloaded: back off rather than retrying every 30 s
      adsbimPausedUntil = Date.now() + (res.status === 403 ? 3600e3 : 5 * 60e3);
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    const out = await res.json();
    if (!Array.isArray(out)) throw new Error("unexpected response");
    // Same length and order as the request; tolerate entries that name their callsign
    await Promise.all(batch.map(async ([cs], i) => {
      const r = out.find((x) => x && x.callsign === cs) || out[i];
      const airports = await adsbimAirports(r && (!r.callsign || r.callsign === cs) ? r : null);
      adsbimCache.set(cs, {
        at: Date.now(), ttl: airports.length >= 2 ? ROUTE_TTL_MS : ROUTE_MISS_TTL_MS,
        value: { callsign: cs, airports },
      });
      adsbimQueue.delete(cs);
    }));
    if (adsbimCache.size > 8000) adsbimCache.delete(adsbimCache.keys().next().value);
  } catch (e) {
    console.warn(`[adsb.im] ${e.message}`);
  }
}
if (ROUTE_CONTACT) {
  setInterval(adsbimBatch, ADSBIM_BATCH_MS).unref();
  console.log("Route lookups: adsb.im (batched) with hexdb.io fallback");
} else {
  console.log("Route lookups: hexdb.io (set ROUTE_CONTACT_EMAIL to also use adsb.im)");
}

// adsb.im if it has the route; otherwise hexdb.io now, with adsb.im queued for next batch
async function getRoute(cs, lat, lng) {
  const im = adsbimFresh(cs);
  if (im && im.value.airports.length >= 2) return { ...im.value, source: "adsb.im" };
  const pending = !im && lat != null && queueAdsbim(cs, lat, lng);
  try {
    const hx = await getHexdbRoute(cs);
    return { ...hx, source: hx.airports.length >= 2 ? "hexdb.io" : null, pending };
  } catch (e) {
    if (pending) return { callsign: cs, airports: [], source: null, pending };
    throw e;
  }
}

const PAGE = path.join(__dirname, "index.html");

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/healthz") {
      // For hosting health checks: deliberately doesn't wake the adsb.fi poller
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end("ok");
    }
    if (url.pathname === "/api/route") {
      const cs = String(url.searchParams.get("callsign") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(obj));
      };
      if (!/^[A-Z0-9]{3,8}$/.test(cs)) return send(400, { error: "bad callsign" });
      const lat = parseFloat(url.searchParams.get("lat"));
      const lon = parseFloat(url.searchParams.get("lon"));
      const pos = Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : [null, null];
      return getRoute(cs, ...pos).then((r) => send(200, r), (e) => {
        console.warn(`[route] ${cs}: ${e.message}`);
        send(502, { error: "Route lookup unavailable" });
      });
    }
    if (url.pathname === "/api/airports") {
      return getAirports().then((c) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({
          fetchedAt: Math.floor((c.airports.length ? c.fetchedAt : Date.now()) / 1000),
          airports: c.airports,
          error: c.error,
        }));
      });
    }
    if (url.pathname === "/api/aircraft") {
      // ?box=south,west,north,east (longitudes may run past 180); without it, NZ
      const box = parseBox(url.searchParams.get("box"));
      ensurePolling(box);
      const body = JSON.stringify(snapshot(box));
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
