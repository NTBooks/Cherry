# 雪月花 — Sakura Snow Globe

A cel-shaded, looping 3D screensaver that runs as a web page: the respected
grave of a samurai. A katana stands in the earth of a stone-fenced cherry
grove, and the camera keeps a slow vigil around it while the seasons turn:
summer → autumn leaf-fall → bare winter snow → spring cherry blossoms, and
around again. Inspired by the Borderlands ink-line look.

Each season holds four full day/night cycles — the sun rises and sets (shadows
sweep with it), and a big full moon climbs the sky opposite it, throwing cool
moon-shadows while the stone lanterns wake. At low sun and under the moon,
god-ray shafts filter through the canopies. Weather rolls through in random
episodes: rain brings a flat overcast sky, soaks the ground dark with a glossy
specular sheen, and leaves sky-reflecting puddles that slowly dry; snow squalls
roll through winter; and on some clear summer nights, fireflies. Far overhead,
bird flocks migrate south through autumn and back north in spring.

Cherry buds open green in the spring daylight (growth pauses overnight), blush
pink as they swell, and shed in a petal storm lasting exactly one day — every
tuft grows on a permanent twig lattice, so nothing floats; in winter the bare
twigs stay, frosting pale and carrying a coat of rime. One winter morning a
visitor's footprints appear in the snow — in from the grove edge, a kneeling
depression before the blade, and back out — filling in under fresh snowfall
and vanishing with the melt. The katana wears a
wind-blown tassel, and an anime-style gleam traces its edge. A stone fence
rings the garden, and beside the sword sits an incense bowl: on autumn's second
day three sticks appear and burn down across that full day and night, their
smoke riding the wind — and the sky always stays clear for it.

The cherry trees carry their foliage as textured cluster cards (each painted tuft
has its own alpha level), so blossoms bloom on bare branches tuft by tuft, storm
off as petal particles at the spring→summer turn, give way to green leaves that
blaze orange and strip away through autumn — clusters rot out via an animated
alpha cutoff rather than shrinking. Gnarled tapered trunks with procedural cherry
bark, a drifting two-layer cloud sky, perlin-noise ground, leaf-litter carpets,
and a mirror-polished blade (environment-mapped, dimming with the daylight)
round out the detail pass.

Everything is procedural — no model or texture downloads. Three.js r184 is vendored
in `vendor/`, so the whole thing works offline.

## Run it

Double-click **`Start Screensaver.cmd`** — it starts a tiny local server
(PowerShell, port 8423) and opens the page in your default browser.

Or serve the folder with anything else:

```
cd snowglobe
python -m http.server 8423        # or: npx serve -p 8423
```

then open <http://localhost:8423/>. (A plain `file://` open won't work — ES modules
require http.)

For a chromeless window, try `msedge --app=http://localhost:8423/`.

## Controls

| Input | Effect |
| --- | --- |
| (nothing) | slow orbit, four day/night cycles per season (~96 s each), loops forever |
| drag | look around; the orbit gently reclaims the camera |
| tap / click | a gust of wind stirs petals, leaves, and snow |
| double-click | toggle fullscreen |
| `1` `2` `3` `4` | fast-forward to summer / autumn / winter / spring |
| `+` / `−` | time speed, ±10 per press (−100 = real time, 1 day = 24 h; +100 = 1 day = 1 s; default +40 ≈ 30 s days) |
| `Space` | pause / resume |

The cursor hides itself after a few seconds of stillness.

## Tuning

All the knobs live at the top of `main.js` in `CONFIG`: season length, orbit speed
and radius, particle counts, pixel-ratio cap. The scene layout is seeded
(`mulberry32(20260611)`), so the grove is the same on every run — change the seed
for a different grove.

## Files

```
index.html              shell: importmap, vignette/grain overlays, season label
main.js                 the entire scene (~1000 lines, ES module)
serve.ps1               minimal static file server (no dependencies)
Start Screensaver.cmd   double-click launcher
vendor/                 three.js r184 (module build + core + BufferGeometryUtils)
```
