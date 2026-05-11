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
const ACCURACY_NOISE_K      = 1.2;   // movement must exceed K × accuracy to count
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
    autoPause: true,
    voiceCues: 'full',      // 'off' | 'minimal' | 'full' | 'verbose'
    soundEffects: true,
    anticipationSec: 10
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
    // Round total first to avoid e.g. 9:60 from 599.999 input.
    const total = Math.round(secondsPerUnit);
    const m = Math.floor(total / 60);
    const s = total % 60;
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

// -- Bottom sheets ------------------------------------------------------
// Sheets are pre-built inside each screen template. openSheet just shows
// the matching element + wires the close handlers; closing restores focus.

function openSheet(sheetId) {
  const el = document.getElementById('sheet-' + sheetId);
  if (!el) return;
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  // Wire close — once per open
  const close = () => closeSheet(sheetId);
  el.querySelector('.sheet-close').addEventListener('click', close, { once: true });
  el.querySelector('.sheet-backdrop').addEventListener('click', close, { once: true });
  // Esc to close
  const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); } };
  document.addEventListener('keydown', onKey);
  // Touch swipe-down to dismiss
  const card = el.querySelector('.sheet-card');
  let startY = null;
  const onStart = (e) => { startY = e.touches[0].clientY; };
  const onMove = (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) card.style.transform = `translateY(${dy}px)`;
  };
  const onEnd = (e) => {
    if (startY == null) return;
    const dy = (e.changedTouches[0].clientY - startY);
    card.style.transform = '';
    startY = null;
    if (dy > 100) close();
  };
  card.addEventListener('touchstart', onStart, { passive: true });
  card.addEventListener('touchmove', onMove, { passive: true });
  card.addEventListener('touchend', onEnd, { passive: true });
  // Brief haptic on open
  if (navigator.vibrate) navigator.vibrate(8);
}

function closeSheet(sheetId) {
  const el = document.getElementById('sheet-' + sheetId);
  if (!el) return;
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
}

// Wire tile clicks within a given root node — called after each template mount.
function wireTiles(root) {
  root.querySelectorAll('.tile[data-sheet]').forEach(t => {
    t.addEventListener('click', (e) => {
      e.preventDefault();
      openSheet(t.dataset.sheet);
    });
  });
}

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
    this.phaseBuffer = [];   // [{ t, dist, phase }] reset on phase change
    this.pacingPlan = null;  // optional PacingPlan
    this.currentPhase = null; // 'run' | 'walk' | null
    this.goalDistM = null;    // optional, meters
    this.goalTimeMs = null;   // optional, ms
    this.targetPaceSecPerMi = null; // optional, for pace color cue
    this.targetTotalMs = null;       // expected total time at start (distance goal)
    this.goalProjectedDistanceM = null; // expected total distance at start (time goal)
    this.fuelCoach = null;   // optional FuelCoach
    this.pendingFuelAlert = null; // mirrored for renderer
    this.compensatedPauseMs = 0;     // total time absorbed by self-heal
    this.firstFixes = 0;     // count fixes during cold-start period
    this.lastFixWallTime = null; // for GPS dropout detection
    this.gpsLostSince = null;
    this.filterStats = { accepted: 0, rejAccuracy: 0, rejJump: 0, rejNoise: 0, rejDrift: 0, rejColdStart: 0 };
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  async start() {
    await this.acquireWakeLock();
    this.tickHandle = setInterval(() => this.tick(), 1000);

    // Wake locks are dropped when the tab is backgrounded. Re-acquire on
    // return so the screen stays on for the next foreground session.
    this._visHandler = () => {
      if (document.visibilityState === 'visible' && this.status === 'running' && !this.wakeLock) {
        this.acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', this._visHandler);

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
    // Prefer the fix's own timestamp.
    const now = pos.timestamp || Date.now();
    const wallNow = Date.now();

    // Update GPS signal indicator regardless of acceptance.
    if (accuracy == null) {
      this.gpsSignal = 'searching';
      this.emit();
      return;
    }
    this.gpsSignal = accuracy < 15 ? 'strong' : accuracy < 30 ? 'fair' : 'searching';

    // Detect signal-restored: if we'd marked gpsLostSince, clear it.
    if (this.gpsLostSince) {
      this.gpsLostSince = null;
    }
    this.lastFixWallTime = wallNow;

    // GATE 0: accuracy floor.
    if (accuracy > MIN_ACCURACY_M) {
      this.filterStats.rejAccuracy++;
      this.emit();
      return;
    }

    const rawFix = { lat: latitude, lon: longitude, t: now, acc: accuracy };

    // COLD START: GPS chips frequently emit one or two terrible first fixes
    // before settling. Skip the first 2 accepted fixes — use them to seed
    // the filter state without recording distance. Strava and Garmin both
    // do this. The user sees a brief "warming up" before recording begins.
    if (this.firstFixes < 2) {
      if (!this.lastFix || this.lastFix.acc > accuracy) {
        this.lastFix = rawFix;
        this.lastPoint = { ...rawFix };
      }
      this.firstFixes++;
      this.filterStats.rejColdStart++;
      this.emit();
      return;
    }

    // First *recorded* fix (after cold-start): re-seed and start the route.
    if (!this.lastPoint || this.points.length === 0) {
      this.lastFix = rawFix;
      this.lastPoint = { ...rawFix };
      this.points.push({ ...rawFix });
      this.filterStats.accepted++;
      this.emit();
      return;
    }

    if (this.status !== 'running') {
      this.emit();
      return;
    }

    const rawD = haversine(this.lastFix, rawFix);
    const dt = (now - this.lastFix.t) / 1000;
    const impliedSpeed = dt > 0 ? rawD / dt : 0;

    // GATE 1: speed jump.
    if (impliedSpeed > SPEED_JUMP_MAX_M_S) {
      this.filterStats.rejJump++;
      this.emit();
      return;
    }

    // GATE 2: noise floor — accuracy-aware.
    const noiseFloor = ACCURACY_NOISE_K * Math.max(accuracy, this.lastFix.acc);
    if (rawD < noiseFloor) {
      this.filterStats.rejNoise++;
      this.emit();
      return;
    }

    // GATE 3: drift while auto-paused.
    if (this.autoPaused && impliedSpeed < STATIONARY_M_PER_S * 2) {
      this.filterStats.rejDrift++;
      this.emit();
      return;
    }

    // GATE 4: GPS dropout recovery — if last accepted fix was > 10s ago,
    // we can't trust the direct line between then and now (might've gone
    // around a corner). Don't accumulate the gap distance; just re-seed.
    if (dt > 10) {
      this.lastFix = rawFix;
      this.lastPoint = { ...rawFix };
      this.points.push({ ...rawFix });
      this.filterStats.accepted++;
      this.emit();
      return;
    }

    // Accuracy-weighted smoothing. The weighting reflects how much to trust
    // the new fix vs the previous accepted point. With equal accuracies, alpha
    // = 0.5 (50/50 blend). When the new fix is more accurate, alpha goes up
    // (lean new). When less accurate, alpha drops (lean old). We deliberately
    // do NOT track posterior accuracy — without process noise it shrinks
    // unboundedly and over-smooths real motion.
    const prevAcc = this.lastFix.acc;
    const alpha = (prevAcc * prevAcc) / (prevAcc * prevAcc + accuracy * accuracy);
    const smoothLat = this.lastPoint.lat * (1 - alpha) + latitude * alpha;
    const smoothLon = this.lastPoint.lon * (1 - alpha) + longitude * alpha;
    const smoothed = { lat: smoothLat, lon: smoothLon, t: now, acc: accuracy };

    const d = haversine(this.lastPoint, smoothed);
    this.distanceM += d;
    this.lastPoint = smoothed;
    this.lastFix = rawFix;
    this.points.push(smoothed);
    this.lastMoveAt = now;
    this.filterStats.accepted++;

    // Rolling pace buffer (cross-phase, 30s window).
    this.rollingBuffer.push({ t: now, dist: this.distanceM });
    while (this.rollingBuffer.length > 1 &&
           now - this.rollingBuffer[0].t > ROLLING_PACE_WINDOW_MS) {
      this.rollingBuffer.shift();
    }

    // Per-phase buffer for run/walk pace display. Reset on phase change.
    this.phaseBuffer.push({ t: now, dist: this.distanceM, phase: this.currentPhase });

    if (this.autoPaused) {
      this.autoPaused = false;
      this.status = 'running';
    }

    this.emit();
  }

  // Returns seconds-per-unit using current-phase samples only. Useful for
  // "what pace am I actually running during the RUN phase?" — independent
  // of the walk segments that drag the overall rolling pace.
  getPhasePaceSecPerUnit(units) {
    if (!this.currentPhase || this.phaseBuffer.length < 2) return null;
    // Use only samples from the current phase
    const samples = this.phaseBuffer.filter(s => s.phase === this.currentPhase);
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    const dd = last.dist - first.dist;
    if (dd < MIN_DISTANCE_FOR_PACE_M / 2 || dt < 3) return null;
    const speed = dd / dt;
    if (speed < 0.05) return null;
    return units === 'metric' ? 1000 / speed : 1609.344 / speed;
  }

  // Watchdog: returns true if no fix has arrived in WALL TIME longer than
  // the timeout. Used by the live screen to surface a "signal lost" banner.
  isGpsLost() {
    if (!this.lastFixWallTime) return false;
    return Date.now() - this.lastFixWallTime > 15000;
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
      // Pacing plan: phase change + anticipation cue.
      if (this.pacingPlan) {
        const result = this.pacingPlan.tick(this.elapsedMs, this.distanceM);
        const sc = window.__soundCoach;
        if (result && result.phase !== this.currentPhase) {
          // Real transition: fire phase-change cue.
          this.currentPhase = result.phase;
          this.phaseBuffer = []; // reset per-phase pace
          if (sc) sc.onPhaseChange(result.phase, result.label);
        } else if (sc && result && result.nextPhase && result.remainingMs > 0) {
          // Anticipation cue: 10s before phase change (or whatever user picked).
          const antMs = sc.anticipationSec * 1000;
          const window_ = 1500; // tolerance — only fire once per transition
          if (result.remainingMs <= antMs && result.remainingMs > antMs - window_) {
            const transitionId = result.phaseIndex + '->' + result.nextPhase;
            if (sc.lastAnticipated !== transitionId) {
              sc.lastAnticipated = transitionId;
              sc.onPhaseAnticipation(
                result.nextPhase,
                Math.round(result.remainingMs / 1000),
                result.nextLabel
              );
            }
          }
        }
      }
      // Fuel coach: tick once per second; fire alert if due.
      if (this.fuelCoach) {
        const alert = this.fuelCoach.tick(this.elapsedMs, this.distanceM);
        if (alert && alert !== this.pendingFuelAlert) {
          this.pendingFuelAlert = alert;
          fireFuelCue(alert);
        }
      }
      // Milestone announcements (mile/km splits).
      const sc = window.__soundCoach;
      if (sc) {
        // Compute last split pace
        const unitM = sc.units === 'metric' ? 1000 : 1609.344;
        const currentMile = Math.floor(this.distanceM / unitM);
        if (currentMile > (this._lastAnnouncedMile || 0)) {
          // Split pace = time since last split / unitM
          const splitStart = this._lastSplitElapsedMs || 0;
          const splitDuration = this.elapsedMs - splitStart;
          const splitSecPerUnit = (splitDuration / 1000) / 1; // 1 unit covered
          sc.onMilestone(this.distanceM, splitSecPerUnit, this.elapsedMs);
          this._lastAnnouncedMile = currentMile;
          this._lastSplitElapsedMs = this.elapsedMs;
        }
        // GPS lost/recovered
        if (this.isGpsLost()) {
          sc.onGpsLost();
        } else if (sc._gpsLostFired) {
          sc.onGpsRecovered();
        }
      }
    }
    this.lastTickAt = now;
    this.emit();
  }

  ackFuel() {
    if (this.fuelCoach && this.fuelCoach.pendingAlert) {
      this.fuelCoach.ack(this.elapsedMs);
      this.pendingFuelAlert = null;
      this.emit();
    }
  }

  dismissFuel() {
    if (this.fuelCoach && this.fuelCoach.pendingAlert) {
      this.fuelCoach.dismiss();
      this.pendingFuelAlert = null;
      this.emit();
    }
  }

  pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.pausedAt = Date.now();
    this.emit();
  }

  resume() {
    if (this.status !== 'paused') return;
    const now = Date.now();
    const pausedDurationMs = this.pausedAt ? now - this.pausedAt : 0;

    // SELF-HEAL: if user paused longer than ~30s and we're running intervals,
    // treat the pause as having served the walk-break purpose. Realign the
    // cycle so resume starts at the top of a fresh RUN phase. Short pauses
    // (water sip, traffic light) resume the cycle unchanged so cadence stays
    // intact.
    if (this.pacingPlan && pausedDurationMs > 30000) {
      const cycleMs = (this.pacingPlan.runSecs + this.pacingPlan.walkSecs) * 1000;
      if (cycleMs > 0) {
        const newElapsed = Math.ceil(this.elapsedMs / cycleMs) * cycleMs;
        if (newElapsed > this.elapsedMs) {
          this.elapsedMs = newElapsed;
        }
      }
      this.currentPhase = null; // force fireCue on next tick
      this.compensatedPauseMs = (this.compensatedPauseMs || 0) + pausedDurationMs;
    }

    this.status = 'running';
    this.lastTickAt = now;
    this.lastMoveAt = now;
    this.autoPaused = false;
    this.emit();
  }

  // Required pace from NOW to hit a distance- or time-based goal, in
  // sec-per-mile. Returns null if no goal or already past it.
  getRequiredPaceSecPerMi() {
    if (this.goalDistM) {
      const remainingMs = (this.targetTotalMs || null);
      if (!remainingMs || this.distanceM >= this.goalDistM) return null;
      // Time remaining = expected total - elapsed. Expected total is set
      // at start by pre-workout from goalDistM + targetPaceSecPerMi.
      const remainingTime = remainingMs - this.elapsedMs;
      if (remainingTime <= 0) return null;
      const remainingMi = (this.goalDistM - this.distanceM) / 1609.344;
      if (remainingMi <= 0) return null;
      return remainingTime / 1000 / remainingMi;
    }
    if (this.goalTimeMs) {
      const remainingMs = this.goalTimeMs - this.elapsedMs;
      if (remainingMs <= 0) return null;
      if (!this.goalProjectedDistanceM) return null;
      const remainingMi = (this.goalProjectedDistanceM - this.distanceM) / 1609.344;
      if (remainingMi <= 0) return null;
      return remainingMs / 1000 / remainingMi;
    }
    return null;
  }

  // Returns the CUMULATIVE average pace (seconds per unit). This is the
  // pace you've actually held for the whole session — stable, slow to react.
  // Use this for goal-completion projections, not rolling pace.
  getAvgPaceSecPerUnit(units) {
    if (this.distanceM < MIN_DISTANCE_FOR_PACE_M) return null;
    const distUnit = units === 'metric' ? this.distanceM / 1000 : this.distanceM / 1609.344;
    return (this.elapsedMs / 1000) / distUnit;
  }

  // Status with hysteresis: cumulative average projected to goal end.
  // - "ahead" requires projected distance > goal + 1% AND held for 20s
  // - "behind" requires projected < goal - 1% AND held for 20s
  // - otherwise "on-track"
  // The hysteresis prevents the chip from flickering on every GPS update.
  getGoalStatus(_unusedNowParam) {
    const avgSecPerMi = this.getAvgPaceSecPerUnit('imperial');
    if (!avgSecPerMi) return null;
    let proposed = null;
    if (this.goalDistM && this.targetTotalMs) {
      // Project: at current avg, how long will it take to cover goalDistM?
      const projectedTotalSec = (this.goalDistM / 1609.344) * avgSecPerMi;
      const projectedTotalMs = projectedTotalSec * 1000;
      const diffMs = projectedTotalMs - this.targetTotalMs;
      const tolMs = this.targetTotalMs * 0.01;  // ±1%
      if      (diffMs >  tolMs) proposed = 'behind';
      else if (diffMs < -tolMs) proposed = 'ahead';
      else                       proposed = 'on-track';
    } else if (this.goalTimeMs && this.goalProjectedDistanceM) {
      // Project: at current avg, how far will we cover in goalTimeMs?
      const projectedMi = (this.goalTimeMs / 1000) / avgSecPerMi;
      const projectedM = projectedMi * 1609.344;
      const diffM = projectedM - this.goalProjectedDistanceM;
      const tolM = this.goalProjectedDistanceM * 0.01;
      if      (diffM < -tolM) proposed = 'behind';
      else if (diffM >  tolM) proposed = 'ahead';
      else                     proposed = 'on-track';
    } else {
      return null;
    }

    // Hysteresis: hold the proposed state for 20s before committing.
    const now = Date.now();
    if (proposed !== this._proposedStatus) {
      this._proposedStatus = proposed;
      this._proposedStatusSince = now;
    }
    if (!this._committedStatus) {
      this._committedStatus = proposed;
    } else if (proposed !== this._committedStatus
               && now - this._proposedStatusSince >= 20000) {
      this._committedStatus = proposed;
    }
    return this._committedStatus;
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
    if (this._visHandler) {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
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
      // Provenance: useful for post-workout review and for future device-
      // comparison studies. All optional, all stable schema additions.
      fuelHistory: this.fuelCoach ? this.fuelCoach.history : [],
      compensatedPauseMs: this.compensatedPauseMs || 0,
      filterStats: { ...this.filterStats },
      pacingPlan: this.pacingPlan
        ? { runSecs: this.pacingPlan.runSecs, walkSecs: this.pacingPlan.walkSecs }
        : null,
      goalDistM: this.goalDistM,
      goalTimeMs: this.goalTimeMs,
      schemaVersion: 2
    };
  }
}

// Compute the run-segment pace required to hit a target AVERAGE pace,
// given an interval ratio and a fixed walk-segment pace.
//
// avgPaceSecPerMi = (Tr + Tw) / (Tr/R + Tw/W)
//   →  R = avgPace * Tr / (Tr + Tw - avgPace * Tw / W)
//
// Returns { runPaceSecPerMi, walkPaceSecPerMi, feasible }.
// Infeasible when the requested average is faster than what's achievable
// even running infinitely fast during the run phase (i.e. denominator ≤ 0).
function computeRunPaceForAvg(avgPaceSecPerMi, walkPaceSecPerMi, runSecs, walkSecs) {
  if (runSecs <= 0) {
    // Walk-only — average IS walk pace, no run target.
    return { runPaceSecPerMi: null, walkPaceSecPerMi, feasible: avgPaceSecPerMi >= walkPaceSecPerMi };
  }
  if (walkSecs <= 0) {
    // Run-only.
    return { runPaceSecPerMi: avgPaceSecPerMi, walkPaceSecPerMi: null, feasible: true };
  }
  const denom = runSecs + walkSecs - avgPaceSecPerMi * walkSecs / walkPaceSecPerMi;
  if (denom <= 0) {
    return { runPaceSecPerMi: null, walkPaceSecPerMi, feasible: false };
  }
  const runPaceSecPerMi = avgPaceSecPerMi * runSecs / denom;
  return { runPaceSecPerMi, walkPaceSecPerMi, feasible: true };
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

// -- Pacing intervals ---------------------------------------------------
// Plans are now sequence-based: an ordered list of phases, each with its
// own duration, kind (work/recovery), label, and target pace. This makes
// it trivial to add variable-phase workouts (Norwegian 4x4, Pyramid, etc.)
// alongside the simple repeating-cycle plans (Galloway, Tactical, Custom).
//
// EVIDENCE-BASED MODES:
// - Galloway (Galloway, 1978): run-walk cycles, ~50% injury reduction
// - Tactical Ruck Shuffle (USMC/Army): scales walk segments by pack weight
// - Norwegian 4x4 (Helgerud et al. 2007, Eur J Appl Physiol): 4×(4min hard /
//   3min easy), gold standard for VO2max gains (5.5% over 8 weeks)
// - Pyramid (mid-distance running canon): 1-2-3-2-1 min with equal recovery
// - Fartlek (Holmér, 1937): randomized speed play for variety/adaptation

class PacingPlan {
  constructor({ sequence, mode = 'loop', label = '' }) {
    // sequence: array of { kind: 'work'|'recovery', durationMs, label, targetSecPerMi }
    // mode: 'loop' (repeat forever) | 'finite' (single pass then steady)
    this.sequence = sequence;
    this.mode = mode;
    this.label = label;
    this.totalMs = sequence.reduce((a, p) => a + p.durationMs, 0);
  }

  // For backward-compat / fuel coach reading runSecs/walkSecs.
  get runSecs() {
    const w = this.sequence.find(p => p.kind === 'work');
    return w ? Math.round(w.durationMs / 1000) : 0;
  }
  get walkSecs() {
    const r = this.sequence.find(p => p.kind === 'recovery');
    return r ? Math.round(r.durationMs / 1000) : 0;
  }

  // Returns the current-phase descriptor and a NEXT-phase hint for anticipation.
  // { phase, kind, label, targetSecPerMi, remainingMs, phaseLengthMs,
  //   phaseIndex, totalPhases, nextPhase, nextLabel, isComplete }
  tick(elapsedMs /*, distM */) {
    if (this.mode === 'finite' && elapsedMs >= this.totalMs) {
      return {
        phase: 'run', kind: 'work', label: 'COOL DOWN',
        targetSecPerMi: null, remainingMs: 0, phaseLengthMs: 0,
        phaseIndex: this.sequence.length, totalPhases: this.sequence.length,
        nextPhase: null, nextLabel: null, isComplete: true
      };
    }
    const intoSeq = this.mode === 'loop' ? elapsedMs % this.totalMs : elapsedMs;
    let acc = 0;
    for (let i = 0; i < this.sequence.length; i++) {
      const phase = this.sequence[i];
      if (intoSeq < acc + phase.durationMs) {
        const next = this.sequence[(i + 1) % this.sequence.length];
        const isLast = (i === this.sequence.length - 1);
        return {
          phase: phase.kind === 'work' ? 'run' : 'walk',
          kind: phase.kind,
          label: phase.label || (phase.kind === 'work' ? 'RUN' : 'WALK'),
          targetSecPerMi: phase.targetSecPerMi || null,
          remainingMs: (acc + phase.durationMs) - intoSeq,
          phaseLengthMs: phase.durationMs,
          phaseIndex: i,
          totalPhases: this.sequence.length,
          nextPhase: (isLast && this.mode === 'finite') ? null
                   : (next.kind === 'work' ? 'run' : 'walk'),
          nextLabel: (isLast && this.mode === 'finite') ? null
                   : (next.label || (next.kind === 'work' ? 'RUN' : 'WALK')),
          isComplete: false
        };
      }
      acc += phase.durationMs;
    }
    return null;
  }
}

// ----- Plan builders --------------------------------------------------

function buildGallowayPlan({ runSecs, walkSecs, runPaceSecPerMi, walkPaceSecPerMi }) {
  return new PacingPlan({
    label: 'GALLOWAY',
    mode: 'loop',
    sequence: [
      { kind: 'work',     durationMs: runSecs * 1000,  label: 'RUN',  targetSecPerMi: runPaceSecPerMi },
      { kind: 'recovery', durationMs: walkSecs * 1000, label: 'WALK', targetSecPerMi: walkPaceSecPerMi }
    ]
  });
}

function buildTacticalPlan({ runSecs, walkSecs, runPaceSecPerMi, walkPaceSecPerMi }) {
  // Same shape as Galloway, different walk pace and label.
  return new PacingPlan({
    label: 'TACTICAL',
    mode: 'loop',
    sequence: [
      { kind: 'work',     durationMs: runSecs * 1000,  label: 'SHUFFLE', targetSecPerMi: runPaceSecPerMi },
      { kind: 'recovery', durationMs: walkSecs * 1000, label: 'MARCH',   targetSecPerMi: walkPaceSecPerMi }
    ]
  });
}

// Norwegian 4x4 (Helgerud et al. 2007). 4 sets of 4min hard / 3min recovery.
// Total 28 min. Hard = 90-95% HRmax (approx target pace minus 30s).
// Recovery = 70% HRmax (easy jog, ~target + 90s).
function buildNorwegianPlan({ workPaceSecPerMi, recoveryPaceSecPerMi }) {
  const phases = [];
  for (let i = 1; i <= 4; i++) {
    phases.push({ kind: 'work',     durationMs: 4 * 60 * 1000, label: `WORK ${i}/4`, targetSecPerMi: workPaceSecPerMi });
    if (i < 4) {
      phases.push({ kind: 'recovery', durationMs: 3 * 60 * 1000, label: `EASY ${i}/3`, targetSecPerMi: recoveryPaceSecPerMi });
    } else {
      phases.push({ kind: 'recovery', durationMs: 5 * 60 * 1000, label: 'COOL DOWN', targetSecPerMi: recoveryPaceSecPerMi });
    }
  }
  return new PacingPlan({ label: 'NORWEGIAN 4×4', mode: 'finite', sequence: phases });
}

// Pyramid: 1-2-3-2-1 min hard with matched recovery. ~18 min total.
function buildPyramidPlan({ workPaceSecPerMi, recoveryPaceSecPerMi }) {
  const phases = [];
  const ladder = [1, 2, 3, 2, 1];
  for (let i = 0; i < ladder.length; i++) {
    const min = ladder[i];
    phases.push({ kind: 'work',     durationMs: min * 60 * 1000, label: `WORK ${min}m`, targetSecPerMi: workPaceSecPerMi });
    phases.push({ kind: 'recovery', durationMs: min * 60 * 1000, label: 'REST',         targetSecPerMi: recoveryPaceSecPerMi });
  }
  return new PacingPlan({ label: 'PYRAMID', mode: 'finite', sequence: phases });
}

// Fartlek: 10 random surge/easy pairs. Surges 30-90s, easy 60-150s.
// Loops so the workout continues with a fresh random sequence each cycle.
function buildFartlekPlan({ workPaceSecPerMi, recoveryPaceSecPerMi, seed }) {
  const phases = [];
  let s = seed || (Date.now() & 0x7fffffff);
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 10; i++) {
    const workMs = (30 + Math.floor(rand() * 60)) * 1000;
    const restMs = (60 + Math.floor(rand() * 90)) * 1000;
    phases.push({ kind: 'work',     durationMs: workMs, label: 'SURGE', targetSecPerMi: workPaceSecPerMi });
    phases.push({ kind: 'recovery', durationMs: restMs, label: 'EASY',  targetSecPerMi: recoveryPaceSecPerMi });
  }
  return new PacingPlan({ label: 'FARTLEK', mode: 'loop', sequence: phases });
}

// -- Fuel & hydration coach --------------------------------------------
// Schedule based on ACSM Position Stand on Hydration and Sports Dietitians
// Australia endurance fueling consensus:
// - Hydration: 0.4–0.8 L/hr standard, 0.6–1.0 L/hr in heat or heavy load
// - Fueling: 30–60 g carbs/hr for sessions > 60 min; up to 90 g/hr beyond
//   2.5 hr if using glucose+fructose blend
// - Pre-empt the 2% bodyweight loss threshold where performance degrades

class FuelCoach {
  constructor({ packKg, mode, goalDistM, goalTimeMs, expectedDurationMs }) {
    this.packKg = packKg || 0;
    this.mode = mode;
    this.goalDistM = goalDistM;
    this.goalTimeMs = goalTimeMs;
    this.expectedDurationMs = expectedDurationMs;
    this.lastAckHydrateMs = 0;
    this.lastAckFuelMs = 0;
    this.pendingAlert = null;
    this.history = [];
  }

  hydrateIntervalMs() {
    if (this.packKg >= 18) return 12 * 60 * 1000;
    if (this.packKg >= 9)  return 14 * 60 * 1000;
    return 15 * 60 * 1000;
  }

  fuelIntervalMs() {
    const total = this.expectedDurationMs || 0;
    if (total > 150 * 60 * 1000) return 30 * 60 * 1000;
    return 45 * 60 * 1000;
  }

  projectedDurationMs(elapsedMs, distanceM) {
    if (this.goalTimeMs) return this.goalTimeMs;
    if (this.goalDistM && distanceM > 100) {
      return elapsedMs * (this.goalDistM / distanceM);
    }
    return this.expectedDurationMs || 0;
  }

  tick(elapsedMs, distanceM) {
    if (this.pendingAlert) return this.pendingAlert;
    const total = this.projectedDurationMs(elapsedMs, distanceM);

    const firstHydrateAt = 20 * 60 * 1000;
    if (elapsedMs >= firstHydrateAt) {
      const dueAt = (this.lastAckHydrateMs || 0) + (this.lastAckHydrateMs ? this.hydrateIntervalMs() : 0);
      if (elapsedMs >= Math.max(firstHydrateAt, dueAt)) {
        const amount = this.packKg >= 9 ? '6–10 oz · 180–300 ml' : '6–8 oz · 180–240 ml';
        this.pendingAlert = { type: 'hydrate', title: 'HYDRATE', text: amount, firedAt: elapsedMs };
        return this.pendingAlert;
      }
    }

    if (total > 60 * 60 * 1000) {
      const firstFuelAt = 45 * 60 * 1000;
      if (elapsedMs >= firstFuelAt) {
        const dueAt = (this.lastAckFuelMs || 0) + (this.lastAckFuelMs ? this.fuelIntervalMs() : 0);
        if (elapsedMs >= Math.max(firstFuelAt, dueAt)) {
          const carbs = total > 150 * 60 * 1000 ? '40–60 g carbs' : '30–45 g carbs';
          this.pendingAlert = { type: 'fuel', title: 'FUEL', text: carbs + ' · gel, chew, or bar', firedAt: elapsedMs };
          return this.pendingAlert;
        }
      }
    }

    return null;
  }

  ack(elapsedMs) {
    if (!this.pendingAlert) return;
    const type = this.pendingAlert.type;
    if (type === 'hydrate') this.lastAckHydrateMs = elapsedMs;
    else if (type === 'fuel') this.lastAckFuelMs = elapsedMs;
    this.history.push({ type, t: elapsedMs });
    this.pendingAlert = null;
  }

  dismiss() {
    if (this.pendingAlert) {
      const type = this.pendingAlert.type;
      const elapsed = this.pendingAlert.firedAt;
      if (type === 'hydrate') this.lastAckHydrateMs = elapsed - this.hydrateIntervalMs() + 5 * 60 * 1000;
      else if (type === 'fuel') this.lastAckFuelMs = elapsed - this.fuelIntervalMs() + 5 * 60 * 1000;
      this.pendingAlert = null;
    }
  }
}

function fuelPlanEstimate({ durationMs, packKg }) {
  if (!durationMs || durationMs < 20 * 60 * 1000) {
    return { hydrationMl: 0, hydrationOz: 0, carbsG: 0, notes: 'Under 20 min — water optional, no carbs needed.' };
  }
  const hours = durationMs / 3600 / 1000;
  const lPerHr = packKg >= 18 ? 0.7 : packKg >= 9 ? 0.55 : 0.5;
  const hydrationL = hours * lPerHr;
  let carbsG = 0;
  if (durationMs > 60 * 60 * 1000) {
    const rate = durationMs > 150 * 60 * 1000 ? 60 : 40;
    carbsG = Math.round((durationMs - 30 * 60 * 1000) / 3600 / 1000 * rate);
  }
  return {
    hydrationMl: Math.round(hydrationL * 1000),
    hydrationOz: Math.round(hydrationL * 33.814),
    carbsG,
    notes: null
  };
}

// -- SoundCoach: speech + audio cues -----------------------------------
// Best-practice references:
// - iOS Safari requires a user gesture to unlock speechSynthesis; we warm
//   up with an empty utterance on the START button gesture.
// - Web Audio API works without user gesture once a context is created in
//   a user gesture. Beeps are more reliable than speech in noisy
//   environments (wind, traffic) and across browsers.
// - Coaching research (sports psychology) shows ANTICIPATION cues 5–10s
//   before transitions improve athletic compliance and reduce abrupt
//   pace shifts. We fire a "warning" beep + speech 10s before each phase
//   change. Splits are announced at every mile/km boundary (Strava/Garmin
//   standard).

const SOUND_OFF      = 'off';
const SOUND_MINIMAL  = 'minimal';   // phase transitions + fuel + GPS lost
const SOUND_FULL     = 'full';      // + milestones (mile/km splits)
const SOUND_VERBOSE  = 'verbose';   // + periodic pace/status announcements

class SoundCoach {
  constructor({ verbosity, anticipationSec, useBeeps, units }) {
    this.verbosity = verbosity || SOUND_FULL;
    this.anticipationSec = anticipationSec != null ? anticipationSec : 10;
    this.useBeeps = useBeeps !== false;
    this.units = units || 'imperial';
    this.lastMilestone = 0;          // last announced mile/km
    this.lastAnticipated = null;     // string ID of the last anticipated transition
    this.lastVerboseAt = 0;          // ms elapsed at last verbose tick
    this.audioCtx = null;
    this.unlocked = false;
  }

  // Call this on a user gesture (the START button) to unlock audio + speech.
  // Without this, iOS Safari silently rejects both APIs.
  unlock() {
    if (this.unlocked) return;
    try {
      if (typeof window !== 'undefined' && 'AudioContext' in window) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
    } catch {}
    try {
      if ('speechSynthesis' in window) {
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
    } catch {}
    this.unlocked = true;
  }

  // Low-level beep at a frequency for a duration. Type: 'sine' (soft) or
  // 'triangle' (sharper). Volume from 0.0–1.0.
  beep(freq, durationMs, { type = 'sine', volume = 0.4 } = {}) {
    if (!this.useBeeps || !this.audioCtx) return;
    try {
      const ctx = this.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      const now = ctx.currentTime;
      // Quick attack + sustain + decay so the click isn't harsh.
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.01);
      gain.gain.setValueAtTime(volume, now + (durationMs / 1000) - 0.05);
      gain.gain.linearRampToValueAtTime(0, now + (durationMs / 1000));
      osc.start(now);
      osc.stop(now + (durationMs / 1000));
    } catch {}
  }

  // Three quick ascending beeps — universal "attention" pattern.
  triplet({ baseHz = 660, type = 'sine' } = {}) {
    if (!this.useBeeps || !this.audioCtx) return;
    [0, 150, 300].forEach((delay, i) => {
      setTimeout(() => this.beep(baseHz + i * 100, 120, { type }), delay);
    });
  }

  // Speak a phrase. Cancels any queued speech so the latest cue wins.
  // Falls back silently if speech is unavailable or blocked.
  say(text, { rate = 1.0, urgent = false } = {}) {
    if (this.verbosity === SOUND_OFF) return;
    try {
      if ('speechSynthesis' in window) {
        if (urgent) window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        u.volume = 1.0;
        u.pitch = 1.0;
        window.speechSynthesis.speak(u);
      }
    } catch {}
  }

  // Haptic (mobile only).
  buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
  }

  // ----- Cue methods (called from LiveWorkout) -----

  // Phase change ACTUALLY happens now (run -> walk or walk -> run).
  onPhaseChange(phase, label) {
    if (this.verbosity === SOUND_OFF) return;
    if (phase === 'run') {
      // Rising 2-beep pattern
      this.beep(440, 100);
      setTimeout(() => this.beep(660, 150), 130);
      this.buzz([100, 60, 200]);
      this.say(label || (phase === 'run' ? 'Run' : 'Walk'), { urgent: true });
    } else {
      // Falling 2-beep pattern
      this.beep(660, 100);
      setTimeout(() => this.beep(440, 150), 130);
      this.buzz([200, 60, 100]);
      this.say(label || 'Walk', { urgent: true });
    }
    this.lastAnticipated = null;
  }

  // 10s warning before phase change. Single soft chime + speech.
  onPhaseAnticipation(nextPhase, secsLeft, label) {
    if (this.verbosity === SOUND_OFF) return;
    this.beep(880, 80, { type: 'sine', volume: 0.3 });
    this.buzz(50);
    const txt = Math.round(secsLeft) + ' seconds to ' + (label || (nextPhase === 'run' ? 'run' : 'walk'));
    this.say(txt);
  }

  // Fuel / hydration alert.
  onFuelAlert(alert) {
    if (this.verbosity === SOUND_OFF) return;
    // Distinct 3-beep ascending pattern so user knows it's not a phase cue.
    this.triplet({ baseHz: 523 });  // C5 base
    this.buzz([200, 80, 200, 80, 200]);
    const msg = alert.type === 'hydrate' ? 'Hydrate' : 'Time to fuel';
    this.say(msg, { urgent: true });
  }

  // Mile/km split — announce at each unit boundary if verbosity >= FULL.
  onMilestone(distM, paceSecPerUnitForLastSplit, elapsedMs) {
    if (this.verbosity !== SOUND_FULL && this.verbosity !== SOUND_VERBOSE) return;
    const unitM = this.units === 'metric' ? 1000 : 1609.344;
    const completed = Math.floor(distM / unitM);
    if (completed <= this.lastMilestone) return;
    this.lastMilestone = completed;
    // Sharp triplet for milestone — different timbre from fuel alert.
    if (this.audioCtx) {
      [0, 100, 200].forEach((delay, i) => {
        setTimeout(() => this.beep(1000, 100, { type: 'triangle', volume: 0.35 }), delay);
      });
    }
    this.buzz([80, 40, 80]);
    const unitLabel = this.units === 'metric' ? 'kilometer' : 'mile';
    let phrase = completed + ' ' + unitLabel + (completed > 1 ? 's' : '');
    if (paceSecPerUnitForLastSplit && isFinite(paceSecPerUnitForLastSplit)) {
      const m = Math.floor(paceSecPerUnitForLastSplit / 60);
      const s = Math.round(paceSecPerUnitForLastSplit % 60);
      phrase += '. Last split, ' + m + (s === 0 ? ' even' : ' ' + s);
    }
    this.say(phrase);
  }

  // Verbose periodic update — pace + status every 2 min, only in verbose mode.
  onVerboseTick(elapsedMs, currentPaceSecPerMi, status) {
    if (this.verbosity !== SOUND_VERBOSE) return;
    if (elapsedMs - this.lastVerboseAt < 2 * 60 * 1000) return;
    this.lastVerboseAt = elapsedMs;
    if (!currentPaceSecPerMi || !isFinite(currentPaceSecPerMi)) return;
    const unitPaceSec = this.units === 'metric'
      ? currentPaceSecPerMi / 1.609344
      : currentPaceSecPerMi;
    const m = Math.floor(unitPaceSec / 60);
    const s = Math.round(unitPaceSec % 60);
    const unit = this.units === 'metric' ? 'per kilometer' : 'per mile';
    let phrase = 'Current pace ' + m + (s === 0 ? ' even' : ' ' + s) + ' ' + unit;
    if (status === 'on-track') phrase += '. On track.';
    else if (status === 'ahead') phrase += '. You are ahead of target.';
    else if (status === 'behind') phrase += '. You are behind target.';
    this.say(phrase);
  }

  // GPS signal lost — softer cue, doesn't repeat constantly.
  onGpsLost() {
    if (this.verbosity === SOUND_OFF) return;
    if (this._gpsLostFired && Date.now() - this._gpsLostFired < 60000) return;
    this._gpsLostFired = Date.now();
    this.beep(200, 200, { type: 'triangle', volume: 0.5 });
    this.buzz([300]);
    this.say('GPS signal lost');
  }

  onGpsRecovered() {
    if (this._gpsLostFired) {
      this.beep(800, 100, { type: 'sine', volume: 0.3 });
      this.say('Signal restored');
      this._gpsLostFired = null;
    }
  }
}

// Backwards-compat shims for old call sites. LiveWorkout uses these names.
function fireCue(phase) {
  const sc = window.__soundCoach;
  if (sc) sc.onPhaseChange(phase);
}

function fireFuelCue(alert) {
  const sc = window.__soundCoach;
  if (sc) sc.onFuelAlert(alert);
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

  // Wire all tile-click → openSheet handlers
  wireTiles(node);

  // Mode toggle (now inside the mode sheet)
  let mode = 'ruck';
  const packTile = node.querySelector('#tile-pack');
  node.querySelectorAll('.mode').forEach(b => {
    b.addEventListener('click', () => {
      node.querySelectorAll('.mode').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      mode = b.dataset.mode;
      if (packTile) packTile.style.display = mode === 'ruck' ? '' : 'none';
      renderTileSummaries();
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
  // Default goal: 3 mi (4828m) — clean grid value for the stepper.
  let goalDistM = 3 * 1609.344;
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
    // Round the total first to avoid the classic "34:60" rollover when
    // floating-point inputs produce e.g. 2099.999 (Math.floor(34.999)=34,
    // Math.round(59.999)=60).
    const total = Math.max(0, Math.round(totalSec));
    const m = Math.floor(total / 60);
    const s = total % 60;
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

  // Returns the per-phase target paces. Behavior depends on method:
  // - 'off', 'galloway', 'tactical', 'custom': user's pace IS the AVERAGE.
  //   We solve for the run-segment pace required to hit it.
  // - 'norwegian', 'pyramid', 'fartlek': user's pace IS the WORK pace
  //   directly. Recovery pace is auto-derived.
  function getPhaseTargets() {
    const userPaceSecPerMi = settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
    if (method === 'off') {
      return { runPaceSecPerMi: userPaceSecPerMi, walkPaceSecPerMi: null, feasible: true, mode: 'pace' };
    }
    if (method === 'norwegian' || method === 'pyramid' || method === 'fartlek') {
      // Work pace = user's pick. Recovery = user pace + 90s (easy jog).
      return {
        runPaceSecPerMi: userPaceSecPerMi,
        walkPaceSecPerMi: userPaceSecPerMi + 90,
        feasible: true,
        mode: 'effort'
      };
    }
    // Pace-driven: galloway, tactical, custom.
    const ratio = getDerivedRatio();
    if (!ratio) return null;
    const defaultWalk = method === 'tactical' ? 17 * 60 : 18 * 60;
    const r = computeRunPaceForAvg(userPaceSecPerMi, defaultWalk, ratio.runSecs, ratio.walkSecs);
    return { ...r, mode: 'pace' };
  }

  function formatPaceSecPerMi(secPerMi) {
    if (!isFinite(secPerMi) || secPerMi <= 0) return '--:--';
    const secPerUnit = settings.units === 'metric' ? secPerMi / 1.609344 : secPerMi;
    return formatMinSec(secPerUnit) + '/' + unitLabel().toLowerCase();
  }

  function isEffortMode(m) {
    return m === 'norwegian' || m === 'pyramid' || m === 'fartlek';
  }

  function renderConfigurator() {
    paceConfig.classList.toggle('hidden', method === 'off');
    customConfig.classList.toggle('hidden', method !== 'custom');
    paceValEl.textContent = formatMinSec(paceSecPerUnit);
    runValEl.textContent = formatMinSec(customRunSecs);
    walkValEl.textContent = formatMinSec(customWalkSecs);

    // Toggle pace label between AVERAGE TARGET (pace-driven) and WORK PACE (effort-driven).
    const paceLabel = node.querySelector('#pace-label');
    if (paceLabel) {
      paceLabel.textContent = isEffortMode(method) ? 'WORK PACE (HARD EFFORT)' : 'AVERAGE TARGET PACE';
    }

    // Compute per-phase targets and display them.
    const ratio = getDerivedRatio();
    const targets = getPhaseTargets();

    if (method === 'off') {
      paceDerivedEl.textContent = '';
    } else if (isEffortMode(method)) {
      // Effort-driven: just display the work/recovery paces.
      let txt = '';
      if (method === 'norwegian') {
        txt = `Plan: 4 × (4 min @ ${formatPaceSecPerMi(targets.runPaceSecPerMi)}, 3 min easy)\nTotal ~28 min. Easy: ${formatPaceSecPerMi(targets.walkPaceSecPerMi)}`;
      } else if (method === 'pyramid') {
        txt = `Plan: 1-2-3-2-1 min work / equal rest\nWork @ ${formatPaceSecPerMi(targets.runPaceSecPerMi)}, rest @ ${formatPaceSecPerMi(targets.walkPaceSecPerMi)}`;
      } else if (method === 'fartlek') {
        txt = `Plan: random 30–90s surges / 60–150s easy\nSurge @ ${formatPaceSecPerMi(targets.runPaceSecPerMi)}, easy @ ${formatPaceSecPerMi(targets.walkPaceSecPerMi)}`;
      }
      paceDerivedEl.textContent = txt;
    } else if (ratio && targets) {
      // Pace-driven: galloway/tactical/custom — show the math.
      const r = formatMinSec(ratio.runSecs);
      const w = formatMinSec(ratio.walkSecs);
      let txt = `Intervals: ${r} run / ${w} walk`;
      if (ratio.advisory) txt += ` · ${ratio.advisory}`;
      if (!targets.feasible) {
        txt += ` · ⚠ avg too fast — even infinite run pace can't compensate for the walk segments`;
      } else if (targets.runPaceSecPerMi != null && targets.walkPaceSecPerMi != null) {
        txt += `\n→ Run @ ${formatPaceSecPerMi(targets.runPaceSecPerMi)} · Walk @ ${formatPaceSecPerMi(targets.walkPaceSecPerMi)} to average ${formatMinSec(paceSecPerUnit)}/${unitLabel().toLowerCase()}`;
      }
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
    renderTileSummaries();
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
    // Fuel plan preview
    const plan = node.querySelector('#fuel-plan-preview');
    if (!plan) return;
    if (goalType === 'none') {
      plan.classList.add('hidden');
      return;
    }
    const packKgNow = settings.units === 'metric'
      ? (parseFloat(packInput.value) || 0)
      : (parseFloat(packInput.value) || 0) / 2.20462;
    let durationMs = null;
    if (goalType === 'distance') {
      durationMs = estimateGoalCompletionMs();
    } else if (goalType === 'time') {
      durationMs = goalTimeSec * 1000;
    }
    if (!durationMs) {
      plan.classList.add('hidden');
      return;
    }
    const est = fuelPlanEstimate({ durationMs, packKg: packKgNow });
    plan.classList.remove('hidden');
    const waterEl = node.querySelector('#fuel-plan-water');
    const carbsEl = node.querySelector('#fuel-plan-carbs');
    const notesEl = node.querySelector('#fuel-plan-notes');
    if (settings.units === 'metric') {
      waterEl.textContent = est.hydrationMl ? `${est.hydrationMl} ml` : '—';
    } else {
      waterEl.textContent = est.hydrationOz ? `${est.hydrationOz} oz` : '—';
    }
    carbsEl.textContent = est.carbsG ? `${est.carbsG} g carbs` : 'not needed (<60 min)';
    if (est.notes) {
      notesEl.textContent = est.notes;
      notesEl.classList.remove('hidden');
    } else {
      notesEl.textContent = '';
    }
    renderTileSummaries();
  }

  function renderTileSummaries() {
    // MODE tile
    const tMode = node.querySelector('#tile-mode-val');
    if (tMode) tMode.textContent = mode === 'ruck' ? 'RUCK' : 'RUN';

    // PACK tile
    const tPack = node.querySelector('#tile-pack-val');
    if (tPack) {
      const v = parseFloat(packInput.value) || 0;
      tPack.textContent = v + ' ' + (settings.units === 'metric' ? 'KG' : 'LBS');
    }

    // PACING tile
    const tPacing = node.querySelector('#tile-pacing-val');
    const tPacingD = node.querySelector('#tile-pacing-detail');
    const pacingTile = node.querySelector('.tile[data-sheet="pacing"]');
    if (tPacing && tPacingD) {
      if (method === 'off') {
        tPacing.textContent = 'Off · steady';
        tPacingD.textContent = '';
      } else {
        const methodNames = {
          galloway: 'Galloway',
          tactical: 'Tactical',
          custom: 'Custom',
          norwegian: 'Norwegian 4×4',
          pyramid: 'Pyramid 1-2-3-2-1',
          fartlek: 'Fartlek'
        };
        const targets = getPhaseTargets();
        if (isEffortMode(method)) {
          tPacing.textContent = methodNames[method];
          if (targets && targets.runPaceSecPerMi) {
            tPacingD.textContent = 'Work @ ' + formatPaceSecPerMi(targets.runPaceSecPerMi);
          }
        } else {
          tPacing.textContent = methodNames[method] + ' · ' + formatMinSec(paceSecPerUnit) + ' avg';
          if (targets && targets.runPaceSecPerMi && targets.walkPaceSecPerMi) {
            tPacingD.textContent = 'Run ' + formatPaceSecPerMi(targets.runPaceSecPerMi) +
                                   ' · Walk ' + formatPaceSecPerMi(targets.walkPaceSecPerMi);
          } else {
            tPacingD.textContent = '';
          }
        }
      }
      // Injury warning ports to the tile + a pill below
      const paceSecPerMi = settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
      const warn = injuryRiskWarning(method, paceSecPerMi, getCurrentPackLbs());
      const injuryPill = node.querySelector('#injury-pill');
      if (pacingTile) {
        pacingTile.classList.remove('warn', 'danger');
        if (warn) pacingTile.classList.add(warn.level === 'danger' ? 'danger' : 'warn');
      }
      if (injuryPill) {
        if (warn) {
          injuryPill.classList.remove('hidden');
          injuryPill.classList.toggle('danger', warn.level === 'danger');
          injuryPill.textContent = warn.level === 'danger' ? '⚠ HIGH INJURY RISK' : '⚠ CAUTION';
        } else {
          injuryPill.classList.add('hidden');
        }
      }
    }

    // GOAL tile
    const tGoal = node.querySelector('#tile-goal-val');
    const tGoalD = node.querySelector('#tile-goal-detail');
    if (tGoal && tGoalD) {
      if (goalType === 'none') {
        tGoal.textContent = 'None';
        tGoalD.textContent = '';
      } else if (goalType === 'distance') {
        const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
        tGoal.textContent = inUnit.toFixed(1) + ' ' + unitLabel();
        const ms = estimateGoalCompletionMs();
        if (ms) tGoalD.textContent = 'ETA ' + formatMinSec(ms / 1000);
        else tGoalD.textContent = '';
      } else if (goalType === 'time') {
        tGoal.textContent = Math.round(goalTimeSec / 60) + ' min';
        const m = estimateGoalDistanceM();
        if (m) {
          const inUnit = settings.units === 'metric' ? m / 1000 : m / 1609.344;
          tGoalD.textContent = 'Expected: ' + inUnit.toFixed(2) + ' ' + unitLabel().toLowerCase();
        } else {
          tGoalD.textContent = '';
        }
      }
    }

    // COACHING tile
    const tCoach = node.querySelector('#tile-coaching-val');
    if (tCoach) {
      const v = settings.voiceCues || 'full';
      const ant = settings.anticipationSec != null ? settings.anticipationSec : 10;
      const voiceLabels = { off: 'No voice', minimal: 'Minimal voice', full: 'Full voice', verbose: 'Verbose voice' };
      tCoach.textContent = voiceLabels[v] + ' · ' + (ant === 0 ? 'no warning' : ant + 's warning');
    }
  }

  function getEffectiveSecPerMi() {
    // After the average-pace refactor: the user's target IS the average
    // they want to hit. The app solves for the per-phase paces required
    // to achieve it. So effective pace equals target pace directly.
    // (Old code averaged target-as-run with walk pace, double-counting the
    // walk segments and producing a slower-than-target ETA.)
    if (method === 'off') {
      return settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
    }
    // Check feasibility: if the chosen average is impossible given the
    // ratio, fall back to a realistic effective pace.
    const targets = getPhaseTargets();
    if (targets && !targets.feasible) {
      // Use the best-case (run pace = some realistic fast pace) to compute
      // a fall-back effective average. We use 6:00/mi as a generous run cap.
      const ratio = getDerivedRatio();
      if (ratio && ratio.runSecs > 0 && ratio.walkSecs > 0) {
        const defaultWalk = method === 'tactical' ? 17 * 60 : 18 * 60;
        const fastestRun = 6 * 60;
        const cycleDistMi = ratio.runSecs / fastestRun + ratio.walkSecs / defaultWalk;
        return (ratio.runSecs + ratio.walkSecs) / cycleDistMi;
      }
    }
    return settings.units === 'metric' ? paceSecPerUnit * 1.609344 : paceSecPerUnit;
  }

  function estimateGoalCompletionMs() {
    if (goalType !== 'distance') return null;
    const effectiveSecPerMi = getEffectiveSecPerMi();
    const distMi = goalDistM / 1609.344;
    return distMi * effectiveSecPerMi * 1000;
  }

  function estimateGoalDistanceM() {
    if (goalType !== 'time') return null;
    const effectiveSecPerMi = getEffectiveSecPerMi();
    const distMi = goalTimeSec / effectiveSecPerMi;
    return distMi * 1609.344;
  }

  function estimateGoalCompletion() {
    if (goalType === 'distance') {
      const ms = estimateGoalCompletionMs();
      if (ms == null) return null;
      return `ETA at this pace: ${formatMinSec(ms / 1000)}`;
    }
    if (goalType === 'time') {
      const m = estimateGoalDistanceM();
      if (m == null) return null;
      const distInUnit = settings.units === 'metric' ? m / 1000 : m / 1609.344;
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

  // Goal stepper: distance ±0.1 unit (snapped to clean grid), time ±5 min
  node.querySelector('#goal-minus').addEventListener('click', () => {
    if (goalType === 'distance') {
      const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
      const rounded = Math.round(inUnit * 10) / 10;
      const next = Math.max(0.5, +(rounded - 0.1).toFixed(1));
      goalDistM = settings.units === 'metric' ? next * 1000 : next * 1609.344;
    } else if (goalType === 'time') {
      goalTimeSec = Math.max(5 * 60, goalTimeSec - 5 * 60);
    }
    renderGoal();
  });
  node.querySelector('#goal-plus').addEventListener('click', () => {
    if (goalType === 'distance') {
      const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
      const rounded = Math.round(inUnit * 10) / 10;
      const next = Math.min(50, +(rounded + 0.1).toFixed(1));
      goalDistM = settings.units === 'metric' ? next * 1000 : next * 1609.344;
    } else if (goalType === 'time') {
      goalTimeSec = Math.min(8 * 60 * 60, goalTimeSec + 5 * 60);
    }
    renderGoal();
  });

  renderConfigurator();

  // Wire coaching sheet — live-saves to settings so the pre-flight summary
  // updates as the user changes voice/sound/anticipation.
  const preVoice = node.querySelector('#pre-set-voice');
  const preSounds = node.querySelector('#pre-set-sounds');
  const preAnt = node.querySelector('#pre-set-anticipation');
  if (preVoice && preSounds && preAnt) {
    preVoice.value = settings.voiceCues || 'full';
    preSounds.checked = settings.soundEffects !== false;
    preAnt.value = String(settings.anticipationSec != null ? settings.anticipationSec : 10);
    const saveCoaching = () => {
      saveSettings({
        ...settings,
        voiceCues: preVoice.value,
        soundEffects: preSounds.checked,
        anticipationSec: parseInt(preAnt.value, 10) || 0
      });
      Object.assign(settings, loadSettings());
      renderTileSummaries();
    };
    preVoice.addEventListener('change', saveCoaching);
    preSounds.addEventListener('change', saveCoaching);
    preAnt.addEventListener('change', saveCoaching);
  }

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
    const targets = getPhaseTargets();
    const userPaceSecPerMi = settings.units === 'metric'
      ? paceSecPerUnit * 1.609344
      : paceSecPerUnit;

    // Build the PacingPlan based on method.
    if (method === 'galloway' || method === 'tactical' || method === 'custom') {
      const ratio = getDerivedRatio();
      if (ratio && (ratio.runSecs > 0 || ratio.walkSecs > 0) && targets && targets.feasible) {
        const builder = method === 'tactical' ? buildTacticalPlan : buildGallowayPlan;
        lw.pacingPlan = builder({
          runSecs: ratio.runSecs,
          walkSecs: ratio.walkSecs,
          runPaceSecPerMi: targets.runPaceSecPerMi,
          walkPaceSecPerMi: targets.walkPaceSecPerMi
        });
      }
    } else if (method === 'norwegian') {
      lw.pacingPlan = buildNorwegianPlan({
        workPaceSecPerMi: targets.runPaceSecPerMi,
        recoveryPaceSecPerMi: targets.walkPaceSecPerMi
      });
    } else if (method === 'pyramid') {
      lw.pacingPlan = buildPyramidPlan({
        workPaceSecPerMi: targets.runPaceSecPerMi,
        recoveryPaceSecPerMi: targets.walkPaceSecPerMi
      });
    } else if (method === 'fartlek') {
      lw.pacingPlan = buildFartlekPlan({
        workPaceSecPerMi: targets.runPaceSecPerMi,
        recoveryPaceSecPerMi: targets.walkPaceSecPerMi
      });
    }

    if (method !== 'off') {
      // For pace-driven modes, target IS the average. For effort-driven modes,
      // there's no meaningful "target average" — set it to null to disable
      // the avg-based color cue and status chip.
      lw.targetPaceSecPerMi = isEffortMode(method) ? null : userPaceSecPerMi;
    }

    // Compute expected total duration: used by fuel coach and goal status.
    let expectedDurationMs = null;
    let expectedDistanceM = null;
    if (goalType === 'distance') {
      lw.goalDistM = goalDistM;
      // Effective pace including walk segments for ETA.
      const eta = estimateGoalCompletionMs();
      expectedDurationMs = eta;
      lw.targetTotalMs = eta;
    } else if (goalType === 'time') {
      lw.goalTimeMs = goalTimeSec * 1000;
      expectedDurationMs = goalTimeSec * 1000;
      expectedDistanceM = estimateGoalDistanceM();
      lw.goalProjectedDistanceM = expectedDistanceM;
    }

    // Fuel coach is enabled whenever there's any session expected to exceed
    // 20 min (the hydration threshold). Always-on if pack ≥ 9 kg.
    const shouldCoach = (expectedDurationMs && expectedDurationMs >= 20 * 60 * 1000)
      || (packKg >= 9);
    if (shouldCoach) {
      lw.fuelCoach = new FuelCoach({
        packKg, mode,
        goalDistM: lw.goalDistM,
        goalTimeMs: lw.goalTimeMs,
        expectedDurationMs
      });
    }

    // Instantiate SoundCoach for this workout. Reads voice/sound prefs
    // from settings. The unlock() call happens HERE inside the user-gesture
    // handler — required for iOS Safari to allow audio + speech later.
    const sc = new SoundCoach({
      verbosity: settings.voiceCues || SOUND_FULL,
      anticipationSec: settings.anticipationSec != null ? settings.anticipationSec : 10,
      useBeeps: settings.soundEffects !== false,
      units: settings.units
    });
    sc.unlock();
    window.__soundCoach = sc;

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
  const avgPaceEl = node.querySelector('#live-avg-pace');
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
  const goalStatusChip = node.querySelector('#goal-status-chip');
  const requiredPaceHint = node.querySelector('#required-pace-hint');
  const fuelAlertEl = node.querySelector('#fuel-alert');
  const fuelAlertTitle = node.querySelector('#fuel-alert-title');
  const fuelAlertDetail = node.querySelector('#fuel-alert-detail');

  if (live.mode !== 'ruck') {
    packStat.style.display = 'none';
  } else {
    packEl.textContent = Units.formatWeight(live.packWeightKg, settings.units);
  }

  node.querySelector('#fuel-done').addEventListener('click', () => {
    live.ackFuel();
    toast('Logged', 'success');
  });
  node.querySelector('#fuel-skip').addEventListener('click', () => {
    live.dismissFuel();
  });

  function formatPaceSecPerUnit(secPerMi) {
    if (!isFinite(secPerMi)) return '--:--';
    const sec = settings.units === 'metric' ? secPerMi / 1.609344 : secPerMi;
    return Units.formatPace(sec);
  }

  const update = () => {
    distEl.textContent = Units.formatDistance(live.distanceM, settings.units);
    durEl.textContent = Units.formatDuration(live.elapsedMs);

    // ROLLING pace (30s window) — "current effort". Noisy by design but
    // responsive. This is what the user feels right now.
    const rolling = live.getRollingPaceSecPerUnit(settings.units);
    let currentSecPerUnit = null;
    if (rolling != null) {
      currentSecPerUnit = rolling;
      paceEl.textContent = Units.formatPace(rolling);
    } else if (live.distanceM > MIN_DISTANCE_FOR_PACE_M) {
      // Fall back to cumulative average if rolling not yet warm.
      currentSecPerUnit = settings.units === 'metric'
        ? (live.elapsedMs / 1000) / (live.distanceM / 1000)
        : (live.elapsedMs / 1000) / (live.distanceM / 1609.344);
      paceEl.textContent = Units.formatPace(currentSecPerUnit);
    } else {
      paceEl.textContent = '--:--';
    }

    // CUMULATIVE average pace — stable, used for goal-status projection.
    const avgSecPerUnit = live.getAvgPaceSecPerUnit(settings.units);
    if (avgSecPerUnit != null) {
      avgPaceEl.textContent = Units.formatPace(avgSecPerUnit);
    } else {
      avgPaceEl.textContent = '--:--';
    }

    // Pace color cue on the ROLLING pace (current effort vs target).
    paceEl.classList.remove('on-target', 'slow', 'too-slow', 'too-fast');
    if (currentSecPerUnit != null && live.targetPaceSecPerMi != null) {
      const targetSec = settings.units === 'metric'
        ? live.targetPaceSecPerMi / 1.609344
        : live.targetPaceSecPerMi;
      const diff = currentSecPerUnit - targetSec;
      if      (diff > 30) paceEl.classList.add('too-slow');
      else if (diff > 10) paceEl.classList.add('slow');
      else if (diff < -15) paceEl.classList.add('too-fast');
      else                 paceEl.classList.add('on-target');
    }

    pausedOverlay.classList.toggle('hidden', live.status !== 'paused');
    if (gpsChip) {
      if (live.isGpsLost()) {
        gpsChip.className = 'gps-chip lost';
        gpsChip.textContent = '⚠ SIGNAL LOST';
      } else {
        const sig = live.gpsSignal || 'searching';
        gpsChip.className = 'gps-chip ' + sig;
        gpsChip.textContent = '📡 ' + sig.toUpperCase();
      }
    }

    // Pacing banner — visible only if a plan is attached.
    if (live.pacingPlan && pacingBanner) {
      const result = live.pacingPlan.tick(live.elapsedMs, live.distanceM);
      pacingBanner.classList.remove('hidden');
      pacingBanner.classList.toggle('run', result.phase === 'run');
      pacingBanner.classList.toggle('walk', result.phase === 'walk');
      pacingPhaseEl.textContent = result.label || (result.phase === 'run' ? 'RUN' : 'WALK');
      if (result.isComplete) {
        pacingRemainingEl.textContent = 'COMPLETE';
      } else if (result.remainingMs != null) {
        const s = Math.ceil(result.remainingMs / 1000);
        const mm = Math.floor(s / 60).toString().padStart(2, '0');
        const ss = (s % 60).toString().padStart(2, '0');
        pacingRemainingEl.textContent = mm + ':' + ss + ' LEFT';
      }

      // Target + phase pace in the banner second row.
      const pacingTargetEl = node.querySelector('#pacing-target');
      const pacingCurrentEl = node.querySelector('#pacing-current');
      if (pacingTargetEl && pacingCurrentEl) {
        if (result.targetSecPerMi) {
          pacingTargetEl.textContent = 'target ' + formatPaceSecPerUnit(result.targetSecPerMi);
        } else {
          pacingTargetEl.textContent = '';
        }
        // Show phase-only pace (only samples within this phase) — more
        // actionable than rolling, since intervals contaminate cross-phase.
        const phasePace = live.getPhasePaceSecPerUnit(settings.units);
        if (phasePace != null) {
          pacingCurrentEl.textContent = 'phase ' + Units.formatPace(phasePace);
          pacingCurrentEl.classList.remove('on-target', 'slow', 'too-slow', 'too-fast');
          if (result.targetSecPerMi) {
            const targetSecPerUnit = settings.units === 'metric'
              ? result.targetSecPerMi / 1.609344
              : result.targetSecPerMi;
            const diff = phasePace - targetSecPerUnit;
            if      (diff >  30) pacingCurrentEl.classList.add('too-slow');
            else if (diff >  10) pacingCurrentEl.classList.add('slow');
            else if (diff < -15) pacingCurrentEl.classList.add('too-fast');
            else                 pacingCurrentEl.classList.add('on-target');
          }
        } else {
          pacingCurrentEl.textContent = 'phase --:--';
          pacingCurrentEl.classList.remove('on-target', 'slow', 'too-slow', 'too-fast');
        }
      }
    } else if (pacingBanner) {
      pacingBanner.classList.add('hidden');
    }

    // Goal progress + status. Uses CUMULATIVE average with hysteresis —
    // stable, won't flicker between AHEAD/BEHIND every few seconds.
    if ((live.goalDistM || live.goalTimeMs) && goalProgress) {
      goalProgress.classList.remove('hidden');
      let pct, currentTxt, targetTxt;
      if (live.goalDistM) {
        pct = Math.min(100, (live.distanceM / live.goalDistM) * 100);
        currentTxt = Units.formatDistance(live.distanceM, settings.units);
        targetTxt = Units.formatDistance(live.goalDistM, settings.units);
      } else {
        pct = Math.min(100, (live.elapsedMs / live.goalTimeMs) * 100);
        currentTxt = Units.formatDuration(live.elapsedMs);
        targetTxt = Units.formatDuration(live.goalTimeMs);
      }
      goalFill.style.width = pct + '%';
      goalCurrentEl.textContent = currentTxt;
      goalTargetEl.textContent = targetTxt;

      const status = live.getGoalStatus();
      goalStatusChip.classList.remove('on-track', 'ahead', 'behind');
      if (status) {
        goalStatusChip.classList.add(status);
        goalStatusChip.textContent = status === 'on-track' ? 'ON TRACK'
          : status === 'ahead' ? 'AHEAD' : 'BEHIND';
      } else {
        goalStatusChip.textContent = '';
      }

      // Required pace hint — shown when BEHIND so user knows what to do.
      const req = live.getRequiredPaceSecPerMi();
      if (req != null && status === 'behind' && currentSecPerUnit != null) {
        requiredPaceHint.classList.remove('hidden');
        const currentSecPerMi = settings.units === 'metric'
          ? currentSecPerUnit * 1.609344
          : currentSecPerUnit;
        const isUrgent = req < currentSecPerMi - 60;
        requiredPaceHint.classList.toggle('urgent', isUrgent);
        requiredPaceHint.textContent = 'Run ' + formatPaceSecPerUnit(req) + ' to recover';
      } else {
        requiredPaceHint.classList.add('hidden');
      }

      // Verbose voice tick: announce pace + status periodically (only in
      // verbose mode; the SoundCoach itself rate-limits to once per 2 min).
      const sc = window.__soundCoach;
      if (sc && currentSecPerUnit != null) {
        const currentSecPerMi = settings.units === 'metric'
          ? currentSecPerUnit * 1.609344
          : currentSecPerUnit;
        sc.onVerboseTick(live.elapsedMs, currentSecPerMi, status);
      }
    } else if (goalProgress) {
      goalProgress.classList.add('hidden');
    }

    // Fuel/hydration alert
    if (live.pendingFuelAlert && fuelAlertEl) {
      fuelAlertEl.classList.remove('hidden');
      fuelAlertTitle.textContent = live.pendingFuelAlert.title;
      fuelAlertDetail.textContent = live.pendingFuelAlert.text;
    } else if (fuelAlertEl) {
      fuelAlertEl.classList.add('hidden');
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
  wireTiles(node);

  const unitsSel = node.querySelector('#set-units');
  const packIn = node.querySelector('#set-packweight');
  const bwIn = node.querySelector('#set-bodyweight');
  const apToggle = node.querySelector('#set-autopause');
  const voiceSel = node.querySelector('#set-voice');
  const soundsToggle = node.querySelector('#set-sounds');
  const antSel = node.querySelector('#set-anticipation');

  unitsSel.value = settings.units;
  packIn.value = Units.formatWeight(
    Units.toWeightInternal(settings.defaultPackWeight, settings.units),
    settings.units
  );
  if (settings.bodyWeight) {
    bwIn.value = Math.round(Units.fromWeightInternal(settings.bodyWeight, settings.units));
  }
  apToggle.checked = !!settings.autoPause;
  voiceSel.value = settings.voiceCues || 'full';
  soundsToggle.checked = settings.soundEffects !== false;
  antSel.value = String(settings.anticipationSec != null ? settings.anticipationSec : 10);

  function renderProfileTiles() {
    const cur = loadSettings();
    const unitsT = node.querySelector('#tile-units-val');
    if (unitsT) unitsT.textContent = cur.units === 'metric' ? 'KM · KG' : 'MI · LBS';
    const bodyT = node.querySelector('#tile-body-val');
    if (bodyT) {
      if (cur.bodyWeight) {
        const v = Math.round(Units.fromWeightInternal(cur.bodyWeight, cur.units));
        bodyT.textContent = v + ' ' + (cur.units === 'metric' ? 'KG' : 'LBS');
      } else {
        bodyT.textContent = 'Not set';
      }
    }
    const defPackT = node.querySelector('#tile-defpack-val');
    if (defPackT) {
      const v = Math.round(Units.fromWeightInternal(
        Units.toWeightInternal(cur.defaultPackWeight, cur.units), cur.units
      ));
      defPackT.textContent = cur.defaultPackWeight + ' ' + (cur.units === 'metric' ? 'KG' : 'LBS');
    }
    const apT = node.querySelector('#tile-autopause-val');
    if (apT) apT.textContent = cur.autoPause ? 'ON' : 'OFF';
    const coachT = node.querySelector('#tile-coaching2-val');
    if (coachT) {
      const v = cur.voiceCues || 'full';
      const ant = cur.anticipationSec != null ? cur.anticipationSec : 10;
      const labels = { off: 'No voice', minimal: 'Minimal voice', full: 'Full voice', verbose: 'Verbose voice' };
      coachT.textContent = labels[v] + ' · ' + (ant === 0 ? 'no warning' : ant + 's warning');
    }
    const storT = node.querySelector('#tile-storage-val');
    if (storT) {
      const count = Workouts.list().length;
      storT.textContent = count + ' workout' + (count === 1 ? '' : 's') + ' · local only';
    }
  }
  renderProfileTiles();

  function persist() {
    const u = unitsSel.value;
    const pack = parseFloat(packIn.value) || 0;
    const bw = parseFloat(bwIn.value);
    saveSettings({
      units: u,
      defaultPackWeight: pack,
      bodyWeight: isFinite(bw) && bw > 0 ? Units.toWeightInternal(bw, u) : null,
      autoPause: apToggle.checked,
      voiceCues: voiceSel.value,
      soundEffects: soundsToggle.checked,
      anticipationSec: parseInt(antSel.value, 10) || 0
    });
    applyUnits(node, u);
  }

  unitsSel.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Units updated', 'success'); });
  packIn.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Pack weight saved', 'success'); });
  bwIn.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Body weight saved', 'success'); });
  apToggle.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Auto-pause ' + (apToggle.checked ? 'on' : 'off'), 'success'); });
  voiceSel.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Voice cues: ' + voiceSel.value, 'success'); });
  soundsToggle.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Sound effects ' + (soundsToggle.checked ? 'on' : 'off'), 'success'); });
  antSel.addEventListener('change', () => { persist(); renderProfileTiles(); toast('Anticipation: ' + (antSel.value === '0' ? 'off' : antSel.value + 's'), 'success'); });

  // ===== STORAGE & BACKUP =====
  // Populate storage stats panel.
  async function refreshStorageStats() {
    const list = Workouts.list();
    const cntEl = node.querySelector('#storage-count');
    const sizeEl = node.querySelector('#storage-size');
    const persistEl = node.querySelector('#storage-persist');
    if (cntEl) cntEl.textContent = String(list.length);
    if (sizeEl) {
      try {
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('ruckops.')) {
            total += (localStorage.getItem(k) || '').length;
          }
        }
        const kb = (total / 1024).toFixed(1);
        sizeEl.textContent = kb + ' KB';
      } catch { sizeEl.textContent = '—'; }
    }
    if (persistEl) {
      try {
        if (navigator.storage && navigator.storage.persisted) {
          const p = await navigator.storage.persisted();
          persistEl.textContent = p ? 'GRANTED — survives eviction' : 'NOT GRANTED — request below';
          persistEl.style.color = p ? 'var(--olive)' : 'var(--muted)';
        } else {
          persistEl.textContent = 'Unsupported on this browser';
        }
      } catch { persistEl.textContent = 'Unknown'; }
    }
  }
  refreshStorageStats();

  // Wire storage sheet → request persistence
  const reqPersist = node.querySelector('#request-persist');
  if (reqPersist) {
    reqPersist.addEventListener('click', async () => {
      if (!navigator.storage || !navigator.storage.persist) {
        toast('Not supported on this browser', 'danger');
        return;
      }
      try {
        const granted = await navigator.storage.persist();
        if (granted) {
          toast('Persistent storage granted', 'success');
        } else {
          toast('Browser declined — your data is still stored, just may be evicted under low disk', 'danger');
        }
        refreshStorageStats();
      } catch {
        toast('Request failed', 'danger');
      }
    });
  }

  // Backup → download JSON of everything
  node.querySelector('#backup-json').addEventListener('click', () => {
    const payload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      app: 'RuckOps web MVP',
      settings: loadSettings(),
      workouts: Workouts.list(),
      onboarded: Storage.get(ONBOARD_KEY, false)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ruckops-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Backup downloaded', 'success');
  });

  // Restore → pick a JSON file, merge into local storage
  const restoreInput = node.querySelector('#restore-file');
  node.querySelector('#restore-json').addEventListener('click', () => restoreInput.click());
  restoreInput.addEventListener('change', async () => {
    if (!restoreInput.files || restoreInput.files.length === 0) return;
    const file = restoreInput.files[0];
    try {
      const txt = await file.text();
      const data = JSON.parse(txt);
      if (!data || !Array.isArray(data.workouts)) {
        toast('Not a valid RuckOps backup', 'danger');
        return;
      }
      const ok = await showConfirm({
        title: 'Restore from backup?',
        message: `This will merge ${data.workouts.length} workout${data.workouts.length === 1 ? '' : 's'} into your local data. Existing workouts with the same id will be overwritten. Settings will also be replaced.`,
        confirmLabel: 'RESTORE',
        cancelLabel: 'CANCEL'
      });
      if (!ok) return;
      // Merge workouts (dedupe by id)
      const existing = Workouts.list();
      const byId = new Map(existing.map(w => [w.id, w]));
      for (const w of data.workouts) byId.set(w.id, w);
      Storage.set(WORKOUTS_KEY, [...byId.values()]);
      if (data.settings) Storage.set(SETTINGS_KEY, data.settings);
      if (data.onboarded != null) Storage.set(ONBOARD_KEY, !!data.onboarded);
      toast('Restored ' + data.workouts.length + ' workout(s)', 'success');
      refreshStorageStats();
      renderProfileTiles();
    } catch (e) {
      console.error(e);
      toast('Restore failed: ' + (e.message || 'invalid file'), 'danger');
    } finally {
      restoreInput.value = '';
    }
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

  // Force update: unregister the service worker + clear caches, then
  // reload bypassing the SW. The next load fetches everything fresh.
  // Workout history and settings are preserved (they live in localStorage,
  // not in the SW cache).
  node.querySelector('#force-update').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Force update?',
      message: 'Clears the cached app shell and reloads to fetch the latest version. Your workout history and settings stay intact.',
      confirmLabel: 'UPDATE',
      cancelLabel: 'CANCEL'
    });
    if (!ok) return;
    toast('Updating…', 'info');
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) {
      console.error('force-update cleanup failed', e);
    }
    // Hard reload: add cache-buster + use location.reload(true) for older browsers.
    setTimeout(() => {
      const url = new URL(location.href);
      url.searchParams.set('_t', Date.now());
      location.replace(url.toString());
    }, 400);
  });

  node.querySelector('#about-link').addEventListener('click', (e) => {
    e.preventDefault();
    alert('RuckOps web MVP v0.1\n\nForeground GPS tracking. Local-only data. No account, no cloud.\n\nSee README on GitHub for the full project plan and v2 roadmap.');
  });
}

// -- Service worker registration ---------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // Check for updates on each load. If a new SW is found, install it
      // in the background. When it takes control (controllerchange), reload
      // once so the user gets the latest UI.
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // A newer SW has installed and an old one was controlling the
            // page. Tell the new one to take over.
            newWorker.postMessage('SKIP_WAITING');
          }
        });
      });
      // Reload once when the new SW takes control.
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    }).catch(() => {});
  });
}

// -- Boot ---------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) {
    location.hash = Storage.get(ONBOARD_KEY, false) ? '#/home' : '#/welcome';
  } else {
    handleRoute();
  }
  // Silently request persistent storage on first load. Browsers usually
  // grant this if the site has been visited a few times or installed as a
  // PWA. Worst case it returns false and our data is still saved in
  // localStorage (just may be evicted under disk pressure).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
});
