# NZ Skies Live

A live map of aircraft over New Zealand, using the free
[adsb.fi open data API](https://github.com/adsbfi/opendata) (the feed behind globe.adsb.fi).

Planes are drawn on a Leaflet/OpenStreetMap map, rotated to their track and
coloured by altitude. Click a plane (or a row in the list) for callsign, rego, type,
altitude, speed, vertical rate, squawk and so on, plus its trail since you opened the page
and a link to it on globe.adsb.fi. Emergency squawks (7500/7600/7700) are flagged and
sorted to the top. Positions are dead-reckoned between updates so movement looks smooth.
Works on phones, and has light and dark themes.

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
