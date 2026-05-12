# RuckOps

**🔗 Live demo: [khurang-r.github.io/RuckOps](https://khurang-r.github.io/RuckOps/)**

A GPS workout tracker for rucking and running. Built for the military and serious fitness community — track workouts in real time, log pack weight, and build a long-term progress history.

> **Status:** project planning docs (Project 4 output) plus a working **web MVP** that runs on GitHub Pages. The native mobile build (React Native + Expo + Supabase) described in the planning docs is the v2 target.
>
> If you forked this repo, your live URL is `https://<your-username>.github.io/RuckOps/` once Pages is enabled.

## Live web MVP

Once GitHub Pages is enabled on this repo, the app is live at:
**https://khurang-r.github.io/RuckOps/**

The web MVP gets the core workout flow working in any modern browser:

- Foreground GPS tracking (Geolocation API)
- Live distance, duration, pace, and pack weight
- Pause / resume / lock controls, auto-pause when stationary
- Post-workout summary with a route map (Leaflet + OpenStreetMap)
- Workout history with type filter (Ruck / Run / All)
- Workout detail with delete
- Profile settings (units, default pack weight, body weight, auto-pause)
- CSV export of all workouts
- PWA shell — installable to home screen, works offline-first for the app shell

### How to enable GitHub Pages

1. Go to **Settings → Pages** in the GitHub UI.
2. Under "Build and deployment," set **Source** to **GitHub Actions**.
3. Push to `main` (or click Run workflow on the *Deploy to GitHub Pages* action). The workflow at `.github/workflows/pages.yml` will publish the site automatically.
4. Wait ~1–2 minutes; the URL above goes live.

Alternative if you want zero CI: set **Source** to **Deploy from a branch**, branch `main`, folder `/ (root)`. The `.nojekyll` file at the root keeps GitHub from running Jekyll over the assets.

### Running locally

No build step. Any static server works:

```bash
# Python
python3 -m http.server 8000
# or Node
npx serve .
```

Then open `http://localhost:8000`. Note that geolocation in browsers requires HTTPS *or* localhost — `file://` won't work.

## What's in v1.3

This release introduces three changes, each governed by the [Composition Registry](COMPOSITION_REGISTRY.md). Tier labels are honest about what's measured vs. what's claimed.

- **F-DIAG — workout diagnostics export (Tier 1).** Post-workout, tap "EXPORT DIAGNOSTICS" to download a JSON file with the workout record plus filter statistics, tracking-mode transitions, conformal-coverage scores, and sensor-health flags. Useful for debugging cross-device behavior. The export schema is documented in the registry under F-DIAG.
- **F-ADAPT-UI — adaptive baseline (UI-infrastructure, validated by visual checks).** Live-screen tile grid uses CSS container queries to adapt from iPhone SE width (forces 2-up) to tablet (allows up to 6-up). Sub-stat values use `clamp()` fluid type. The GPS-lost and PDR-active pulses respect `prefers-reduced-motion`. UI quality lives outside the registry's tier system; visual regression is the validation.
- **F-PLAN — coaching plans (Tier 2).** Three plans shipped: Couch-to-5K (12 weeks, Cooper progression), 12-Mile Ruck Prep (8 weeks, Knapik / U.S. Army FM 21-18), and Half Marathon (12 weeks, Pfitzinger 12/47). Each cites its source. When a plan is active, the home-screen WOD card shows today's prescribed workout. Each plan-day advances exactly once when the user saves a workout. The `PlanState` engine (P12) is round-trip-serialized so progress persists across sessions.
- **F-PLAN-OVERRIDE — ACWR-aware schedule modification (Tier 2).** If ACWR > 1.5 (Gabbett 2016 injury threshold) AND a plan prescribes hard work, the home screen shows a rest-override instead. Easy days and rest days are never overridden. Tier 2 because both inputs (F-PLAN, ACWR) are Tier 2; the composition cannot exceed its weakest link.

### What v1.3 explicitly does NOT claim
- That coaching plans improve user race times, prevent injury, or replace human coaching. Plan content is evidence-cited; the *outcomes* claim is out of scope.
- That tracking is now SOTA-equal to Garmin or Strava in the field. Field measurement against ground truth is unmeasured (v1.4+ work).
- That conformal-coverage 95% holds outside i.i.d. synthetic data. Synthetic tests demonstrate the algorithm; in-session distribution shift would degrade coverage in ways that aren't yet quantified.

The full audit of past claims and their honest tier classifications is in [COMPOSITION_REGISTRY.md §5](COMPOSITION_REGISTRY.md).

### Honest gaps in the web MVP

These are deliberate, scope-locked. They live in the v2 native build, not here.

- **No background GPS.** The browser kills the tab when it's hidden, so workouts only record while the tab is in the foreground. The pre-workout screen says this explicitly. The Wake Lock API is used during workouts to keep the screen on.
- **No accounts, no cloud sync, no cross-device.** All data lives in `localStorage` on this device. The Profile screen has a CSV export so users can move data manually.
- **No Apple/Google sign-in.** Removed from the welcome screen.
- **No in-app purchases or subscription tiers.** The web MVP is single-tier.
- **No push notifications.** Service worker is registered but only handles caching.
- **No 4–12 hour battery test.** Web GPS isn't optimized for ultra-long sessions; the planning docs call out `react-native-background-geolocation` as the right answer for that, which is a v2 native task.
- **Map tiles need internet.** OpenStreetMap tiles are cached as you view them but not pre-fetched.

These are tracked as v2 deliverables in `MVP_SCOPE.md`.

## Files in this repo

### Web MVP (new in this fork)

| File | Purpose |
|---|---|
| `index.html` | App shell with all screen templates |
| `app.js` | Single-file ES module: routing, state machine, GPS, persistence |
| `styles.css` | Tactical dark theme — colors and typography from the design blueprint |
| `manifest.webmanifest` | PWA manifest |
| `sw.js` | Service worker (cache-first shell + tile cache) |
| `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | PWA icons |
| `.nojekyll` | Disables Jekyll on GitHub Pages |
| `.github/workflows/pages.yml` | Deploys to Pages on every push to `main` |

### Original planning documents (unchanged)

| File | Purpose |
|---|---|
| `APP_IDEA_SUMMARY.md` | Validated concept (Project 1) |
| `MVP_SCOPE.md` | Locked MVP scope (Project 1) |
| `APP_DESIGN_BLUEPRINT.md` | Screen-by-screen design (Project 2) |
| `APP_CONTENT.md` | Final copy that ships in the binary (Project 3) |
| `DEVELOPER_BRIEF.md` | Full technical spec for the native build (Project 4) |
| `FILE_STRUCTURE.md` | Native repo layout (Project 4) |
| `HANDOVER_PROMPT.md` | Prompt for Project 5 (MVP Builder) |
| `github/PUSH_COMMAND.txt` | Original push command |
| `github/REPO_SETUP.md` | Original repo setup notes |

## Tech stack at a glance

| Layer | Web MVP (this fork) | v2 Native (planned) |
|---|---|---|
| App | Vanilla JS + ES modules, no build step | React Native + Expo (Bare workflow) |
| GPS | `navigator.geolocation.watchPosition` (foreground only) | `react-native-background-geolocation` |
| Local DB | `localStorage` | `expo-sqlite` |
| Backend | None — local only | Supabase (Postgres + Auth + Edge Functions) |
| Maps | Leaflet + OpenStreetMap | `react-native-maps` |
| Auth | None — single-user device | Supabase Auth (Apple, Google, email) |
| IAP | None | `react-native-iap` |
| Crash + analytics | None | Sentry |
| Build pipeline | GitHub Pages deploy action | EAS Build + EAS Submit |

The full justification for the v2 native choices is in `DEVELOPER_BRIEF.md` §2.

## What the web MVP looks like

The visual identity matches the design blueprint:

- Tactical amber `#F4811F` for primary CTAs, hero metrics, brand accents
- Olive drab `#4A5D23` for run-mode highlights
- Deep tactical black `#0D0F0D` background
- Roboto Condensed Bold for titles, JetBrains Mono Bold for numerics, Inter for body
- Glanceable hero metrics, monospace stats, no civilian gloss

## Browser support

- iOS Safari 14+ — works, with the foreground-only caveat
- Android Chrome — works
- Desktop Chrome / Firefox / Edge — works (geolocation is desktop-IP-based, useful only for testing the UI)
- Wake Lock API: supported on Android Chrome and recent iOS Safari; falls back gracefully where not

## License

MIT (or whatever the original repo elects).
