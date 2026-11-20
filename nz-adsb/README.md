# NZ Skies Live

A live map of aircraft over New Zealand, using the free
[adsb.fi open data API](https://github.com/adsbfi/opendata) (the feed behind globe.adsb.fi).

Planes are drawn on a Leaflet/OpenStreetMap map, rotated to their track and
coloured by altitude. Click a plane (or a row in the list) for callsign, rego, type,
altitude, speed, vertical rate, squawk and so on, plus its trail since you opened the page
and a link to it on globe.adsb.fi. Emergency squawks (7500/7600/7700) are flagged and
sorted to the top. Positions are dead-reckoned between updates so movement looks smooth.
Works on phones, and has light and dark themes.

## Coverage: NZ first, plus Australia and the Pacific

The map opens on New Zealand. The **NZ / Australia / Pacific** buttons (top left) jump
between areas, and you can pan anywhere from Western Australia to Fiji. The aircraft list
and count show what's in view.

adsb.fi only answers "aircraft within 250 nm of a point", at most once a second, so the
region is covered by 34 overlapping circles (4 for NZ, 30 for Australia and the islands,
placed near airports so empty ocean isn't polled). The server only polls the circles
someone is looking at, and polls those near the middle of a view about seven times as
often as ones at its edges. In practice:

- The NZ view refreshes every few seconds, as before.
- Wider views refresh more slowly (all of Australia: roughly every 30-40 s). The header
  shows "~N s updates" when it's 8 s or more, and aircraft keep moving smoothly in between.
- All viewers share the one-request-a-second budget, so several people looking at
  different areas slows things for everyone.
- **Pacific coverage is thin.** adsb.fi depends on volunteer receivers, and at the time of
  writing it has almost nothing around Fiji, Vanuatu, Norfolk Island or Tonga. The circles
  are there, so aircraft appear if receivers come online.

## Layers

The **Layers** panel at the top right of the map (collapsed by default on phones) has:

- **Airport weather**: the latest METAR at each NZ airport, coloured by flight category
  (VFR / MVFR / IFR / LIFR) and labelled with the wind. Click one for the decoded report,
  the raw METAR and the TAF. Data comes from NOAA's Aviation Weather Center through
  `server.js` (`/api/airports`, cached 10 minutes), because aviationweather.gov doesn't
  allow browser requests. It covers about 80 airports across the region, but only the
  ones each country shares internationally: for NZ that's Auckland, Hamilton, Ohakea,
  Wellington, Christchurch, Queenstown and Dunedin. The smaller NZ stations are only
  published by MetService, which needs a login or a paid key. Zoomed out, airports
  show as dots; zoom in for codes and winds.
- **Rain radar**: the last two hours of radar in 10-minute frames from
  [RainViewer](https://www.rainviewer.com/), with play/pause and a time slider. The browser
  fetches it directly. RainViewer's free tier stops at zoom 7, so closer in, the zoom-7 images
  are enlarged.
- **Wind**: see below.

## Wind layer

The **Wind** box at the top right of the map overlays forecast winds at the surface,
~5,000 ft (850 hPa), ~18,000 ft (500 hPa) or ~34,000 ft (250 hPa). Flowing particles show
direction and a colour tint shows speed in knots. Point at (or tap) the map for the wind at
that spot.

Wind data comes from [Open-Meteo](https://open-meteo.com/) (free, no key, CC BY 4.0). The
browser fetches it directly rather than `server.js`, because Open-Meteo's free allowance
(10,000 calls a day, 600 a minute) is counted per IP address and hosting providers share
IPs between customers. The grid follows the map: up to ~300 points over the view, finer
when zoomed in, cached in the browser for 3 hours, and fetched at most twice a minute,
so after a big pan it can take up to 35 s for the new area to fill in. Nothing is
fetched while the layer is off.

## Run it

Needs Node 18 or newer. There are no dependencies to install.

```sh
cd nz-adsb
node server.js          # then open http://localhost:8080
PORT=3000 node server.js
```

## Why there's a server

`opendata.adsb.fi` doesn't send CORS headers, so a web page can't fetch it directly.
`server.js` does the fetching and serves the page and a merged feed from the same origin:

- The API caps each query at a 250 nm radius, so NZ is covered by four overlapping
  circles (Northland/Auckland, central North Island, upper and lower South Island).
- It cycles through them about once a second, within adsb.fi's 1 request/second limit,
  merges duplicates (keeping the freshest position) and serves the result at `/api/aircraft`.
- All viewers share one upstream poll. Polling pauses after 2 minutes with no viewers.

Any host that runs Node works (a Raspberry Pi, Fly.io, Render, a small VPS and so on).

## Deploy free on Render

The repo root has a `render.yaml` Blueprint for this app.

1. Sign in at render.com with GitHub and give it access to this repo.
2. **New → Blueprint**, pick this repo and the branch that holds `nz-adsb/`, then **Apply**.
3. Open the `onrender.com` URL it gives you.

On the free plan the service sleeps after about 15 minutes without visitors, and the
next visit takes 30–60 seconds to wake it. Render's health checks use `/healthz`, which
deliberately doesn't start the adsb.fi poller.
