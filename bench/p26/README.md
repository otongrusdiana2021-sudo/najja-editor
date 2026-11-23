# P2-6 — preview cut to cut: own decoder vs `<video>` elements

Measures what the owner saw on an iPad: a timeline of many short jump cuts playing in the preview. It checks the
**picture actually drawn**, not a counter. Every frame of the test video shows a white bar at `x = frame % 30`, so the
canvas tells which source frame is on screen. That frame is compared with the one the timeline asks for.

The scenario is the same as `bench/run.mjs` B9: 30 cuts of 0.45 s, each 1.1 s further into the file. `bench/run.mjs`
needs ffmpeg (fixtures, light copies). These tools do not, so they also run on a Mac without it.

## Files

| File | What it does |
|---|---|
| `mkvideo.swift` | Makes the test video on macOS (AVFoundation): H.264 Main 1280×720 30 fps, a keyframe every 15 frames, no B-frames, moov first, AAC stereo. These are the settings of the server's light copy (`lib/media-proxy.js`). Run `swiftc -O mkvideo.swift -o mkvideo && ./mkvideo cuts.mp4 40` |
| `measure.js` | Injected into the editor. `__measure(secs)` plays the project and counts wrong pictures, cuts whose first picture is wrong, freezes over 100 ms, and buffering. `__seeks(n)` runs paused seeks and records the time to the exact frame and whether the frame is right |
| `run.mjs` | A/B in headless Chromium (Playwright), desktop or iPad profile (CPU 2× slower) |
| `h2proxy.mjs` | HTTPS + HTTP/2 in front of the local server, like production. All media answers share one bandwidth (`RATE`), `LAT` adds latency, and `NODL=1` keeps the preview streaming. Use it with `run.mjs --base=https://127.0.0.1:3402` |
| `webkit.mjs` | A/B in **Safari** (WebKit, the engine of every iPad browser). It serves a harness page on the editor's origin, so no automation or Safari settings are needed. Results are written as JSON lines |

## Set-up

1. Start a local server in token mode with its own data folder (`NAJJA_TOKEN`, `NAJJA_DATA_DIR`, `NAJJA_MEDIA_DIR`, `PORT=3399`) and create the admin.
2. Make a project with `import_media` of `cuts.mp4` and 30 main-track clips: `start = i·0.45`, `duration 0.45`, `in = i·1.1`.
3. For the "copy on the server" case, give the media a ready light copy: `edit.mp4` and `edit.json` in its library folder. The editor then streams `/edit?v=` the way it does in production.

Run in Chromium:

```bash
NAJJA_BENCH_EMAIL=… NAJJA_BENCH_PASSWORD=… node bench/p26/run.mjs --project=<id> --profile=ipad --runs=2
```

Run in Safari. First start the harness server:

```bash
NAJJA_BENCH_EMAIL=… NAJJA_BENCH_PASSWORD=… NODL=1 LAT=80 node bench/p26/webkit.mjs out.jsonl
```

Then open this page in Safari:

`http://127.0.0.1:3401/__harness?p=<id>&runs=2&sources=asis&arms=auto,element&clear=1`

What the options do:

- `NODL=1` refuses whole-file downloads of media, so the device copy never arrives and the preview keeps streaming. That is the state of an iPad that has just opened the project.
- `LAT=80` and `RATE` (default 2.5 MB/s, about 20 Mbps) slow media answers down like Wi-Fi.
- `clear=1` removes Safari's earlier device copies.

More `run.mjs` options:

- `--scrub` (or `--scrub-only`): a finger scrubbing paused, 6 s of timeline in 3 s and in 1.2 s, forward then back. It reports how often the picture changes and how far it is behind, in frames.
- `--audio`: plays with sound while the copy streams. It reports sound gaps, buffering and the bytes fetched.
- `--trace`: lists every byte request with its timing.

In Safari, add `&scrub=1` (or `&only=scrub`) to the harness address.

Results from 2026-11-23 are in `bench/results/2026-11-23-p26-decoder.md`.
