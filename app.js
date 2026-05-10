/* RuckOps — single-file app logic.
   Vanilla ES module. No build step. Works on GitHub Pages. */

// -- Constants ----------------------------------------------------------

const SETTINGS_KEY = 'ruckops.settings';
const WORKOUTS_KEY = 'ruckops.workouts';
const DRAFT_KEY    = 'ruckops.draft';     // intent-persist on perm denial (X.2)
const ONBOARD_KEY  = 'ruckops.onboarded';

const MIN_ACCURACY_M = 50;       // accept fixes only if better than 50m
const STATIONARY_M_PER_S = 0.5;  // ~1.1 mph; below this == auto-pause
const STATIONARY_TIMEOUT_MS = 15000;

// GPS filter — device-invariant distance accumulation.
// These gates filter out the common noise sources that cause two phones
// recording side-by-side to disagree (drift, accuracy-radius bounce, jumps).
const SPEED_JUMP_MAX_M_S    = 12;    // ~27 mph; reject anything above as a GPS jump
const ACCURACY_NOISE_K      = 1.5;   // movement must exceed K × accuracy to count
const SMOOTHING_ALPHA       = 0.5;   // EMA on accepted positions; 1.0 = no smoothing
const ROLLING_PACE_WINDOW_MS = 30000; // 30s rolling window for "current pace"
const MIN_DISTANCE_FOR_PACE_M = 20;   // need this much before reporting pace

// -- Storage ------------------------------------------------------------

const Storage = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('storage write failed', e);
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
  }
};

// -- Settings -----------------------------------------------------------

function defaultSettings() {
  return {
    units: 'imperial',
    bodyWeight: null,
    defaultPackWeight: 35,
    autoPause: true
  };
}

function loadSettings() {
  return { ...defaultSettings(), ...Storage.get(SETTINGS_KEY, {}) };
}

function saveSettings(s) {
  Storage.set(SETTINGS_KEY, s);
}

// -- Unit helpers -------------------------------------------------------

const Units = {
  // metric internally; convert at the edges.
  distanceLabel(units) { return units === 'metric' ? 'KM' : 'MI'; },
  weightLabel(units)   { return units === 'metric' ? 'KG' : 'LBS'; },
  paceLabel(units)     { return units === 'metric' ? '/KM' : '/MI'; },
  toDistance(meters, units) {
    return units === 'metric' ? meters / 1000 : meters / 1609.344;
  },
  toWeightInternal(input, units) {
    // user enters in their unit; store internally as kg
    return units === 'metric' ? input : input * 0.453592;
  },
  fromWeightInternal(kg, units) {
    return units === 'metric' ? kg : kg / 0.453592;
  },
  formatDistance(meters, units) {
    return Units.toDistance(meters, units).toFixed(2);
  },
  formatWeight(kg, units) {
    return Math.round(Units.fromWeightInternal(kg, units));
  },
  formatPace(secondsPerUnit) {
    if (!isFinite(secondsPerUnit) || secondsPerUnit <= 0) return '--:--';
    const m = Math.floor(secondsPerUnit / 60);
    const s = Math.round(secondsPerUnit % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  },
  formatDuration(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },
  formatDurationShort(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
};

// -- Geo helpers --------------------------------------------------------

function haversine(a, b) {
  // a, b: { lat, lon }. Returns meters.
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// -- Toast --------------------------------------------------------------

let toastTimer = null;
function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  if (navigator.vibrate) navigator.vibrate(8);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 1800);
}

// -- Confirmation modal -------------------------------------------------
// Replaces native confirm() with a styled, accessible overlay.
// Returns Promise<boolean>: true on confirm, false on cancel.

function showConfirm({ title = 'Confirm', message = '', confirmLabel = 'OK', cancelLabel = 'CANCEL', danger = false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    const card = root.querySelector('.modal-card');
    if (!root || !titleEl || !msgEl || !okBtn || !cancelBtn) {
      // Defensive fallback if markup somehow missing.
      resolve(window.confirm(message || title));
      return;
    }
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    if (danger) card.classList.add('danger');
    else card.classList.remove('danger');
    root.classList.remove('hidden');

    const cleanup = (result) => {
      root.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      root.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => {
      if (e.target.classList.contains('modal-backdrop')) cleanup(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    root.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    // Focus the safer option (cancel) by default.
    cancelBtn.focus();
  });
}

// -- Permission state ---------------------------------------------------

async function getLocationPermission() {
  if (!('permissions' in navigator)) return 'unknown';
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    return result.state; // 'granted' | 'prompt' | 'denied'
  } catch {
    return 'unknown';
  }
}

function requestLocationOnce() {
  // Triggers the native prompt by attempting one fix.
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => resolve({ ok: true }),
      (err) => resolve({ ok: false, reason: err.code === 1 ? 'denied' : 'error' }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// -- Live workout state machine -----------------------------------------

class LiveWorkout {
  constructor({ mode, packWeightKg, autoPause = true }) {
    this.mode = mode;
    this.packWeightKg = packWeightKg;
    this.autoPauseEnabled = autoPause;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.elapsedMs = 0;
    this.pausedAt = null;
    this.lastTickAt = this.startedAt;
    this.distanceM = 0;
    this.points = [];        // [{ lat, lon, t, acc }] — smoothed, plotted
    this.lastPoint = null;   // last accepted smoothed point
    this.lastFix = null;     // last raw fix (for filter gates)
    this.watchId = null;
    this.status = 'running'; // 'running' | 'paused' | 'ended'
    this.lastMoveAt = this.startedAt;
    this.gpsSignal = 'searching'; // 'searching' | 'fair' | 'strong'
    this.listeners = new Set();
    this.tickHandle = null;
    this.wakeLock = null;
    this.autoPaused = false;
    this.rollingBuffer = []; // [{ t, dist }] for current-pace window
    this.pacingPlan = null;  // optional PacingPlan
    this.currentPhase = null; // 'run' | 'walk' | null
    this.goalDistM = null;    // optional, meters
    this.goalTimeMs = null;   // optional, ms
    this.targetPaceSecPerMi = null; // optional, for pace color cue
    this.filterStats = { accepted: 0, rejAccuracy: 0, rejJump: 0, rejNoise: 0, rejDrift: 0 };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  async start() {
    await this.acquireWakeLock();
    this.tickHandle = setInterval(() => this.tick(), 1000);
    if ('geolocation' in navigator) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.onPosition(pos),
        (err) => this.onError(err),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
      );
    }
  }

  async acquireWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch (e) {
        // wake lock unavailable; not fatal
      }
    }
  }

  onPosition(pos) {
    const { latitude, longitude, accuracy } = pos.coords;
    // Prefer the fix's own timestamp; some browsers deliver it as the time
    // the chip produced the fix, which is more accurate than wall-clock at
    // callback time (which has unbounded processing latency).
    const now = pos.timestamp || Date.now();

    // Update GPS signal indicator regardless of acceptance.
    if (accuracy == null) {
      this.gpsSignal = 'searching';
      this.emit();
      return;
    }
    this.gpsSignal = accuracy < 15 ? 'strong' : accuracy < 30 ? 'fair' : 'searching';

    // GATE 0: accuracy floor — discard junk fixes outright.
    if (accuracy > MIN_ACCURACY_M) {
      this.filterStats.rejAccuracy++;
      this.emit();
      return;
    }

    const rawFix = { lat: latitude, lon: longitude, t: now, acc: accuracy };

    // First valid fix — seed the filter, do not add distance yet.
    if (!this.lastFix) {
      this.lastFix = rawFix;
      const seed = { lat: latitude, lon: longitude, t: now, acc: accuracy };
      this.lastPoint = seed;
      this.points.push(seed);
      this.filterStats.accepted++;
      this.emit();
      return;
    }

    if (this.status !== 'running') {
      // Paused: don't accumulate distance, but keep timestamp current so the
      // next-after-resume delta uses the right dt.
      this.lastFix = { ...this.lastFix, t: now };
      this.emit();
      return;
    }

    const rawD = haversine(this.lastFix, rawFix);
    const dt = (now - this.lastFix.t) / 1000;
    const impliedSpeed = dt > 0 ? rawD / dt : 0;

    // GATE 1: implausible speed jump — likely GPS teleport.
    if (impliedSpeed > SPEED_JUMP_MAX_M_S) {
      this.filterStats.rejJump++;
      // Don't update lastFix — wait for a believable fix.
      this.emit();
      return;
    }

    // GATE 2: movement within combined accuracy circle — noise, not motion.
    // This is the gate that fixes cross-device drift: a fix 8m away when both
    // fixes have 10m accuracy is statistically indistinguishable from standing
    // still, even though it implies > 0.5 m/s.
    const noiseFloor = ACCURACY_NOISE_K * Math.max(accuracy, this.lastFix.acc);
    if (rawD < noiseFloor) {
      this.filterStats.rejNoise++;
      // CRITICAL: do NOT touch lastFix. The next fix needs to compute its
      // implied speed from the last *accepted* fix's time, not from the
      // last *seen* fix's time, or it'll look like an artificial jump.
      this.emit();
      return;
    }

    // GATE 3: drift while auto-paused — even if movement passes noise floor,
    // if we've already detected stationary and speed is low, reject.
    if (this.autoPaused && impliedSpeed < STATIONARY_M_PER_S * 2) {
      this.filterStats.rejDrift++;
      // Same reason as GATE 2: don't touch lastFix.
      this.emit();
      return;
    }

    // Apply exponential smoothing on position. This dampens GPS chatter
    // without losing real motion (alpha=0.5 means 50% weight on new fix).
    const smoothLat = this.lastPoint.lat * (1 - SMOOTHING_ALPHA) + latitude * SMOOTHING_ALPHA;
    const smoothLon = this.lastPoint.lon * (1 - SMOOTHING_ALPHA) + longitude * SMOOTHING_ALPHA;
    const smoothed = { lat: smoothLat, lon: smoothLon, t: now, acc: accuracy };

    // Distance from previous smoothed point to new smoothed point.
    const d = haversine(this.lastPoint, smoothed);
    this.distanceM += d;
    this.lastPoint = smoothed;
    this.lastFix = rawFix;
    this.points.push(smoothed);
    this.lastMoveAt = now;
    this.filterStats.accepted++;

    // Rolling pace buffer for "current pace" (last 30s).
    this.rollingBuffer.push({ t: now, dist: this.distanceM });
    while (this.rollingBuffer.length > 1 &&
           now - this.rollingBuffer[0].t > ROLLING_PACE_WINDOW_MS) {
      this.rollingBuffer.shift();
    }

    if (this.autoPaused) {
      // We're moving again — un-pause.
      this.autoPaused = false;
      this.status = 'running';
    }

    this.emit();
  }

  // Returns seconds-per-unit using the recent rolling window, or null.
  getRollingPaceSecPerUnit(units) {
    if (this.rollingBuffer.length < 2) return null;
    const first = this.rollingBuffer[0];
    const last = this.rollingBuffer[this.rollingBuffer.length - 1];
    const dt = (last.t - first.t) / 1000;
    const dd = last.dist - first.dist;
    if (dd < MIN_DISTANCE_FOR_PACE_M || dt < 5) return null;
    const speed = dd / dt; // m/s
    if (speed < 0.1) return null;
    return units === 'metric' ? 1000 / speed : 1609.344 / speed;
  }

  onError(err) {
    if (err.code === 1) {
      this.gpsSignal = 'searching';
      toast('Location permission denied', 'danger');
    }
  }

  tick() {
    const now = Date.now();
    if (this.status === 'running') {
      this.elapsedMs += now - this.lastTickAt;
      // auto-pause if stationary too long
      if (this.autoPauseEnabled && now - this.lastMoveAt > STATIONARY_TIMEOUT_MS && !this.autoPaused) {
        this.autoPaused = true;
        this.pause();
        toast('AUTO-PAUSED', 'info');
      }
      // Pacing plan: check for phase transition (run/walk intervals).
      if (this.pacingPlan) {
        const result = this.pacingPlan.tick(this.elapsedMs, this.distanceM);
        if (result.phase !== this.currentPhase) {
          this.currentPhase = result.phase;
          fireCue(result.phase);
        }
      }
    }
    this.lastTickAt = now;
    this.emit();
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.pausedAt = Date.now();
    this.emit();
  }

  resume() {
    if (this.status !== 'paused') return;
    this.status = 'running';
    this.lastTickAt = Date.now();
    this.lastMoveAt = Date.now();
    this.autoPaused = false;
    this.emit();
  }

  async end() {
    this.status = 'ended';
    this.endedAt = Date.now();
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.wakeLock) {
      try { await this.wakeLock.release(); } catch {}
      this.wakeLock = null;
    }
    this.emit();
  }

  toRecord() {
    const id = 'w_' + this.startedAt.toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const durationMs = this.elapsedMs;
    const durationS = Math.max(1, Math.floor(durationMs / 1000));
    const avgPaceSecPerKm = this.distanceM > 0
      ? durationS / (this.distanceM / 1000)
      : null;
    return {
      id,
      mode: this.mode,
      startedAt: this.startedAt,
      endedAt: this.endedAt || Date.now(),
      durationMs,
      distanceM: this.distanceM,
      packWeightKg: this.packWeightKg,
      avgPaceSecPerKm,
      points: this.points.map(p => ({ lat: p.lat, lon: p.lon, t: p.t })),
      notes: '',
      schemaVersion: 1
    };
  }
}

// -- Pacing intervals ---------------------------------------------------
// Evidence-based interval engine. Two protocols + custom.
//
// GALLOWAY: Jeff Galloway's run-walk-run method. Empirically shown to
// reduce injury rate ~50% in beginner/intermediate runners by interrupting
// eccentric loading on quads/calves before damage accumulates. Pace-derived
// ratios from his published charts (Galloway's Book on Running, 2nd ed).
//
// TACTICAL: USMC/Army ruck shuffle protocol. Heavier pack -> longer walk
// segments to protect knees/hips/spine. Hard cap at ~65 lb pack (no running
// recommended above that load per Army Research Institute studies).

// Returns { runSecs, walkSecs } for a given target pace (sec/mi).
// Linear interpolation between Galloway's published anchor paces.
function gallowayRatio(paceSecPerMi) {
  // Anchor table: [paceSecPerMi, runSecs, walkSecs]
  const anchors = [
    [7  * 60, 360,  30],  // 7:00 -> 6 min run / 30s walk
    [8  * 60, 240,  30],  // 8:00 -> 4 / 0:30
    [9  * 60, 240,  60],  // 9:00 -> 4 / 1:00
    [10 * 60, 180,  60],  // 10:00 -> 3 / 1:00
    [11 * 60, 150,  60],  // 11:00 -> 2:30 / 1:00
    [12 * 60, 120,  60],  // 12:00 -> 2 / 1:00
    [13 * 60,  60,  60],  // 13:00 -> 1 / 1
    [14 * 60,  30,  30],  // 14:00 -> 0:30 / 0:30
    [15 * 60,  30,  60],  // 15:00 -> 0:30 / 1:00
    [16 * 60,  30,  90]   // 16:00 -> 0:30 / 1:30
  ];
  if (paceSecPerMi <= anchors[0][0]) return { runSecs: anchors[0][1], walkSecs: anchors[0][2] };
  if (paceSecPerMi >= anchors[anchors.length - 1][0]) {
    const last = anchors[anchors.length - 1];
    return { runSecs: last[1], walkSecs: last[2] };
  }
  // Find the bracketing anchors and round to the nearer one (running
  // intervals work better as round numbers).
  for (let i = 0; i < anchors.length - 1; i++) {
    if (paceSecPerMi >= anchors[i][0] && paceSecPerMi < anchors[i + 1][0]) {
      const distLow  = paceSecPerMi - anchors[i][0];
      const distHigh = anchors[i + 1][0] - paceSecPerMi;
      const choice = distLow < distHigh ? anchors[i] : anchors[i + 1];
      return { runSecs: choice[1], walkSecs: choice[2] };
    }
  }
  return { runSecs: 60, walkSecs: 60 };
}

// Returns { runSecs, walkSecs } for tactical ruck given pace + pack lbs.
function tacticalRatio(paceSecPerMi, packLbs) {
  // Heavier pack -> more walk, less shuffle. Hard caps.
  if (packLbs >= 65) {
    // Don't recommend shuffling at this weight. Set walk-only effectively.
    return { runSecs: 0, walkSecs: 1, advisory: 'pack >65 lb — no shuffle recommended; sustained march only' };
  }
  if (paceSecPerMi <= 13 * 60) {
    // < 13:00 pace with a pack is aggressive.
    return { runSecs: 90, walkSecs: 30, advisory: 'aggressive pace with pack — watch knee/calf strain' };
  }
  if (packLbs >= 50) {
    return { runSecs: 30, walkSecs: 90 };   // heavy pack: short shuffles, long walks
  }
  if (packLbs >= 35) {
    return { runSecs: 60, walkSecs: 60 };   // moderate pack: even ratio
  }
  return { runSecs: 60, walkSecs: 30 };     // light pack: longer shuffles
}

// Returns a warning string or null based on pace + pack combination.
function injuryRiskWarning(method, paceSecPerMi, packLbs) {
  if (method === 'off') return null;
  if (packLbs >= 65) {
    return { level: 'danger', text: 'Pack ≥ 65 lb: per Army research, sustained running at this load significantly increases lower-body injury risk. Tactical mode will switch to walk-only.' };
  }
  if (packLbs >= 50 && paceSecPerMi < 13 * 60) {
    return { level: 'danger', text: 'Pack ≥ 50 lb at < 13:00/mi pace is in the high-impact zone. Consider 15:00+ pace or lighter pack.' };
  }
  if (packLbs >= 30 && paceSecPerMi < 11 * 60) {
    return { level: 'caution', text: '30+ lb pack at sub-11:00 pace: watch for knee/calf strain. Galloway run-walk reduces stress at this load.' };
  }
  if (method === 'galloway' && paceSecPerMi < 7 * 60) {
    return { level: 'caution', text: 'Sub-7:00 pace is elite range. Run-walk still benefits long-distance recovery, but consider a coach for race-day strategy.' };
  }
  return null;
}

class PacingPlan {
  // mode: 'time' (run/walk by seconds) — both Galloway and Tactical use time.
  constructor({ runSecs, walkSecs }) {
    this.runSecs = Math.max(0, runSecs || 0);
    this.walkSecs = Math.max(0, walkSecs || 0);
  }

  // Returns { phase, remainingMs, phaseLengthMs }
  tick(elapsedMs /*, distM */) {
    if (this.runSecs === 0) {
      // Walk-only mode (e.g. heavy pack).
      return { phase: 'walk', remainingMs: 0, phaseLengthMs: this.walkSecs * 1000 };
    }
    if (this.walkSecs === 0) {
      return { phase: 'run', remainingMs: 0, phaseLengthMs: this.runSecs * 1000 };
    }
    const cycleMs = (this.runSecs + this.walkSecs) * 1000;
    const intoCycle = elapsedMs % cycleMs;
    const runMs = this.runSecs * 1000;
    if (intoCycle < runMs) {
      return {
        phase: 'run',
        remainingMs: runMs - intoCycle,
        phaseLengthMs: runMs
      };
    }
    return {
      phase: 'walk',
      remainingMs: cycleMs - intoCycle,
      phaseLengthMs: this.walkSecs * 1000
    };
  }
}

// Fire vibration + speech cue on phase change. Best-effort; silently
// degrades if either API is unavailable (older browsers, iOS restrictions).
function fireCue(phase) {
  try {
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  } catch {}
  try {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(phase === 'run' ? 'Run' : 'Walk');
      u.rate = 1.1;
      u.volume = 1.0;
      window.speechSynthesis.speak(u);
    }
  } catch {}
}

// -- Workouts repository ------------------------------------------------

const Workouts = {
  list() {
    return Storage.get(WORKOUTS_KEY, []);
  },
  save(record) {
    const all = Workouts.list();
    all.unshift(record);
    Storage.set(WORKOUTS_KEY, all);
  },
  delete(id) {
    const all = Workouts.list().filter(w => w.id !== id);
    Storage.set(WORKOUTS_KEY, all);
  },
  update(id, patch) {
    const all = Workouts.list().map(w => w.id === id ? { ...w, ...patch } : w);
    Storage.set(WORKOUTS_KEY, all);
  },
  get(id) {
    return Workouts.list().find(w => w.id === id) || null;
  },
  filter(kind) {
    if (kind === 'all') return Workouts.list();
    return Workouts.list().filter(w => w.mode === kind);
  },
  monthStats() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const all = Workouts.list().filter(w => w.startedAt >= start);
    const distanceM = all.reduce((s, w) => s + w.distanceM, 0);
    const durationMs = all.reduce((s, w) => s + w.durationMs, 0);
    // weight-moved = sum(distanceM * packKg) for ruck only. metric = kg-km.
    const weightMovedKgKm = all
      .filter(w => w.mode === 'ruck')
      .reduce((s, w) => s + (w.distanceM / 1000) * w.packWeightKg, 0);
    return { distanceM, durationMs, weightMovedKgKm, count: all.length };
  }
};

// -- Router -------------------------------------------------------------

const routes = {
  '#/welcome':   renderWelcome,
  '#/onboard':   renderOnboarding,
  '#/home':      renderHome,
  '#/pre':       renderPre,
  '#/live':      renderLive,
  '#/summary':   renderSummary,
  '#/history':   renderHistory,
  '#/detail':    renderDetail,
  '#/profile':   renderProfile
};

function navigate(hash) {
  if (location.hash !== hash) {
    location.hash = hash;
  } else {
    handleRoute();
  }
}

function handleRoute() {
  const hash = location.hash || '#/home';
  const baseHash = hash.split('?')[0];
  const handler = routes[baseHash];
  const onboarded = Storage.get(ONBOARD_KEY, false);

  if (!onboarded && baseHash !== '#/onboard' && baseHash !== '#/welcome') {
    location.hash = '#/welcome';
    return;
  }

  const root = document.getElementById('app');
  root.innerHTML = '';
  if (handler) {
    handler(root, hash);
  } else {
    location.hash = '#/home';
  }
}

window.addEventListener('hashchange', handleRoute);

// -- Template helper ----------------------------------------------------

function mountTemplate(rootEl, templateId) {
  const tpl = document.getElementById(templateId);
  const node = tpl.content.firstElementChild.cloneNode(true);
  rootEl.appendChild(node);
  return node;
}

function applyUnits(scope, units) {
  const w = Units.weightLabel(units);
  scope.querySelectorAll('[data-unit="weight"]').forEach(el => el.textContent = w);
  scope.querySelectorAll('[data-unit="distance"]').forEach(el => el.textContent = Units.distanceLabel(units));
}

// -- Screens ------------------------------------------------------------

function renderWelcome(root) {
  const node = mountTemplate(root, 'tpl-welcome');
  node.querySelector('#welcome-continue').addEventListener('click', () => {
    navigate('#/onboard');
  });
}

function renderOnboarding(root) {
  const node = mountTemplate(root, 'tpl-onboarding');
  let step = 1;
  let pendingUnits = 'imperial';
  let pendingBodyWeight = null;
  let pendingPack = 35;

  applyUnits(node, pendingUnits);

  // Step 1: units
  node.querySelectorAll('.ob-card').forEach(card => {
    card.addEventListener('click', () => {
      node.querySelectorAll('.ob-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      pendingUnits = card.dataset.units;
      applyUnits(node, pendingUnits);
    });
  });

  // step navigation
  node.querySelectorAll('[data-next]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = parseInt(btn.dataset.next, 10);
      // capture inputs based on current step
      if (step === 2) {
        const v = parseFloat(node.querySelector('#ob-bodyweight').value);
        pendingBodyWeight = isFinite(v) && v > 0 ? Units.toWeightInternal(v, pendingUnits) : null;
      }
      if (step === 3) {
        const v = parseFloat(node.querySelector('#ob-packweight').value);
        if (!isFinite(v) || v < 0 || v > 500) {
          toast('Enter a valid pack weight', 'danger');
          return;
        }
        pendingPack = v;
      }
      goToStep(next);
    });
  });

  function goToStep(s) {
    step = s;
    node.querySelector('.step-dots').dataset.step = String(s);
    node.querySelectorAll('.ob-step').forEach(el => {
      el.classList.toggle('hidden', parseInt(el.dataset.step, 10) !== s);
    });
  }

  // Step 4: location permission (primer pattern — already in UI before native prompt)
  node.querySelector('#ob-perm-location').addEventListener('click', async () => {
    const result = await requestLocationOnce();
    const status = node.querySelector('#ob-perm-status');
    if (result.ok) {
      status.textContent = '✓ GRANTED';
      status.className = 'perm-status granted';
      toast('Location enabled', 'success');
    } else if (result.reason === 'denied') {
      status.textContent = '✗ DENIED — enable later in browser settings';
      status.className = 'perm-status denied';
    } else if (result.reason === 'unsupported') {
      status.textContent = '✗ GEOLOCATION NOT SUPPORTED ON THIS DEVICE';
      status.className = 'perm-status denied';
    } else {
      status.textContent = '✗ ERROR — try again';
      status.className = 'perm-status denied';
    }
  });

  node.querySelector('#ob-finish').addEventListener('click', () => {
    saveSettings({
      ...defaultSettings(),
      units: pendingUnits,
      bodyWeight: pendingBodyWeight,
      defaultPackWeight: pendingPack
    });
    Storage.set(ONBOARD_KEY, true);
    toast('Welcome to RuckOps', 'success');
    navigate('#/home');
  });
}

function renderHome(root) {
  const node = mountTemplate(root, 'tpl-home');
  const settings = loadSettings();
  applyUnits(node, settings.units);

  // Date
  const now = new Date();
  node.querySelector('#home-date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  }).toUpperCase();

  // Permission banner check
  (async () => {
    const perm = await getLocationPermission();
    const banner = node.querySelector('#perm-banner');
    if (perm === 'denied') {
      banner.classList.remove('hidden');
      banner.addEventListener('click', () => {
        toast('Enable location in browser settings, then reload', 'info');
      });
    }
  })();

  // Month stats
  const m = Workouts.monthStats();
  node.querySelector('[data-month="distance"]').textContent =
    Units.formatDistance(m.distanceM, settings.units) + ' ' + Units.distanceLabel(settings.units);
  node.querySelector('[data-month="time"]').textContent =
    Units.formatDurationShort(m.durationMs) || '0m';
  // weight moved: shown in user's units
  const movedDisplay = settings.units === 'metric'
    ? `${Math.round(m.weightMovedKgKm)} kg·km`
    : `${Math.round(m.weightMovedKgKm * 0.621371 * 2.20462)} lb·mi`;
  node.querySelector('[data-month="moved"]').textContent = movedDisplay;

  // Recent
  const recents = Workouts.list().slice(0, 3);
  const list = node.querySelector('#recent-list');
  if (recents.length === 0) {
    list.innerHTML = '<li class="muted small" style="text-align:center;padding:12px;">No workouts yet — hit START.</li>';
  } else {
    recents.forEach(w => list.appendChild(workoutRow(w, settings)));
  }

  node.querySelector('#start-workout').addEventListener('click', () => {
    navigate('#/pre');
  });
}

function workoutRow(w, settings) {
  const li = document.createElement('li');
  li.className = `workout-row ${w.mode}`;
  const date = new Date(w.startedAt);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const dist = Units.formatDistance(w.distanceM, settings.units);
  const dur = Units.formatDurationShort(w.durationMs);
  const packDisplay = w.mode === 'ruck'
    ? ` · ${Units.formatWeight(w.packWeightKg, settings.units)} ${Units.weightLabel(settings.units)}`
    : '';
  li.innerHTML = `
    <div class="stripe"></div>
    <div class="info">
      <div class="top-line">
        <span class="type-chip">${w.mode.toUpperCase()}</span>
        <span class="when">${dateStr} ${timeStr}</span>
      </div>
      <div class="bottom-line muted">${dur}${packDisplay}</div>
    </div>
    <div class="right">${dist} ${Units.distanceLabel(settings.units)}</div>
  `;
  li.addEventListener('click', () => navigate('#/detail?id=' + encodeURIComponent(w.id)));
  return li;
}

function renderPre(root) {
  const node = mountTemplate(root, 'tpl-pre');
  const settings = loadSettings();
  applyUnits(node, settings.units);

  // Back nav
  node.querySelector('.back').addEventListener('click', () => navigate('#/home'));

  // Mode toggle
  let mode = 'ruck';
  const packSection = node.querySelector('#pack-section');
  node.querySelectorAll('.mode').forEach(b => {
    b.addEventListener('click', () => {
      node.querySelectorAll('.mode').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      mode = b.dataset.mode;
      packSection.style.display = mode === 'ruck' ? '' : 'none';
    });
  });

  // Pack weight
  const packInput = node.querySelector('#pre-packweight');
  packInput.value = Units.formatWeight(
    Units.toWeightInternal(settings.defaultPackWeight, settings.units),
    settings.units
  );

  // Stepper +/- buttons. Step by 5 lbs / 2 kg — matches typical plate increments.
  const stepSize = settings.units === 'metric' ? 2 : 5;
  const minWeight = 0;
  const maxWeight = settings.units === 'metric' ? 90 : 200;
  function adjustPack(delta) {
    const cur = parseFloat(packInput.value) || 0;
    const next = Math.max(minWeight, Math.min(maxWeight, cur + delta));
    packInput.value = Math.round(next);
    if (navigator.vibrate) navigator.vibrate(6);
  }
  node.querySelector('#pack-minus').addEventListener('click', () => adjustPack(-stepSize));
  node.querySelector('#pack-plus').addEventListener('click', () => adjustPack(stepSize));

  // Pacing & goal configurator.
  // State: method, target pace (sec/unit), run/walk durations (custom),
  // goal type (none/distance/time), goal value.
  let method = 'off';
  let paceSecPerUnit = 9 * 60;  // 9:00/mi default
  let customRunSecs = 240;
  let customWalkSecs = 60;
  let goalType = 'none';
  let goalDistM = 5000;          // 5 km / ~3.1 mi default
  let goalTimeSec = 30 * 60;     // 30 min default

  const paceConfig = node.querySelector('#pace-config');
  const customConfig = node.querySelector('#custom-config');
  const paceValEl = node.querySelector('#pace-value');
  const paceDerivedEl = node.querySelector('#pace-derived');
  const runValEl = node.querySelector('#run-val');
  const walkValEl = node.querySelector('#walk-val');
  const injuryEl = node.querySelector('#injury-warning');
  const goalConfig = node.querySelector('#goal-config');
  const goalValEl = node.querySelector('#goal-value');
  const goalEtaEl = node.querySelector('#goal-eta');
  const goalSuffix = node.querySelector('#goal-suffix');

  function formatMinSec(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = Math.round(totalSec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function unitLabel() {
    return settings.units === 'metric' ? 'KM' : 'MI';
  }

  function getCurrentPackLbs() {
    const v = parseFloat(packInput.value) || 0;
    return settings.units === 'metric' ? v * 2.20462 : v;
  }

  function getDerivedRatio() {
    if (method === 'off') return null;
    if (method === 'custom') return { runSecs: customRunSecs, walkSecs: customWalkSecs };
    // Convert paceSecPerUnit to sec/mi for the lookup (research is mi-based).
    const paceSecPerMi = settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
    if (method === 'galloway') return gallowayRatio(paceSecPerMi);
    if (method === 'tactical') return tacticalRatio(paceSecPerMi, getCurrentPackLbs());
    return null;
  }

  function renderConfigurator() {
    paceConfig.classList.toggle('hidden', method === 'off');
    customConfig.classList.toggle('hidden', method !== 'custom');
    paceValEl.textContent = formatMinSec(paceSecPerUnit);
    runValEl.textContent = formatMinSec(customRunSecs);
    walkValEl.textContent = formatMinSec(customWalkSecs);

    // Pace-derived ratio display
    const ratio = getDerivedRatio();
    if (ratio && method !== 'off' && method !== 'custom') {
      const r = formatMinSec(ratio.runSecs);
      const w = formatMinSec(ratio.walkSecs);
      let txt = `→ ${r} run / ${w} walk`;
      if (ratio.advisory) txt += ` · ${ratio.advisory}`;
      paceDerivedEl.textContent = txt;
    } else {
      paceDerivedEl.textContent = '';
    }

    // Injury warning
    const paceSecPerMi = settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
    const warn = injuryRiskWarning(method, paceSecPerMi, getCurrentPackLbs());
    if (warn) {
      injuryEl.classList.remove('hidden');
      injuryEl.className = 'injury-warning ' + warn.level;
      injuryEl.textContent = warn.text;
    } else {
      injuryEl.classList.add('hidden');
    }

    renderGoal();
  }

  function renderGoal() {
    goalConfig.classList.toggle('hidden', goalType === 'none');
    if (goalType === 'distance') {
      goalSuffix.textContent = unitLabel();
      const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
      goalValEl.textContent = inUnit.toFixed(1);
    } else if (goalType === 'time') {
      goalSuffix.textContent = 'MIN';
      goalValEl.textContent = String(Math.round(goalTimeSec / 60));
    }
    // ETA: distance goal at target pace, accounting for run/walk ratio
    if (goalType !== 'none') {
      const eta = estimateGoalCompletion();
      if (eta) goalEtaEl.textContent = '→ ' + eta;
      else goalEtaEl.textContent = '';
    }
  }

  function estimateGoalCompletion() {
    // Effective pace: when intervals are off, target pace is the pace.
    // With intervals, walking segments slow the average. We assume walk
    // pace ≈ 18:00/mi (3.3 mph), a realistic march pace.
    const ratio = getDerivedRatio();
    const targetSecPerMi = settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
    let effectiveSecPerMi = targetSecPerMi;
    if (ratio && ratio.runSecs > 0 && ratio.walkSecs > 0) {
      const walkSecPerMi = 18 * 60;
      // Time-fraction average: weighted by phase duration
      const totalSec = ratio.runSecs + ratio.walkSecs;
      effectiveSecPerMi =
        (ratio.runSecs * targetSecPerMi + ratio.walkSecs * walkSecPerMi) / totalSec;
    } else if (ratio && ratio.runSecs === 0) {
      // Walk-only
      effectiveSecPerMi = 18 * 60;
    }
    if (goalType === 'distance') {
      const distMi = goalDistM / 1609.344;
      const totalSec = distMi * effectiveSecPerMi;
      return `ETA at this pace: ${formatMinSec(totalSec)}`;
    }
    if (goalType === 'time') {
      const distMi = goalTimeSec / effectiveSecPerMi;
      const distInUnit = settings.units === 'metric' ? distMi * 1.609344 : distMi;
      return `Expected distance: ${distInUnit.toFixed(2)} ${unitLabel().toLowerCase()}`;
    }
    return null;
  }

  // Pacing method selection
  node.querySelectorAll('.pacing-opt').forEach(b => {
    b.addEventListener('click', () => {
      node.querySelectorAll('.pacing-opt').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      method = b.dataset.pacing;
      if (navigator.vibrate) navigator.vibrate(6);
      renderConfigurator();
    });
  });

  // Pace stepper: ±15 sec per tap
  node.querySelector('#pace-minus').addEventListener('click', () => {
    paceSecPerUnit = Math.min(20 * 60, paceSecPerUnit + 15);
    renderConfigurator();
    if (navigator.vibrate) navigator.vibrate(6);
  });
  node.querySelector('#pace-plus').addEventListener('click', () => {
    paceSecPerUnit = Math.max(5 * 60, paceSecPerUnit - 15);
    renderConfigurator();
    if (navigator.vibrate) navigator.vibrate(6);
  });

  // Custom run/walk steppers: ±15 sec
  node.querySelector('#run-minus').addEventListener('click', () => {
    customRunSecs = Math.max(15, customRunSecs - 15);
    renderConfigurator();
  });
  node.querySelector('#run-plus').addEventListener('click', () => {
    customRunSecs = Math.min(15 * 60, customRunSecs + 15);
    renderConfigurator();
  });
  node.querySelector('#walk-minus').addEventListener('click', () => {
    customWalkSecs = Math.max(15, customWalkSecs - 15);
    renderConfigurator();
  });
  node.querySelector('#walk-plus').addEventListener('click', () => {
    customWalkSecs = Math.min(15 * 60, customWalkSecs + 15);
    renderConfigurator();
  });

  // Re-render configurator when pack weight changes (warnings depend on it)
  packInput.addEventListener('input', renderConfigurator);
  node.querySelector('#pack-minus').addEventListener('click', () => setTimeout(renderConfigurator, 0));
  node.querySelector('#pack-plus').addEventListener('click', () => setTimeout(renderConfigurator, 0));

  // Goal selection
  node.querySelectorAll('.goal-opt').forEach(b => {
    b.addEventListener('click', () => {
      node.querySelectorAll('.goal-opt').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      goalType = b.dataset.goal;
      if (navigator.vibrate) navigator.vibrate(6);
      renderGoal();
    });
  });

  // Goal stepper: distance ±0.1 unit, time ±5 min
  node.querySelector('#goal-minus').addEventListener('click', () => {
    if (goalType === 'distance') {
      const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
      const next = Math.max(0.5, inUnit - 0.1);
      goalDistM = settings.units === 'metric' ? next * 1000 : next * 1609.344;
    } else if (goalType === 'time') {
      goalTimeSec = Math.max(5 * 60, goalTimeSec - 5 * 60);
    }
    renderGoal();
  });
  node.querySelector('#goal-plus').addEventListener('click', () => {
    if (goalType === 'distance') {
      const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
      const next = Math.min(50, inUnit + 0.1);
      goalDistM = settings.units === 'metric' ? next * 1000 : next * 1609.344;
    } else if (goalType === 'time') {
      goalTimeSec = Math.min(8 * 60 * 60, goalTimeSec + 5 * 60);
    }
    renderGoal();
  });

  renderConfigurator();

  // GPS probe loop. simple watch.
  const gpsStatus = node.querySelector('#gps-status');
  const startBtn = node.querySelector('#begin-tracking');
  let gotFix = false;
  let watchId = null;

  // Intent persist on permission denial (X.2): save the workout draft BEFORE
  // any permission action so the user's pack weight + mode survive a denial.
  function saveDraft() {
    Storage.set(DRAFT_KEY, {
      mode,
      packWeight: parseFloat(packInput.value) || 0,
      ts: Date.now()
    });
  }

  function tryWatch() {
    if (!('geolocation' in navigator)) {
      gpsStatus.textContent = 'UNSUPPORTED';
      gpsStatus.className = 'gps-status';
      toast('Geolocation not supported on this device', 'danger');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        gotFix = true;
        const a = pos.coords.accuracy || 999;
        if (a < 15) {
          gpsStatus.textContent = 'STRONG';
          gpsStatus.className = 'gps-status strong';
        } else if (a < 50) {
          gpsStatus.textContent = 'FAIR';
          gpsStatus.className = 'gps-status fair';
        } else {
          gpsStatus.textContent = 'WEAK';
          gpsStatus.className = 'gps-status fair';
        }
        startBtn.disabled = false;
      },
      (err) => {
        if (err.code === 1) {
          gpsStatus.textContent = 'PERMISSION DENIED';
          gpsStatus.className = 'gps-status';
        } else {
          gpsStatus.textContent = 'SEARCHING';
          gpsStatus.className = 'gps-status';
        }
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 }
    );
  }

  tryWatch();

  startBtn.addEventListener('click', () => {
    saveDraft();
    const pack = parseFloat(packInput.value) || 0;
    const packKg = mode === 'ruck' ? Units.toWeightInternal(pack, settings.units) : 0;
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    // Hand off live workout via window-scoped state.
    const lw = new LiveWorkout({ mode, packWeightKg: packKg });
    const ratio = getDerivedRatio();
    if (ratio && (ratio.runSecs > 0 || ratio.walkSecs > 0)) {
      lw.pacingPlan = new PacingPlan({ runSecs: ratio.runSecs, walkSecs: ratio.walkSecs });
    }
    if (method !== 'off') {
      lw.targetPaceSecPerMi = settings.units === 'metric'
        ? paceSecPerUnit * 1.609344
        : paceSecPerUnit;
    }
    if (goalType === 'distance') {
      lw.goalDistM = goalDistM;
    } else if (goalType === 'time') {
      lw.goalTimeMs = goalTimeSec * 1000;
    }
    window.__liveWorkout = lw;
    lw.start();
    navigate('#/live');
  });

  // cleanup on hashchange
  window.addEventListener('hashchange', () => {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
  }, { once: true });
}

function renderLive(root) {
  // Helper local to live screen — format seconds as mm:ss.
  function formatMinSecLive(totalSec) {
    if (!isFinite(totalSec) || totalSec < 0) return '--:--';
    const t = Math.round(totalSec);
    const m = Math.floor(t / 60);
    const s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  const live = window.__liveWorkout;
  if (!live) {
    navigate('#/home');
    return;
  }
  const settings = loadSettings();
  const node = mountTemplate(root, 'tpl-live');
  applyUnits(node, settings.units);

  const distEl = node.querySelector('#live-distance');
  const durEl = node.querySelector('#live-duration');
  const paceEl = node.querySelector('#live-pace');
  const packEl = node.querySelector('#live-pack');
  const packStat = node.querySelector('#live-pack-stat');
  const pausedOverlay = node.querySelector('#paused-overlay');
  const lockOverlay = node.querySelector('#lock-overlay');
  const gpsChip = node.querySelector('#live-gps-chip');
  const pacingBanner = node.querySelector('#pacing-banner');
  const pacingPhaseEl = node.querySelector('#pacing-phase');
  const pacingRemainingEl = node.querySelector('#pacing-remaining');
  const goalProgress = node.querySelector('#goal-progress');
  const goalFill = node.querySelector('#goal-progress-fill');
  const goalCurrentEl = node.querySelector('#goal-progress-current');
  const goalTargetEl = node.querySelector('#goal-progress-target');
  const goalEtaEl = node.querySelector('#goal-progress-eta');

  if (live.mode !== 'ruck') {
    packStat.style.display = 'none';
  } else {
    packEl.textContent = Units.formatWeight(live.packWeightKg, settings.units);
  }

  const update = () => {
    distEl.textContent = Units.formatDistance(live.distanceM, settings.units);
    durEl.textContent = Units.formatDuration(live.elapsedMs);

    // Pace: rolling 30s window for "current pace" (matches Strava/Garmin
    // behavior). Falls back to average pace if rolling window not yet ready.
    const rolling = live.getRollingPaceSecPerUnit(settings.units);
    let currentSecPerUnit = null;
    if (rolling != null) {
      currentSecPerUnit = rolling;
      paceEl.textContent = Units.formatPace(rolling);
    } else if (live.distanceM > MIN_DISTANCE_FOR_PACE_M) {
      currentSecPerUnit = settings.units === 'metric'
        ? (live.elapsedMs / 1000) / (live.distanceM / 1000)
        : (live.elapsedMs / 1000) / (live.distanceM / 1609.344);
      paceEl.textContent = Units.formatPace(currentSecPerUnit);
    } else {
      paceEl.textContent = '--:--';
    }

    // Pace color cue: green within 10s/mi of target, amber slow, red very slow,
    // blue if too fast (save energy advice).
    paceEl.classList.remove('on-target', 'slow', 'too-slow', 'too-fast');
    if (currentSecPerUnit != null && live.targetPaceSecPerMi != null) {
      const targetSec = settings.units === 'metric'
        ? live.targetPaceSecPerMi / 1.609344
        : live.targetPaceSecPerMi;
      const diff = currentSecPerUnit - targetSec; // positive = slower
      if (diff > 30)        paceEl.classList.add('too-slow');
      else if (diff > 10)   paceEl.classList.add('slow');
      else if (diff < -15)  paceEl.classList.add('too-fast');
      else                  paceEl.classList.add('on-target');
    }

    pausedOverlay.classList.toggle('hidden', live.status !== 'paused');
    if (gpsChip) {
      const sig = live.gpsSignal || 'searching';
      gpsChip.className = 'gps-chip ' + sig;
      gpsChip.textContent = '📡 ' + sig.toUpperCase();
    }

    // Pacing banner — visible only if a plan is attached.
    if (live.pacingPlan && pacingBanner) {
      const result = live.pacingPlan.tick(live.elapsedMs, live.distanceM);
      pacingBanner.classList.remove('hidden');
      pacingBanner.classList.toggle('run', result.phase === 'run');
      pacingBanner.classList.toggle('walk', result.phase === 'walk');
      pacingPhaseEl.textContent = result.phase === 'run' ? 'RUN' : 'WALK';
      if (result.remainingMs != null) {
        const s = Math.ceil(result.remainingMs / 1000);
        const mm = Math.floor(s / 60).toString().padStart(2, '0');
        const ss = (s % 60).toString().padStart(2, '0');
        pacingRemainingEl.textContent = mm + ':' + ss + ' LEFT';
      } else {
        pacingRemainingEl.textContent = '';
      }
    } else if (pacingBanner) {
      pacingBanner.classList.add('hidden');
    }

    // Goal progress bar.
    if ((live.goalDistM || live.goalTimeMs) && goalProgress) {
      goalProgress.classList.remove('hidden');
      let pct, currentTxt, targetTxt, etaTxt;
      if (live.goalDistM) {
        pct = Math.min(100, (live.distanceM / live.goalDistM) * 100);
        currentTxt = Units.formatDistance(live.distanceM, settings.units);
        targetTxt = Units.formatDistance(live.goalDistM, settings.units);
        // ETA from current pace (rolling preferred)
        if (currentSecPerUnit != null) {
          const remainingM = Math.max(0, live.goalDistM - live.distanceM);
          const remainingInUnit = settings.units === 'metric'
            ? remainingM / 1000
            : remainingM / 1609.344;
          const remainSec = remainingInUnit * currentSecPerUnit;
          etaTxt = 'ETA ' + formatMinSecLive(remainSec);
        } else {
          etaTxt = 'ETA --:--';
        }
      } else {
        pct = Math.min(100, (live.elapsedMs / live.goalTimeMs) * 100);
        currentTxt = Units.formatDuration(live.elapsedMs);
        targetTxt = Units.formatDuration(live.goalTimeMs);
        etaTxt = '';
      }
      goalFill.style.width = pct + '%';
      goalCurrentEl.textContent = currentTxt;
      goalTargetEl.textContent = targetTxt;
      goalEtaEl.textContent = etaTxt;
    } else if (goalProgress) {
      goalProgress.classList.add('hidden');
    }
  };

  const off = live.on(update);
  update();

  node.querySelector('#live-pause').addEventListener('click', () => {
    live.pause();
  });
  node.querySelector('#live-resume').addEventListener('click', () => {
    live.resume();
  });
  node.querySelector('#live-end').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'End workout?',
      message: 'This will save your progress. The current session ends and you\'ll see the summary.',
      confirmLabel: 'END',
      cancelLabel: 'KEEP GOING'
    });
    if (!ok) return;
    await live.end();
    off();
    navigate('#/summary');
  });

  // Lock overlay: prevents accidental taps
  let lastTap = 0;
  node.querySelector('#live-lock').addEventListener('click', () => {
    lockOverlay.classList.remove('hidden');
  });
  lockOverlay.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 400) {
      lockOverlay.classList.add('hidden');
      toast('UNLOCKED');
    }
    lastTap = now;
  });
}

function renderSummary(root) {
  const live = window.__liveWorkout;
  if (!live || live.status !== 'ended') {
    navigate('#/home');
    return;
  }
  const settings = loadSettings();
  const node = mountTemplate(root, 'tpl-summary');

  const record = live.toRecord();
  const statsEl = node.querySelector('#summary-stats');
  const stats = [
    { label: 'DISTANCE', val: `${Units.formatDistance(record.distanceM, settings.units)} ${Units.distanceLabel(settings.units)}` },
    { label: 'DURATION', val: Units.formatDuration(record.durationMs) },
    { label: 'AVG PACE', val: record.avgPaceSecPerKm
        ? Units.formatPace(settings.units === 'metric' ? record.avgPaceSecPerKm : record.avgPaceSecPerKm * 1.609344) + ' ' + Units.paceLabel(settings.units)
        : '--' }
  ];
  if (record.mode === 'ruck') {
    stats.push({ label: 'PACK WEIGHT', val: `${Units.formatWeight(record.packWeightKg, settings.units)} ${Units.weightLabel(settings.units)}` });
  }
  // Calorie estimate: very rough — METs * weight(kg) * hours.
  // Walk ~3.5 METs, ruck w/ pack ~6 METs, run ~9 METs.
  const bw = settings.bodyWeight;
  if (bw && bw > 0) {
    const hours = record.durationMs / 3600000;
    const mets = record.mode === 'run' ? 9 : (record.packWeightKg > 0 ? 6 : 4.5);
    const totalKg = bw + (record.mode === 'ruck' ? record.packWeightKg : 0);
    const cals = Math.round(mets * totalKg * hours);
    stats.push({ label: 'CALORIES', val: `${cals} kcal` });
  }
  for (const s of stats) {
    const el = document.createElement('div');
    el.className = 'summary-stat';
    el.innerHTML = `<span class="label">${s.label}</span><span class="val">${s.val}</span>`;
    statsEl.appendChild(el);
  }

  // Map
  const mapWrap = node.querySelector('#summary-map');
  if (record.points.length >= 2) {
    drawRouteMap(mapWrap, record.points);
  } else {
    mapWrap.classList.add('empty');
  }

  // Save / discard
  node.querySelector('#summary-save').addEventListener('click', () => {
    record.notes = node.querySelector('#summary-notes').value || '';
    Workouts.save(record);
    Storage.remove(DRAFT_KEY);
    window.__liveWorkout = null;
    toast('Workout saved', 'success');
    navigate('#/home');
  });
  node.querySelector('#summary-discard').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Discard workout?',
      message: 'This workout will be lost. You can\'t undo this.',
      confirmLabel: 'DISCARD',
      cancelLabel: 'KEEP',
      danger: true
    });
    if (!ok) return;
    Storage.remove(DRAFT_KEY);
    window.__liveWorkout = null;
    toast('Discarded', 'danger');
    navigate('#/home');
  });
}

function drawRouteMap(wrap, points) {
  // Leaflet expects an element of known size; ensure it
  setTimeout(() => {
    if (typeof L === 'undefined') {
      wrap.classList.add('empty');
      return;
    }
    const map = L.map(wrap, {
      zoomControl: false,
      attributionControl: true,
      dragging: true,
      tap: true
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);
    const latlngs = points.map(p => [p.lat, p.lon]);
    const polyline = L.polyline(latlngs, { color: '#F4811F', weight: 4 }).addTo(map);
    L.circleMarker(latlngs[0], { radius: 5, color: '#4ade80', fillOpacity: 1 }).addTo(map);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 5, color: '#DC2626', fillOpacity: 1 }).addTo(map);
    map.fitBounds(polyline.getBounds(), { padding: [20, 20] });
  }, 30);
}

function renderHistory(root) {
  const node = mountTemplate(root, 'tpl-history');
  const settings = loadSettings();
  applyUnits(node, settings.units);

  let filter = 'all';
  const list = node.querySelector('#history-list');
  const empty = node.querySelector('#history-empty');

  function refresh() {
    list.innerHTML = '';
    const all = Workouts.filter(filter);
    if (all.length === 0) {
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      all.forEach(w => list.appendChild(workoutRow(w, settings)));
    }
  }

  node.querySelectorAll('.filter').forEach(b => {
    b.addEventListener('click', () => {
      node.querySelectorAll('.filter').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      filter = b.dataset.filter;
      refresh();
    });
  });

  refresh();
}

function renderDetail(root, hash) {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const id = params.get('id');
  const w = id ? Workouts.get(id) : null;
  if (!w) {
    navigate('#/history');
    return;
  }
  const settings = loadSettings();
  const node = mountTemplate(root, 'tpl-detail');
  applyUnits(node, settings.units);

  const date = new Date(w.startedAt);
  node.querySelector('#detail-title').textContent =
    `${w.mode.toUpperCase()} · ${date.toLocaleDateString()}`;

  const stats = [
    { label: 'DISTANCE', val: `${Units.formatDistance(w.distanceM, settings.units)} ${Units.distanceLabel(settings.units)}` },
    { label: 'DURATION', val: Units.formatDuration(w.durationMs) },
    { label: 'AVG PACE', val: w.avgPaceSecPerKm
        ? Units.formatPace(settings.units === 'metric' ? w.avgPaceSecPerKm : w.avgPaceSecPerKm * 1.609344) + ' ' + Units.paceLabel(settings.units)
        : '--' }
  ];
  if (w.mode === 'ruck') {
    stats.push({ label: 'PACK', val: `${Units.formatWeight(w.packWeightKg, settings.units)} ${Units.weightLabel(settings.units)}` });
  }
  const sEl = node.querySelector('#detail-stats');
  for (const s of stats) {
    const el = document.createElement('div');
    el.className = 'summary-stat';
    el.innerHTML = `<span class="label">${s.label}</span><span class="val">${s.val}</span>`;
    sEl.appendChild(el);
  }

  const mapWrap = node.querySelector('#detail-map');
  if (w.points && w.points.length >= 2) {
    drawRouteMap(mapWrap, w.points);
  } else {
    mapWrap.classList.add('empty');
  }

  node.querySelector('#detail-notes').textContent = w.notes || '—';

  node.querySelector('.back').addEventListener('click', () => navigate('#/history'));

  node.querySelector('#detail-delete').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Delete this workout?',
      message: 'This cannot be undone. The workout and its route will be removed permanently.',
      confirmLabel: 'DELETE',
      cancelLabel: 'KEEP',
      danger: true
    });
    if (!ok) return;
    Workouts.delete(w.id);
    toast('Deleted', 'danger');
    navigate('#/history');
  });
}

function renderProfile(root) {
  const node = mountTemplate(root, 'tpl-profile');
  const settings = loadSettings();
  applyUnits(node, settings.units);

  const unitsSel = node.querySelector('#set-units');
  const packIn = node.querySelector('#set-packweight');
  const bwIn = node.querySelector('#set-bodyweight');
  const apToggle = node.querySelector('#set-autopause');

  unitsSel.value = settings.units;
  packIn.value = Units.formatWeight(
    Units.toWeightInternal(settings.defaultPackWeight, settings.units),
    settings.units
  );
  if (settings.bodyWeight) {
    bwIn.value = Math.round(Units.fromWeightInternal(settings.bodyWeight, settings.units));
  }
  apToggle.checked = !!settings.autoPause;

  function persist() {
    const u = unitsSel.value;
    const pack = parseFloat(packIn.value) || 0;
    const bw = parseFloat(bwIn.value);
    saveSettings({
      units: u,
      defaultPackWeight: pack,
      bodyWeight: isFinite(bw) && bw > 0 ? Units.toWeightInternal(bw, u) : null,
      autoPause: apToggle.checked
    });
    applyUnits(node, u);
  }

  unitsSel.addEventListener('change', () => {
    persist();
    toast('Units updated', 'success');
  });
  packIn.addEventListener('change', () => {
    persist();
    toast('Pack weight saved', 'success');
  });
  bwIn.addEventListener('change', () => {
    persist();
    toast('Body weight saved', 'success');
  });
  apToggle.addEventListener('change', () => {
    persist();
    toast('Auto-pause ' + (apToggle.checked ? 'on' : 'off'), 'success');
  });

  node.querySelector('#export-csv').addEventListener('click', () => {
    const all = Workouts.list();
    if (all.length === 0) { toast('No workouts to export', 'danger'); return; }
    const rows = [
      ['id','mode','startedAt','endedAt','durationSec','distanceM','packWeightKg','avgPaceSecPerKm','notes']
    ];
    for (const w of all) {
      rows.push([
        w.id,
        w.mode,
        new Date(w.startedAt).toISOString(),
        new Date(w.endedAt).toISOString(),
        Math.round(w.durationMs / 1000),
        Math.round(w.distanceM),
        w.packWeightKg.toFixed(2),
        w.avgPaceSecPerKm ? w.avgPaceSecPerKm.toFixed(2) : '',
        (w.notes || '').replace(/[\r\n]+/g, ' ')
      ]);
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ruckops-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('CSV downloaded', 'success');
  });

  node.querySelector('#reset-app').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Erase all local data?',
      message: 'Every workout, setting, and the onboarding state will be deleted. This cannot be undone.',
      confirmLabel: 'ERASE',
      cancelLabel: 'CANCEL',
      danger: true
    });
    if (!ok) return;
    Storage.remove(SETTINGS_KEY);
    Storage.remove(WORKOUTS_KEY);
    Storage.remove(DRAFT_KEY);
    Storage.remove(ONBOARD_KEY);
    toast('All data erased', 'danger');
    setTimeout(() => location.hash = '#/welcome', 600);
  });

  node.querySelector('#about-link').addEventListener('click', (e) => {
    e.preventDefault();
    alert('RuckOps web MVP v0.1\n\nForeground GPS tracking. Local-only data. No account, no cloud.\n\nSee README on GitHub for the full project plan and v2 roadmap.');
  });
}

// -- Service worker registration ---------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // Use relative path so it works under any GitHub Pages base path.
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// -- Boot ---------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) {
    location.hash = Storage.get(ONBOARD_KEY, false) ? '#/home' : '#/welcome';
  } else {
    handleRoute();
  }
});
