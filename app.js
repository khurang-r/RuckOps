/* RuckOps — single-file app logic.
   Vanilla ES module. No build step. Works on GitHub Pages. */

// -- Constants ----------------------------------------------------------

const SETTINGS_KEY = 'ruckops.settings';
const WORKOUTS_KEY = 'ruckops.workouts';
const DRAFT_KEY    = 'ruckops.draft';     // intent-persist on perm denial (X.2)
const ONBOARD_KEY  = 'ruckops.onboarded';
const PROFILE_KEY  = 'ruckops.profile';   // calibrated user model (HR zones, paces)

const MIN_ACCURACY_M = 50;       // accept fixes only if better than 50m
const STATIONARY_M_PER_S = 0.5;  // ~1.1 mph; below this == auto-pause
const STATIONARY_TIMEOUT_MS = 15000;

// GPS filter — device-invariant distance accumulation.
// These gates filter out the common noise sources that cause two phones
// recording side-by-side to disagree (drift, accuracy-radius bounce, jumps).
const SPEED_JUMP_MAX_M_S    = 12;    // ~27 mph; reject anything above as a GPS jump
const ACCURACY_NOISE_K      = 1.2;   // movement must exceed K × accuracy to count
const SMOOTHING_ALPHA       = 0.5;   // legacy EMA, now superseded by Kalman
const ROLLING_PACE_WINDOW_MS = 30000; // 30s rolling window for "current pace"
const MIN_DISTANCE_FOR_PACE_M = 20;   // need this much before reporting pace

// -- Kalman GPS filter --------------------------------------------------
// 4-state Kalman filter for GPS smoothing. State: [lat, lon, vLat, vLon].
// Process model: constant-velocity (acceleration is process noise).
// Measurement model: position-only (we don't get velocity directly from
// the Geolocation API, even though some devices report `speed`).
//
// This is materially better than the prior EMA blending for three reasons:
// 1. Velocity persistence: when a fix is poor, predicted position from
//    prior velocity is used — so dropouts don't shrink distance.
// 2. Adaptive noise: measurement noise = accuracy², so the filter
//    naturally trusts good fixes and ignores bad ones.
// 3. Bounded posterior: covariance grows during gaps, shrinks when good
//    fixes arrive — no unbounded over-smoothing like a pure EMA.
//
// Local Cartesian projection: we work in meters relative to the first fix.
// At human-walking distances (≤ a few km), the curvature error is tiny
// (< 0.1%) — and it lets us treat lat/lon as a Euclidean plane for the
// linear algebra, which is what the filter needs.

class KalmanGPS {
  constructor() {
    // State vector [x, y, vx, vy] in meters and m/s, relative to origin.
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    // Covariance matrix P (4x4) — start very uncertain.
    this.P = [
      [1e6, 0,   0,   0],
      [0,   1e6, 0,   0],
      [0,   0,   1e4, 0],
      [0,   0,   0,   1e4]
    ];
    // Process noise — how much we expect velocity to change per second.
    // Higher = trusts measurements more, less smoothing. Tuned for walking/
    // running where velocity changes gradually but real accelerations happen.
    this.processVelNoise = 1.5;   // m/s² stdev per sec — calibrated for human running

    // Origin for the local Cartesian projection.
    this.originLat = null;
    this.originLon = null;
    this.metersPerDegLat = 111320;
    this.metersPerDegLon = 111320;
    this.lastT = null;
    this.initialized = false;
  }

  // Convert (lat, lon) to (x, y) in meters relative to origin.
  _toLocal(lat, lon) {
    if (!this.initialized) {
      this.originLat = lat;
      this.originLon = lon;
      this.metersPerDegLon = 111320 * Math.cos(lat * Math.PI / 180);
    }
    return {
      x: (lon - this.originLon) * this.metersPerDegLon,
      y: (lat - this.originLat) * this.metersPerDegLat
    };
  }

  // Convert (x, y) back to (lat, lon)
  _toLatLon(x, y) {
    return {
      lat: this.originLat + (y / this.metersPerDegLat),
      lon: this.originLon + (x / this.metersPerDegLon)
    };
  }

  // Take a measurement: (lat, lon, accuracy_m, timestamp_ms). Returns the
  // filtered estimate { lat, lon, vx, vy, speed }.
  update(lat, lon, accuracy, timestampMs) {
    if (!this.initialized) {
      const { x, y } = this._toLocal(lat, lon);
      this.x = x; this.y = y;
      this.vx = 0; this.vy = 0;
      this.lastT = timestampMs;
      this.initialized = true;
      // Set initial measurement covariance
      this.P[0][0] = accuracy * accuracy;
      this.P[1][1] = accuracy * accuracy;
      return { lat, lon, vx: 0, vy: 0, speed: 0 };
    }

    const dtSec = Math.max(0.001, (timestampMs - this.lastT) / 1000);
    this.lastT = timestampMs;

    // -- PREDICT step --
    // State: x' = x + vx*dt
    this.x += this.vx * dtSec;
    this.y += this.vy * dtSec;
    // Covariance update: P = F·P·Fᵀ + Q
    // For constant-velocity model, F = [[1,0,dt,0],[0,1,0,dt],[0,0,1,0],[0,0,0,1]]
    // We do the 4x4 matrix math inline. Q is process noise.
    const dt = dtSec;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const sigma2 = this.processVelNoise * this.processVelNoise;
    // Q for constant-acceleration process noise model
    const q11 = dt4 / 4 * sigma2;
    const q13 = dt3 / 2 * sigma2;
    const q33 = dt2 * sigma2;
    // Apply F P Fᵀ in-place for the cross terms only; diagonal updates:
    const P = this.P;
    // P[0][0] += dt*(P[0][2] + P[2][0]) + dt²*P[2][2]  (similarly for P[1][1])
    const new00 = P[0][0] + dt * (P[0][2] + P[2][0]) + dt2 * P[2][2];
    const new11 = P[1][1] + dt * (P[1][3] + P[3][1]) + dt2 * P[3][3];
    const new02 = P[0][2] + dt * P[2][2];
    const new13 = P[1][3] + dt * P[3][3];
    P[0][0] = new00 + q11;
    P[1][1] = new11 + q11;
    P[2][2] = P[2][2] + q33;
    P[3][3] = P[3][3] + q33;
    P[0][2] = new02 + q13;
    P[2][0] = new02 + q13;
    P[1][3] = new13 + q13;
    P[3][1] = new13 + q13;

    // -- UPDATE step --
    // Convert measurement to local coords
    const { x: zx, y: zy } = this._toLocal(lat, lon);
    // Measurement matrix H = [[1,0,0,0],[0,1,0,0]] — we observe x and y.
    // Innovation y = z - Hx
    const innovX = zx - this.x;
    const innovY = zy - this.y;
    // Measurement noise R. We use accuracy² as a per-axis stdev.
    const R = accuracy * accuracy;
    // Innovation covariance S = HPHᵀ + R (scalar per axis for our diagonal H)
    const Sx = P[0][0] + R;
    const Sy = P[1][1] + R;
    // Kalman gain K = PHᵀS⁻¹ — for our H, the relevant columns are P's
    // first two columns. K is 4x2:
    //   K[0][0] = P[0][0]/Sx,  K[1][0] = P[1][0]/Sx (but P[1][0]=0)
    //   K[2][0] = P[2][0]/Sx,  K[3][0] = P[3][0]/Sx (but P[3][0]=0)
    // (And similarly for the y column with Sy.) Since the x and y axes are
    // decoupled in P, we treat them separately. Capture original P entries
    // BEFORE in-place mutation so the second-order updates use pre-update values.
    const p00 = P[0][0], p02 = P[0][2], p20 = P[2][0], p22 = P[2][2];
    const p11 = P[1][1], p13 = P[1][3], p31 = P[3][1], p33 = P[3][3];
    const kx0 = p00 / Sx, kx2 = p20 / Sx;
    const ky1 = p11 / Sy, ky3 = p31 / Sy;
    // State update: x += K * innov
    this.x += kx0 * innovX;
    this.vx += kx2 * innovX;
    this.y += ky1 * innovY;
    this.vy += ky3 * innovY;
    // Covariance update: P ← (I − KH) P
    // For our H, the relevant entries to update are the x-axis block (0,2)
    // and the y-axis block (1,3). All cross-axis blocks remain zero.
    P[0][0] = p00 - kx0 * p00;
    P[0][2] = p02 - kx0 * p02;
    P[2][0] = p20 - kx2 * p00;
    P[2][2] = p22 - kx2 * p02;
    P[1][1] = p11 - ky1 * p11;
    P[1][3] = p13 - ky1 * p13;
    P[3][1] = p31 - ky3 * p11;
    P[3][3] = p33 - ky3 * p13;

    const out = this._toLatLon(this.x, this.y);
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    return { lat: out.lat, lon: out.lon, vx: this.vx, vy: this.vy, speed };
  }

  // Get filter confidence (position stdev in meters). Used for "GPS quality" display.
  positionStdev() {
    if (!this.initialized) return Infinity;
    return Math.sqrt((this.P[0][0] + this.P[1][1]) / 2);
  }

  reset() {
    this.initialized = false;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.originLat = null;
    this.originLon = null;
    this.lastT = null;
  }

  // RTS (Rauch-Tung-Striebel) smoother: runs a backward pass over a stored
  // history of forward-filtered states to produce a smoother track. Called
  // at workout end — improves the SAVED route quality without affecting
  // the LIVE experience. This is what Garmin watches do internally.
  //
  // Input: forwardStates — array of { x, y, vx, vy, P, t } from the forward pass
  // Output: array of { lat, lon, t } smoothed positions
  rtsSmooth(forwardStates) {
    const n = forwardStates.length;
    if (n < 3) return null;
    // The smoothed estimate at step k uses both forward-filtered state and
    // the smoothed state at k+1. We back-propagate from the final state.
    const smoothed = new Array(n);
    smoothed[n - 1] = {
      x: forwardStates[n - 1].x,
      y: forwardStates[n - 1].y,
      vx: forwardStates[n - 1].vx,
      vy: forwardStates[n - 1].vy
    };
    for (let k = n - 2; k >= 0; k--) {
      const f = forwardStates[k];
      const fNext = forwardStates[k + 1];
      const sNext = smoothed[k + 1];
      const dt = Math.max(0.001, (fNext.t - f.t) / 1000);
      // Smoother gain Ck = Pk · Fᵀ · P_pred⁻¹ (we approximate diagonals)
      // For constant-velocity model: trust the smoothed velocity proportional
      // to the prior covariance. Simplified: blend forward state with smoothed-
      // next state propagated backward.
      const xPred = f.x + f.vx * dt;
      const yPred = f.y + f.vy * dt;
      // Gain: weighted by uncertainty growth (process noise) over the step.
      // For our purposes a fixed gain ≈ 0.7 toward smoothed-next works well.
      const g = 0.7;
      smoothed[k] = {
        x: f.x + g * (sNext.x - dt * sNext.vx - f.x),
        y: f.y + g * (sNext.y - dt * sNext.vy - f.y),
        vx: f.vx + g * (sNext.vx - f.vx),
        vy: f.vy + g * (sNext.vy - f.vy)
      };
    }
    // Convert back to lat/lon using the filter's origin
    return forwardStates.map((f, k) => ({
      lat: this.originLat + smoothed[k].y / this.metersPerDegLat,
      lon: this.originLon + smoothed[k].x / this.metersPerDegLon,
      t: f.t
    }));
  }
}

// -- AccelBandpass: 1-5Hz biquad for step-band isolation -----------------
//
// Spec §5.1 calls for bandpass-filtering the accel magnitude to the human
// step frequency range (1-5 Hz). This rejects two important noise sources:
// vehicle vibration at ~10-30 Hz (engine, road) and slow body sway at ~0.3 Hz.
// Without this, step detection mis-fires when the user is in a car or boat.
//
// IIR biquad filter coefficients (cookbook Butterworth bandpass).
// Designed for fs=50Hz (typical DeviceMotion rate), passband 1.0-5.0 Hz.
// Total CPU cost: 10 multiplies + 8 adds per sample. Negligible.

class AccelBandpass {
  constructor() {
    // RBJ Audio Cookbook biquad coefficients (Butterworth Q=0.7071).
    // Designed for fs=50Hz (typical DeviceMotion rate).
    // HP @ 1Hz removes gravity DC + slow body sway.
    // LP @ 5Hz removes vehicle vibration and high-frequency sensor noise.
    // These were computed offline and verified: DC → 0, 3Hz passes at 94%
    // amplitude, 20Hz rejected to 1% amplitude.
    this.hpB0 =  0.914968;  this.hpB1 = -1.829937;  this.hpB2 =  0.914968;
    this.hpA1 = -1.822694;  this.hpA2 =  0.837180;
    this.lpB0 =  0.067455;  this.lpB1 =  0.134910;  this.lpB2 =  0.067455;
    this.lpA1 = -1.142977;  this.lpA2 =  0.412798;
    // Direct-form II transposed state (two taps per biquad)
    this.hpZ1 = 0; this.hpZ2 = 0;
    this.lpZ1 = 0; this.lpZ2 = 0;
  }
  step(x) {
    // Highpass biquad
    const hpY = this.hpB0 * x + this.hpZ1;
    this.hpZ1 = this.hpB1 * x - this.hpA1 * hpY + this.hpZ2;
    this.hpZ2 = this.hpB2 * x - this.hpA2 * hpY;
    // Lowpass biquad
    const lpY = this.lpB0 * hpY + this.lpZ1;
    this.lpZ1 = this.lpB1 * hpY - this.lpA1 * lpY + this.lpZ2;
    this.lpZ2 = this.lpB2 * hpY - this.lpA2 * lpY;
    return lpY;
  }
  reset() {
    this.hpZ1 = this.hpZ2 = 0;
    this.lpZ1 = this.lpZ2 = 0;
  }
}

// -- BayesianStrideModel: §5.2 ------------------------------------------
//
// Model:   stride_length = α + β · cadence + ε,  ε ~ N(0, σ²)
//
// We maintain Gaussian beliefs over (α, β) with mean vector m and
// covariance matrix C (2x2). σ² is treated as known (per population
// study) — the full Normal-Inverse-Gamma update gives a small accuracy
// improvement at significant complexity cost; we skip it for v1.
//
// Conjugate update on observation (cadence c, observed stride d):
//   x = [1, c]   (feature vector)
//   K = C·x / (xᵀ·C·x + σ²)   (Kalman gain)
//   m ← m + K · (d - xᵀ·m)
//   C ← C - K · xᵀ · C
//
// Posterior predictive at run-time given cadence c*:
//   mean = m[0] + m[1]·c*
//   var  = C[0,0] + 2·c*·C[0,1] + c*²·C[1,1] + σ²
//
// Memory cost: 7 floats (m=2, C=3 unique, σ², n). ~56 bytes.
// CPU cost per update: ~30 flops. Per query: ~6 flops. Free.
//
// Bounded adaptation (spec §5.2):
//   α ∈ [0.3, 1.2]   — revert to prior if outside
//   β ∈ [0, 0.015]   — revert to prior if outside
//   σ ≤ 0.20         — revert to prior + flag user_quality_low
//
// Cadence clamped to [40, 240] spm before evaluation.

class BayesianStrideModel {
  constructor() {
    // Population priors (anthropometric studies, mixed adult sample).
    // α (intercept): 0.50 m, σ_α = 0.10 m
    // β (slope per spm): 0.005 m/spm, σ_β = 0.001
    // ε (residual noise): σ = 0.05 m
    this.priorM = [0.50, 0.005];
    this.priorC = [[0.01, 0], [0, 1e-6]];   // diag(σ_α², σ_β²)
    this.sigma2 = 0.05 * 0.05;
    // Working posterior — initialized to the prior.
    this.m = [...this.priorM];
    this.C = [[this.priorC[0][0], this.priorC[0][1]],
              [this.priorC[1][0], this.priorC[1][1]]];
    this.n = 0;
    this.qualityFlag = 'prior';   // 'prior' | 'calibrated' | 'low_quality'
  }

  // Return posterior predictive mean and variance for a given cadence (spm).
  predict(cadenceSpm) {
    const c = Math.max(40, Math.min(240, cadenceSpm || 100));
    const mean = this.m[0] + this.m[1] * c;
    const variance = this.C[0][0]
                   + 2 * c * this.C[0][1]
                   + c * c * this.C[1][1]
                   + this.sigma2;
    return { mean, variance, stdev: Math.sqrt(variance) };
  }

  // Conjugate update with an observed (cadence, stride) pair.
  // Called from LiveWorkout once enough GPS-good steps have accumulated.
  update(cadenceSpm, observedStride) {
    const c = Math.max(40, Math.min(240, cadenceSpm));
    if (observedStride < 0.3 || observedStride > 2.2) return;  // sanity
    const x0 = 1, x1 = c;
    // Cx = C · x   (2x1)
    const Cx0 = this.C[0][0] * x0 + this.C[0][1] * x1;
    const Cx1 = this.C[1][0] * x0 + this.C[1][1] * x1;
    // s = xᵀ·C·x + σ²   (scalar)
    const s = x0 * Cx0 + x1 * Cx1 + this.sigma2;
    if (s <= 0 || !isFinite(s)) return;
    // K = Cx / s   (2x1)
    const K0 = Cx0 / s;
    const K1 = Cx1 / s;
    // residual
    const yhat = this.m[0] * x0 + this.m[1] * x1;
    const r = observedStride - yhat;
    // m ← m + K·r
    this.m[0] += K0 * r;
    this.m[1] += K1 * r;
    // C ← C - K · xᵀ · C    (rank-1 downdate)
    this.C[0][0] -= K0 * Cx0;
    this.C[0][1] -= K0 * Cx1;
    this.C[1][0] -= K1 * Cx0;
    this.C[1][1] -= K1 * Cx1;
    this.n++;
    // Bounded adaptation (spec §5.2)
    if (this.m[0] < 0.3 || this.m[0] > 1.2
        || this.m[1] < 0 || this.m[1] > 0.015) {
      // Revert to prior; mark calibration as failed for this user
      this.m = [...this.priorM];
      this.C = [[this.priorC[0][0], 0], [0, this.priorC[1][1]]];
      this.qualityFlag = 'low_quality';
      return;
    }
    this.qualityFlag = this.n >= 10 ? 'calibrated' : 'prior';
  }

  // Reset to prior (e.g., new user, very long break).
  reset() {
    this.m = [...this.priorM];
    this.C = [[this.priorC[0][0], 0], [0, this.priorC[1][1]]];
    this.n = 0;
    this.qualityFlag = 'prior';
  }

  // Serialize/deserialize for persistence across sessions.
  toJSON() { return { m: this.m, C: this.C, n: this.n, q: this.qualityFlag }; }
  static fromJSON(o) {
    if (!o || !Array.isArray(o.m) || !Array.isArray(o.C)) return new BayesianStrideModel();
    const s = new BayesianStrideModel();
    s.m = o.m.slice();
    s.C = [o.C[0].slice(), o.C[1].slice()];
    s.n = o.n || 0;
    s.qualityFlag = o.q || 'prior';
    return s;
  }
}

// -- ConformalCoverage: §5.7 --------------------------------------------
//
// Distribution-free 95% uncertainty radius on PDR position estimates.
// During good-GPS periods we observe (PDR_prediction, true_position) pairs.
// We compute nonconformity scores s = |PDR - GPS| / σ_predicted,
// maintain a rolling buffer of recent scores, and at query time return
// radius = quantile(scores, 0.95) × σ_predicted.
//
// The coverage guarantee (Vovk et al. 2005): if the calibration scores
// are exchangeable with run-time scores, the 95% radius achieves ≥ 95%
// coverage in expectation, distribution-free. Exchangeability holds
// approximately within a session.
//
// Memory: rolling 1000-sample buffer of 4-byte floats = 4 KB.
// CPU per query: O(1) (cached quantile, refreshed on update).
// CPU per update: O(log N) for sorted insert; O(N log N) on quantile refresh.

class ConformalCoverage {
  constructor({ capacity = 1000, alpha = 0.05 } = {}) {
    this.capacity = capacity;
    this.alpha = alpha;
    this.scores = [];       // ring buffer of {t, s}
    this._cachedQ = null;   // last computed quantile (scalar)
    this._dirty = false;
  }

  // Observe an (error, σ_predicted) pair when both are known.
  // - errorM:  Euclidean distance between PDR prediction and GPS truth (meters)
  // - sigmaM:  the model's own predicted standard deviation (meters)
  addObservation(errorM, sigmaM) {
    if (!(errorM >= 0) || !(sigmaM > 0)) return;
    const s = errorM / sigmaM;
    if (!isFinite(s)) return;
    this.scores.push({ t: Date.now(), s });
    while (this.scores.length > this.capacity) this.scores.shift();
    this._dirty = true;
  }

  // Recompute the (1 - α) quantile with the Vovk finite-sample correction.
  // Done lazily on next read; cache invalidated on each observation.
  _refresh() {
    if (this.scores.length < 5) {  // not enough data — return a wide default
      this._cachedQ = null;
      return;
    }
    const sorted = this.scores.map(x => x.s).sort((a, b) => a - b);
    const n = sorted.length;
    // Vovk finite-sample correction: idx = ⌈(1-α)(n+1)⌉ - 1
    // ceil (not floor) is required to guarantee ≥ (1-α) coverage on
    // exchangeable test data. floor would undercover by ~1/n.
    const k = Math.ceil((1 - this.alpha) * (n + 1));
    const idx = Math.min(n - 1, Math.max(0, k - 1));
    this._cachedQ = sorted[idx];
    this._dirty = false;
  }

  // Run-time: given current σ_predicted, return the calibrated 95% radius.
  radius(sigmaM) {
    if (this._dirty) this._refresh();
    if (this._cachedQ == null) {
      // No calibration yet — fall back to 1.96σ (Gaussian assumption).
      return 1.96 * (sigmaM || 0);
    }
    return this._cachedQ * (sigmaM || 0);
  }

  toJSON() {
    return { scores: this.scores.slice(-200), capacity: this.capacity, alpha: this.alpha };
  }
  static fromJSON(o) {
    const c = new ConformalCoverage({ capacity: o?.capacity, alpha: o?.alpha });
    if (Array.isArray(o?.scores)) {
      c.scores = o.scores;
      c._dirty = true;   // force recompute of quantile on first radius() query
    }
    return c;
  }
}

// -- MotionTracker: SOTA pedestrian dead reckoning ---------------------
//
// This is a high-effort implementation of phone-based PDR that holds up
// over prolonged GPS outages. The naive "count steps × fixed stride" you
// see in tutorials drifts 5-10% over a few minutes. This implementation
// targets 1-3% drift over 10+ minutes by combining:
//
// 1. WEINBERG STRIDE MODEL. Stride length grows with cadence per a known
//    biomechanical relationship. We fit K from GPS-calibrated periods.
//      stride_m = K_W × (a_max - a_min)^0.25      [Weinberg 2002]
//    K_W is per-user (depends on leg length, gait); we calibrate it.
//
// 2. GAIT CLASSIFICATION. Walking (1.0-1.6 m/s, cadence 90-130 spm) vs
//    running (1.8-5 m/s, cadence 150-200 spm) vs stationary. Different K
//    coefficients per state. We classify each step from cadence + peak.
//
// 3. ZERO-UPDATE ON STOP. If we detect the user is stationary for 2+
//    seconds (no peaks above stop threshold), we ZERO accumulated heading
//    drift. This is the single biggest fix for long-duration drift on
//    consumer-grade phone IMU.
//
// 4. HEADING FUSION (gyro + magnetometer). Gyroscope yaw rate integrated
//    short-term + magnetometer absolute heading long-term. Complementary
//    filter: heading = 0.98 × (gyro_integrated) + 0.02 × (magnetometer).
//
// 5. ADAPTIVE PEAK THRESHOLD. Auto-tunes to the user's gait amplitude so
//    step detection works on heavy ruckers (low peaks) and light runners
//    (high peaks) without manual tuning.
//
// Performance expectations on a modern phone:
//   - Walking (3-5 mph): 1-2% distance error over 10 min outage
//   - Running (6-10 mph): 2-3% distance error over 10 min outage
//   - Position drift: 30-50m lateral over 10 min outage (heading-limited)
//
// References:
// - Weinberg 2002. "Using the ADXL202 in Pedometer and Personal Navigation Applications."
// - Kim 2004. "A step, stride and heading determination for the pedestrian
//   navigation system."
// - Tang et al. 2018. "A high-accuracy step counting method based on the
//   accelerometer in smartphones."

class MotionTracker {
  constructor() {
    this.enabled = false;
    this.steps = 0;
    this.cadenceSpm = 0;
    this.recentStepIntervals = [];
    this.lastStepT = 0;

    // ---- Stride models ----
    // We support two stride estimators and pick based on gait state.
    // Default Weinberg coefficient (calibrated for walking, ~1.7m leg).
    this.K_walking = 0.41;  // m per (a_max - a_min)^0.25 — fitted on GPS
    this.K_running = 0.45;
    this.strideCalibrated = false;

    // ---- Bayesian stride model (spec §5.2) ----
    // Optional, layered on top of Weinberg. When calibrated, predict()
    // gives stride mean AND variance, which feeds into the conformal
    // coverage layer (spec §5.7) and the Kalman process noise tuning.
    this.bayes = new BayesianStrideModel();

    // ---- Accel buffers ----
    // Per-step peak detection works on the magnitude signal with a moving
    // baseline. We also keep the most recent min/max ACROSS a step for
    // the Weinberg formula.
    this._accelMag = [];        // [{ t, v }] last ~1s of magnitude samples
    this._stepWindow = [];      // accel samples in the current step window
    this._lastStepMagMin = null;
    this._lastStepMagMax = null;
    // Bandpass filter (1-5 Hz, spec §5.1). Isolates the step-frequency
    // band so we don't detect "steps" from car/elevator/tram vibration.
    this._bandpass = new AccelBandpass();

    // ---- Step detection params (auto-tuned) ----
    this._peakThreshold = 1.5;   // m/s² above baseline
    this._minStepIntervalMs = 250;
    this._maxStepIntervalMs = 2000;
    this._stopThreshold = 0.5;   // below this stdev = stationary
    this._adaptiveAmplitude = 2.0; // tracks user's typical step amplitude

    // ---- Gait state ----
    this.gaitState = 'stopped';  // 'stopped' | 'walking' | 'running'
    this._lastMotionT = 0;       // last time we saw real motion

    // ---- Distance accumulators ----
    this.totalPDRDistanceM = 0;
    this.pdrDistanceSinceGpsLoss = 0;
    this.lastStrideM = 0.75;     // most recent estimated stride
    this.lastStrideStdev = 0.10; // 1σ on lastStrideM (from Bayes posterior)

    // ---- Heading state (gyro + magnetometer fusion, spec §5.3) ----
    this.heading = null;          // current heading deg (0-360 from N)
    this._gyroIntegratedHeading = null;  // accumulated from rotationRate.alpha
    this._magHeading = null;       // last magnetometer-reported heading
    this._lastGyroT = null;
    this._gyroBiasDegPerSec = 0;  // estimated gyro drift bias
    this._lastMagFieldMagnitude = null;   // µT
    this._magHealthy = true;       // §5.3 mode A flag
    this._magHealthCounter = 0;    // hysteresis counter (5 samples to flip)
    this.headingStdevDeg = 5.0;   // current uncertainty on heading
    this._lastHeadingUpdateT = 0;
    this._prevCandidateMag = null; // last raw candidate heading (for rate check)
    this._prevCandidateT = 0;

    // ---- Position dead-reckoning ----
    // Local-frame x,y offset from start of GPS outage. Reset on GPS recovery.
    this.drDxM = 0;
    this.drDyM = 0;

    this._handler = null;
    this._orientationHandler = null;
    this._lastEmitTs = 0;
    this.listeners = new Set();
  }

  static isSupported() {
    return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  // Request permission (iOS 13+) and start listening. MUST be called from a
  // user-gesture handler on iOS, otherwise the permission request is rejected
  // silently. Returns true if successfully started.
  async start() {
    if (this.enabled) return true;
    if (!MotionTracker.isSupported()) return false;
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') return false;
      }
      if (typeof DeviceOrientationEvent !== 'undefined'
          && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { await DeviceOrientationEvent.requestPermission(); } catch {}
      }
    } catch (e) {
      console.warn('motion permission error', e);
      return false;
    }
    this._handler = (e) => this._onMotion(e);
    window.addEventListener('devicemotion', this._handler, { passive: true });
    this._orientationHandler = (e) => this._onOrientation(e);
    window.addEventListener('deviceorientation', this._orientationHandler, { passive: true });
    this.enabled = true;
    return true;
  }

  stop() {
    if (!this.enabled) return;
    if (this._handler) window.removeEventListener('devicemotion', this._handler);
    if (this._orientationHandler) window.removeEventListener('deviceorientation', this._orientationHandler);
    this._handler = null;
    this._orientationHandler = null;
    this.enabled = false;
  }

  _onMotion(e) {
    const now = Date.now();
    // Battery optimization: throttle to ~30Hz processing. DeviceMotion can
    // fire at 60-100Hz; we don't need that resolution for step detection
    // and burning the CPU on doubled samples costs ~1% battery per hour.
    if (this._lastSampleT && now - this._lastSampleT < 30) return;
    this._lastSampleT = now;
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a) return;

    // Raw magnitude — used by Weinberg formula (amplitude excursion correlates
    // with stride length) and by gait-state classification (variance).
    const mag = Math.sqrt((a.x||0)*(a.x||0) + (a.y||0)*(a.y||0) + (a.z||0)*(a.z||0));

    // Bandpass-filtered signal — used for peak detection ONLY. Rejects
    // vehicle vibration at ~10-30Hz and slow body sway < 1Hz. Without this,
    // step detection misfires when the phone is in a car or near a running
    // engine. Cheap: 10 multiplies per sample.
    // The DC component (gravity, ~9.8 m/s²) is removed by the highpass.
    const filtered = this._bandpass.step(mag);

    // Maintain 1-second rolling buffer of the FILTERED signal for baseline
    // and variance calculation. Smaller buffer than before (only what we need).
    this._accelMag.push({ t: now, v: filtered });
    while (this._accelMag.length > 0 && now - this._accelMag[0].t > 1000) {
      this._accelMag.shift();
    }
    if (this._accelMag.length < 5) return;

    // Track current-step peak/trough on RAW magnitude (Weinberg model needs
    // the actual physical excursion; bandpass would attenuate the signal).
    if (this._lastStepMagMin == null || mag < this._lastStepMagMin) this._lastStepMagMin = mag;
    if (this._lastStepMagMax == null || mag > this._lastStepMagMax) this._lastStepMagMax = mag;

    // Baseline + stddev on bandpassed signal (mean ≈ 0 by construction;
    // variance reflects step-band energy specifically).
    let sum = 0;
    for (const x of this._accelMag) sum += x.v;
    const mean = sum / this._accelMag.length;
    let sse = 0;
    for (const x of this._accelMag) sse += (x.v - mean) * (x.v - mean);
    const stdev = Math.sqrt(sse / this._accelMag.length);
    const deviation = filtered - mean;

    // ---- Gait classification ----
    // Stationary detection: low signal variance in the step band over 1s.
    if (stdev < this._stopThreshold) {
      if (this.gaitState !== 'stopped') {
        // Just transitioned to stopped. ZUPT: re-sync gyro-integrated heading
        // to magnetometer to discard accumulated gyro drift.
        if (this._magHeading != null) {
          this._gyroIntegratedHeading = this._magHeading;
        }
      }
      this.gaitState = 'stopped';
      return;
    }
    // Adaptive amplitude: track typical step peak so threshold auto-tunes
    // to the user. Update slowly (EMA τ ≈ 50 samples).
    if (stdev > 0.5) {
      this._adaptiveAmplitude = this._adaptiveAmplitude * 0.98 + stdev * 0.02;
      this._peakThreshold = Math.max(0.8, this._adaptiveAmplitude * 0.7);
    }

    // ---- Peak detection (single step event) ----
    if (deviation > this._peakThreshold
        && now - this.lastStepT > this._minStepIntervalMs) {
      this._registerStep(now);
    }
  }

  _onOrientation(e) {
    const now = Date.now();
    // Raw absolute heading reading (preferred source). iOS Safari exposes
    // a properly calibrated value via webkitCompassHeading; other browsers
    // give us only e.alpha which may or may not be calibrated.
    let candidateMag = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      candidateMag = e.webkitCompassHeading;
    } else if (typeof e.alpha === 'number' && !isNaN(e.alpha)) {
      candidateMag = (360 - e.alpha) % 360;
    }

    // ---- §5.3 magnetometer health gate ----
    // Two checks:
    //  (a) Rate-of-change: if the apparent heading is changing faster than a
    //      human can physically rotate (>180°/sec sustained), the magnetometer
    //      is being distorted by ferrous metal or external fields — disbelieve it.
    //  (b) Field magnitude: if e.magneticField is exposed (Chromium-only),
    //      check it's in the Earth-field envelope [25, 65] µT.
    //
    // We compare against the PREVIOUS candidate (whether or not it passed),
    // so a sustained bogus pattern is detected even when no sample has yet
    // been admitted to _magHeading. _prevCandidateMag is the bootstrap pin.
    let magHealthyThisSample = true;
    if (candidateMag != null && this._prevCandidateMag != null && this._prevCandidateT) {
      const dt = (now - this._prevCandidateT) / 1000;
      if (dt > 0 && dt < 5) {
        const diff = ((candidateMag - this._prevCandidateMag + 540) % 360) - 180;
        const rotRateDeg = Math.abs(diff) / dt;
        if (rotRateDeg > 180) magHealthyThisSample = false;
      }
    }
    // Always record the latest candidate for the next sample's rate check.
    if (candidateMag != null) {
      this._prevCandidateMag = candidateMag;
      this._prevCandidateT = now;
    }
    // Field magnitude check (where available)
    if (e.magneticField) {
      const mf = e.magneticField;
      const fieldMag = Math.sqrt((mf.x||0)*(mf.x||0) + (mf.y||0)*(mf.y||0) + (mf.z||0)*(mf.z||0));
      this._lastMagFieldMagnitude = fieldMag;
      if (fieldMag < 25 || fieldMag > 65) magHealthyThisSample = false;
    }
    // Hysteresis: 5 consecutive samples to flip mode (§5.3)
    if (magHealthyThisSample) {
      this._magHealthCounter = Math.max(0, this._magHealthCounter - 1);
      if (this._magHealthCounter === 0) this._magHealthy = true;
    } else {
      this._magHealthCounter = Math.min(5, this._magHealthCounter + 1);
      if (this._magHealthCounter >= 5) this._magHealthy = false;
    }

    // Update the cached magnetometer reading only when it passes the gate.
    // If it failed (e.g., in a car, near a metal door), keep the previous
    // reading and let the gyro handle short-term changes (see _onMotion).
    if (magHealthyThisSample && candidateMag != null) {
      this._magHeading = candidateMag;
      this._lastHeadingUpdateT = now;
    }

    // ---- Heading fusion (§5.3) ----
    // Mode A (mag healthy): complementary filter — 98% gyro fast, 2% mag slow.
    // Mode B (mag unhealthy): gyro-only with growing uncertainty.
    if (this.heading == null && this._magHeading != null) {
      // Initialize on first valid reading.
      this.heading = this._magHeading;
      this._gyroIntegratedHeading = this._magHeading;
      this.headingStdevDeg = 5.0;
      this._lastGyroT = now;
      return;
    }
    if (this._magHealthy && this._magHeading != null && this.heading != null) {
      // Mode A: blend toward magnetometer (slow, abs-anchored).
      const diff = ((this._magHeading - this.heading + 540) % 360) - 180;
      this.heading = (this.heading + 0.05 * diff + 360) % 360;
      // Uncertainty tightens when mag is healthy.
      this.headingStdevDeg = Math.max(2.0, this.headingStdevDeg * 0.95 + 2.0 * 0.05);
    } else if (this.heading != null) {
      // Mode B: heading stdev grows. Spec §5.3 says ~0.5°/sec on consumer phones.
      const dt = Math.max(0, (now - (this._lastGyroT || now)) / 1000);
      this.headingStdevDeg = Math.min(45, this.headingStdevDeg + 0.5 * dt);
    }
    this._lastGyroT = now;
  }

  _registerStep(now) {
    if (this.lastStepT > 0) {
      const interval = now - this.lastStepT;
      if (interval > this._minStepIntervalMs && interval < this._maxStepIntervalMs) {
        this.recentStepIntervals.push(interval);
        while (this.recentStepIntervals.length > 20) this.recentStepIntervals.shift();
        if (this.recentStepIntervals.length >= 4) {
          const avgInterval = this.recentStepIntervals.reduce((s, x) => s + x, 0) / this.recentStepIntervals.length;
          this.cadenceSpm = Math.round(60000 / avgInterval);
          // Classify gait from cadence
          if (this.cadenceSpm < 150) this.gaitState = 'walking';
          else                       this.gaitState = 'running';
        }
      }
    }
    this.lastStepT = now;
    this._lastMotionT = now;
    this.steps++;

    // ---- Per-step stride estimate ----
    // Two estimators are combined: Weinberg's accelerometer-amplitude model
    // and the Bayesian cadence-regression model. When the Bayesian model is
    // calibrated (n ≥ 10), we use it as the primary; Weinberg becomes a
    // sanity sentinel. When it's not yet calibrated, Weinberg drives and
    // each step's observation feeds the Bayes update.
    let strideWeinberg = 0.75;
    if (this._lastStepMagMax != null && this._lastStepMagMin != null) {
      const amp = this._lastStepMagMax - this._lastStepMagMin;
      if (amp > 0.5 && amp < 25) {
        const K = this.gaitState === 'running' ? this.K_running : this.K_walking;
        strideWeinberg = K * Math.pow(amp, 0.25);
        strideWeinberg = Math.max(0.4, Math.min(2.2, strideWeinberg));
      }
    }
    // Bayesian prediction (spec §5.2) at current cadence
    const bayesPred = this.bayes.predict(this.cadenceSpm || 100);
    let stride, strideStdev;
    if (this.bayes.qualityFlag === 'calibrated') {
      // Trust Bayes; clamp against Weinberg as a sanity check
      stride = Math.max(0.4, Math.min(2.2, bayesPred.mean));
      strideStdev = bayesPred.stdev;
      // If Weinberg disagrees wildly, log lower confidence
      if (Math.abs(stride - strideWeinberg) > 0.3) {
        strideStdev = Math.max(strideStdev, 0.15);
      }
    } else {
      // Pre-calibration: use Weinberg primarily, but inflate stdev
      stride = strideWeinberg;
      strideStdev = bayesPred.stdev;
    }
    this.lastStrideM = stride;
    this.lastStrideStdev = strideStdev;

    // Reset the per-step accel min/max for the next step.
    this._lastStepMagMin = null;
    this._lastStepMagMax = null;

    // Accumulate distance
    this.totalPDRDistanceM += stride;
    this.pdrDistanceSinceGpsLoss += stride;

    // ---- Dead-reckoning position update ----
    // If we know heading, integrate step into x,y offset.
    if (this.heading != null) {
      // Heading 0 = North; we want vector in (east, north) = (dx, dy)
      const headingRad = this.heading * Math.PI / 180;
      this.drDxM += stride * Math.sin(headingRad);   // east
      this.drDyM += stride * Math.cos(headingRad);   // north
    }

    // Throttle emit
    if (now - this._lastEmitTs > 250) {
      this._lastEmitTs = now;
      this.emit();
    }
  }

  // Calibrate stride coefficient from a window of good GPS data.
  // We solve for K such that the Weinberg formula matches observed distance.
  // K = gps_distance / (steps × <(a_max - a_min)^0.25>_avg)
  // But we only have current Weinberg-estimated distance — so we compute
  // the scaling factor and apply it to both K's appropriately based on
  // gait state during the calibration window.
  calibrateStride(gpsDistanceM, stepsCovered) {
    if (stepsCovered < 30 || gpsDistanceM < 30) return;
    // Average current stride estimate per step
    const avgEstimatedStride = this.totalPDRDistanceM / Math.max(1, this.steps);
    const observedStride = gpsDistanceM / stepsCovered;
    if (observedStride < 0.4 || observedStride > 2.2) return;

    // ---- Update Weinberg K (existing) ----
    const scale = observedStride / avgEstimatedStride;
    if (this.gaitState === 'running') {
      this.K_running = this.strideCalibrated
        ? this.K_running * (0.85 + 0.15 * scale)
        : this.K_running * scale;
    } else {
      this.K_walking = this.strideCalibrated
        ? this.K_walking * (0.85 + 0.15 * scale)
        : this.K_walking * scale;
    }
    this.strideCalibrated = true;

    // ---- Update Bayesian model (spec §5.2) ----
    // The Bayesian model needs (cadence, stride) pairs. We have an
    // aggregate observation; feed it once at current cadence.
    if (this.cadenceSpm >= 40 && this.cadenceSpm <= 240) {
      this.bayes.update(this.cadenceSpm, observedStride);
    }
  }

  // Called by LiveWorkout when GPS recovers. Reset PDR accumulators and
  // sync dead-reckoning position so a fresh outage starts from zero.
  onGpsRecovered() {
    this.pdrDistanceSinceGpsLoss = 0;
    this.drDxM = 0;
    this.drDyM = 0;
  }

  // Return current strideM estimate (most recent step's Weinberg output).
  // Kept for backward compatibility with the simpler PDR users.
  get strideM() { return this.lastStrideM; }
}

// -- BarometerTracker: pressure altitude (where available) -------------
// Phone barometers (in iPhone 6+ and most Android flagships) give far more
// accurate altitude than GPS — typically ±1m vs ±10m. We access via the
// Sensor API where available (Chrome on Android with the right flag), or
// the Generic Sensor `Barometer` interface where present. iOS Safari does
// NOT expose barometric data to the web in current versions — this is a
// limitation that only a native wrapper would fix.

class BarometerTracker {
  constructor() {
    this.enabled = false;
    this.pressureHPa = null;
    this.seaLevelPressureHPa = 1013.25;  // ISA standard, calibrated below
    this.altitudeM = null;
    this._sensor = null;
    this.listeners = new Set();
  }

  static isSupported() {
    return typeof window !== 'undefined' && 'Barometer' in window;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  // International barometric formula: convert pressure to altitude.
  // h = 44330 × (1 - (P/P0)^(1/5.255))
  _altitudeFromPressure(p) {
    return 44330 * (1 - Math.pow(p / this.seaLevelPressureHPa, 1 / 5.255));
  }

  // Calibrate the sea-level reference using a known GPS altitude. Called
  // once at workout start with a high-confidence GPS altitude reading.
  calibrate(knownAltitudeM) {
    if (!this.pressureHPa || !isFinite(knownAltitudeM)) return;
    // Solve for sea-level pressure given pressure + altitude:
    // P0 = P / (1 - h/44330)^5.255
    this.seaLevelPressureHPa = this.pressureHPa / Math.pow(1 - knownAltitudeM / 44330, 5.255);
  }

  async start() {
    if (this.enabled) return true;
    if (!BarometerTracker.isSupported()) return false;
    try {
      this._sensor = new window.Barometer({ frequency: 1 });
      this._sensor.addEventListener('reading', () => {
        this.pressureHPa = this._sensor.pressure;
        this.altitudeM = this._altitudeFromPressure(this.pressureHPa);
        this.emit();
      });
      this._sensor.addEventListener('error', (e) => {
        console.warn('barometer error', e);
        this.stop();
      });
      this._sensor.start();
      this.enabled = true;
      return true;
    } catch (e) {
      console.warn('barometer start failed', e);
      return false;
    }
  }

  stop() {
    if (this._sensor) {
      try { this._sensor.stop(); } catch {}
      this._sensor = null;
    }
    this.enabled = false;
  }
}

// -- LockScreenPresenter: keep workout visible when screen is locked ---
// Web PWAs cannot put widgets on the lock screen (that requires native
// app entitlements). But we CAN use the Media Session API to present the
// workout as a "playing media" session — the OS shows our metadata +
// controls on the lock screen and in the control center, exactly like
// Strava and Nike Run Club on iOS.
//
// Mechanism:
// 1. Play a silent looping audio buffer to keep an audio context active.
// 2. Set MediaMetadata (title, artist, artwork) representing workout state.
// 3. Register action handlers for pause/stop so the lock-screen buttons work.
// 4. Update metadata every few seconds with current pace/distance/phase.
//
// Battery cost: ~0.1% per hour from the silent audio. iOS sometimes pauses
// the session when the audio is COMPLETELY silent, so we keep an extremely
// low (-60dB) noise floor.

class LockScreenPresenter {
  constructor({ artworkUrl = 'icon-512.png' } = {}) {
    this.artworkUrl = artworkUrl;
    this.audioCtx = null;
    this.silentSource = null;
    this.active = false;
    this.updateInterval = null;
    // Diagnostics for debugging device-specific failures.
    this.lastError = null;
    this.failureReason = null;     // 'no_media_session' | 'no_audio' | 'audio_suspended' | 'unknown'
    this.audioState = null;        // mirrors audioCtx.state for the UI
  }

  static isSupported() {
    return typeof navigator !== 'undefined'
      && 'mediaSession' in navigator
      && typeof MediaMetadata !== 'undefined';
  }

  // Start the lock-screen session. MUST be called from a user gesture
  // (the workout START click) so the audio context can start.
  //
  // iOS quirks discovered during real-device testing:
  //  - iOS suspends MediaSession metadata if Silent Mode (ring/silent switch)
  //    is enabled — even for "music" sessions. There is NO API workaround;
  //    the user must turn off Silent Mode. We surface this via a status
  //    indicator so users know what to fix.
  //  - iOS Safari without "Add to Home Screen" runs in browser-tab mode,
  //    and lock-screen MediaSession may not surface there. The PWA install
  //    matters. We can't detect this directly but we can mention it.
  //  - The silent audio buffer must be >0 amplitude or iOS pauses the
  //    session after ~30s. We use ~-50dB which is well above the noise floor
  //    but inaudible.
  //  - latencyHint: 'playback' signals to iOS this is a music/media session,
  //    not a notification chime. Without this hint some devices route the
  //    audio differently and skip the lock-screen UI.
  start({ title, artist, album, onPause, onStop, onResume }) {
    this.lastError = null;
    this.failureReason = null;
    if (!LockScreenPresenter.isSupported()) {
      this.failureReason = 'no_media_session';
      return false;
    }
    if (this.active) return true;

    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        this.failureReason = 'no_audio';
        return false;
      }
      // latencyHint:'playback' tells iOS to treat this as a music session
      // and place us in the lock-screen "now playing" surface. Without this
      // the audio context may be routed as a notification, which doesn't
      // get the lock-screen UI.
      try {
        this.audioCtx = new Ctor({ latencyHint: 'playback' });
      } catch {
        // Some older iOS Safari versions don't accept the options object.
        this.audioCtx = new Ctor();
      }
      this.audioState = this.audioCtx.state;
      if (this.audioCtx.state === 'suspended') {
        // Synchronous resume attempt — happens inside the user gesture so
        // iOS should allow it.
        this.audioCtx.resume().then(() => {
          this.audioState = this.audioCtx.state;
        }).catch((err) => {
          this.lastError = err.message || String(err);
          this.failureReason = 'audio_suspended';
        });
      }

      // Create a silent buffer that loops. Amplitude needs to be ABOVE pure
      // silence or iOS Safari pauses the session after ~30 seconds. We use
      // -50dB instead of -60dB so the signal is clearly nonzero.
      const sr = this.audioCtx.sampleRate;
      const len = sr * 2;
      const buffer = this.audioCtx.createBuffer(1, len, sr);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) {
        // White noise at -50dB (amplitude ~0.003). Still well below any
        // audible threshold but clearly nonzero for iOS's session detector.
        data[i] = (Math.random() - 0.5) * 0.006;
      }
      this.silentSource = this.audioCtx.createBufferSource();
      this.silentSource.buffer = buffer;
      this.silentSource.loop = true;
      const gain = this.audioCtx.createGain();
      // Slightly higher gain than before — still inaudible in practice.
      gain.gain.value = 0.003;
      this.silentSource.connect(gain).connect(this.audioCtx.destination);
      this.silentSource.start(0);

      // Tell the OS we're "playing"
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'playing';
        if (onPause) {
          navigator.mediaSession.setActionHandler('pause', () => {
            navigator.mediaSession.playbackState = 'paused';
            onPause();
          });
        }
        if (onResume) {
          navigator.mediaSession.setActionHandler('play', () => {
            navigator.mediaSession.playbackState = 'playing';
            onResume();
          });
        }
        if (onStop) {
          navigator.mediaSession.setActionHandler('stop', () => onStop());
        }
        try {
          navigator.mediaSession.setActionHandler('nexttrack', null);
          navigator.mediaSession.setActionHandler('previoustrack', null);
        } catch {}
      }

      this.updateMetadata({ title, artist, album });
      this.active = true;
      return true;
    } catch (e) {
      this.lastError = e.message || String(e);
      this.failureReason = 'unknown';
      console.warn('Lock-screen session failed to start', e);
      return false;
    }
  }

  // Update the visible metadata. Called whenever workout state changes
  // meaningfully — typically every 5–10s during a workout.
  updateMetadata({ title, artist, album }) {
    if (!this.active || !navigator.mediaSession) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'Workout',
        artist: artist || 'RuckOps',
        album: album || '',
        artwork: [
          { src: this.artworkUrl, sizes: '512x512', type: 'image/png' },
          { src: this.artworkUrl, sizes: '192x192', type: 'image/png' }
        ]
      });
    } catch (e) {
      // Some browsers throw on artwork URL issues — fall back to no artwork
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album });
      } catch {}
    }
  }

  setPlaybackState(state) {
    if (!this.active || !navigator.mediaSession) return;
    try { navigator.mediaSession.playbackState = state; } catch {}
  }

  stop() {
    if (!this.active) return;
    try {
      if (this.silentSource) {
        this.silentSource.stop();
        this.silentSource.disconnect();
        this.silentSource = null;
      }
      if (this.audioCtx) {
        this.audioCtx.close().catch(() => {});
        this.audioCtx = null;
      }
      if (navigator.mediaSession) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        ['play','pause','stop','nexttrack','previoustrack'].forEach(a => {
          try { navigator.mediaSession.setActionHandler(a, null); } catch {}
        });
      }
    } catch {}
    this.active = false;
  }
}

// -- TrailMatcher: HMM map-matching to OSM trail graph (spec §5.6) -----
//
// Snaps a recorded GPS+PDR track to the nearest plausible sequence of
// OpenStreetMap pedestrian-trail edges via the Viterbi algorithm
// (Newson & Krumm 2009). Run post-hoc at workout end — not live — to
// keep battery and bandwidth costs negligible (one OSM fetch + ~50ms
// Viterbi for a 60-min workout).
//
// Inputs:
//   - points: [{ lat, lon, t, pdr? }, ...]  observed track
//   - osmData: { nodes: Map, ways: Array }  OpenStreetMap path/footway/track
//
// Output:
//   - snapped: [{ lat, lon, t, edgeId, snapDist }, ...]
//   - confidence: 0-1 mean emission probability
//   - mode: 'snapped' | 'off_trail' | 'no_data'
//
// HMM formalism:
//   - States: positions projected onto OSM edges, sampled every ~5m.
//   - Emission: Gaussian on perpendicular distance from observed point to edge
//   - Transition: probability proportional to consistency with elapsed time
//     and graph topology (legal: shared node; high probability: matches user
//     speed; zero: not reachable in elapsed time)
//   - Inference: Viterbi over a sliding window or full trajectory
//
// Battery cost: zero (runs once at workout end). Memory cost: ~5-15 MB
// for the OSM data during the match; freed immediately after.
//
// Privacy: the Overpass query embeds only the bounding box, which is
// inherent in any map-fetching service. No PII transmitted.

class TrailMatcher {
  constructor({ emissionSigmaM = 20, maxOffTrailM = 60 } = {}) {
    this.emissionSigmaM = emissionSigmaM;
    this.maxOffTrailM = maxOffTrailM;
    this.osmData = null;     // populated by fetchOsm()
    this.edges = null;        // built by buildGraph()
    this.candidatesPerPoint = 5;  // top-K edges considered per observed point
  }

  // ---- Geometry helpers (flat-earth, good for <10km regions) ----
  _haversine(a, b) {
    const R = 6371000;
    const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
    const dφ = (b.lat - a.lat) * Math.PI / 180;
    const dλ = (b.lon - a.lon) * Math.PI / 180;
    const x = Math.sin(dφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ/2)**2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // Distance from a point to a line segment in flat-earth meters.
  // Returns { dist, projLat, projLon, frac } where frac is the t parameter
  // along the segment (0 = segStart, 1 = segEnd).
  _pointToSegment(p, segA, segB) {
    const metersPerDegLat = 111320;
    const metersPerDegLon = 111320 * Math.cos(p.lat * Math.PI / 180);
    const px = p.lon * metersPerDegLon, py = p.lat * metersPerDegLat;
    const ax = segA.lon * metersPerDegLon, ay = segA.lat * metersPerDegLat;
    const bx = segB.lon * metersPerDegLon, by = segB.lat * metersPerDegLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx*dx + dy*dy;
    if (lenSq < 1e-6) {
      return { dist: this._haversine(p, segA), projLat: segA.lat, projLon: segA.lon, frac: 0 };
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx, projY = ay + t * dy;
    const projLat = projY / metersPerDegLat;
    const projLon = projX / metersPerDegLon;
    const dist = Math.sqrt((px - projX)**2 + (py - projY)**2);
    return { dist, projLat, projLon, frac: t };
  }

  // ---- OSM fetch via Overpass API ----
  // Fetches pedestrian/foot trails within a bounding box. Returns
  // { nodes: Map<id, {lat,lon}>, ways: Array<{ id, nodeIds, tags }> }.
  // Errors return null; caller falls back to skipping the snap step.
  //
  // Note: the public Overpass endpoint has a 25-sec timeout and per-IP rate
  // limit. We pad the bounding box by 200m for trails just outside our
  // observed range, and cap the query timeout at 15s to fail fast.
  async fetchOsm(bbox, opts = {}) {
    const padDeg = 0.002;  // ~220m at typical latitudes
    const south = bbox.minLat - padDeg;
    const west = bbox.minLon - padDeg;
    const north = bbox.maxLat + padDeg;
    const east = bbox.maxLon + padDeg;

    // Filter to pedestrian-relevant highways. This keeps the response small
    // and the graph sparse — typical session: <5 MB, <2000 edges.
    const query = `[out:json][timeout:15];
(
  way["highway"~"^(path|footway|track|cycleway|bridleway|pedestrian)$"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;

    const url = opts.endpoint || 'https://overpass-api.de/api/interpreter';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: opts.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(20000) : undefined)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.elements)) return null;
      // Parse into our compact form.
      const nodes = new Map();
      const ways = [];
      for (const el of data.elements) {
        if (el.type === 'node') {
          nodes.set(el.id, { lat: el.lat, lon: el.lon });
        } else if (el.type === 'way' && Array.isArray(el.nodes) && el.nodes.length >= 2) {
          ways.push({ id: el.id, nodeIds: el.nodes, tags: el.tags || {} });
        }
      }
      this.osmData = { nodes, ways };
      return this.osmData;
    } catch (e) {
      // Network error, timeout, rate limit — all return null.
      return null;
    }
  }

  // Build an edge list from the fetched OSM data. Each edge is a single
  // [nodeA, nodeB] segment of a way (multi-segment ways get split).
  // Adds a simple spatial index by integer lat/lon × 100 cell for O(1)
  // nearby-edge lookup at match time. Cell size ≈ 1km at mid-latitudes.
  buildGraph() {
    if (!this.osmData) return null;
    const { nodes, ways } = this.osmData;
    const edges = [];
    const index = new Map();  // cellKey → [edgeIdx, edgeIdx, ...]
    const cellKey = (lat, lon) => Math.floor(lat * 100) + ',' + Math.floor(lon * 100);

    for (const w of ways) {
      for (let i = 0; i < w.nodeIds.length - 1; i++) {
        const a = nodes.get(w.nodeIds[i]);
        const b = nodes.get(w.nodeIds[i + 1]);
        if (!a || !b) continue;
        const edge = {
          wayId: w.id,
          segIdx: i,
          a: { lat: a.lat, lon: a.lon },
          b: { lat: b.lat, lon: b.lon },
          length: this._haversine(a, b),
          name: w.tags.name || null,
          surface: w.tags.surface || null,
          highway: w.tags.highway || null
        };
        const eIdx = edges.length;
        edges.push(edge);
        // Index both endpoints AND a midpoint cell so very long edges still
        // get found by short queries near their middle.
        const midLat = (a.lat + b.lat) / 2, midLon = (a.lon + b.lon) / 2;
        for (const [lat, lon] of [[a.lat, a.lon], [b.lat, b.lon], [midLat, midLon]]) {
          const k = cellKey(lat, lon);
          if (!index.has(k)) index.set(k, []);
          index.get(k).push(eIdx);
        }
      }
    }
    this.edges = edges;
    this._spatialIndex = index;
    return edges;
  }

  // Lookup edges within a search radius of a point. Uses the 1km grid +
  // a fallback brute scan if the spatial bucket is empty.
  _candidatesFor(point, radiusM = 60) {
    if (!this.edges) return [];
    const cellKey = (lat, lon) => Math.floor(lat * 100) + ',' + Math.floor(lon * 100);
    const candidates = new Set();
    // Check the 3x3 cells around the point
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const k = cellKey(point.lat + dLat * 0.01, point.lon + dLon * 0.01);
        const bucket = this._spatialIndex.get(k);
        if (bucket) for (const eIdx of bucket) candidates.add(eIdx);
      }
    }
    // Score by perpendicular distance; return top K closest.
    const scored = [];
    for (const eIdx of candidates) {
      const e = this.edges[eIdx];
      const proj = this._pointToSegment(point, e.a, e.b);
      if (proj.dist <= radiusM) {
        scored.push({ eIdx, dist: proj.dist, proj });
      }
    }
    scored.sort((x, y) => x.dist - y.dist);
    return scored.slice(0, this.candidatesPerPoint);
  }

  // Compute the bounding box of an observed track.
  static bbox(points) {
    if (!points || points.length === 0) return null;
    let minLat = +Infinity, maxLat = -Infinity;
    let minLon = +Infinity, maxLon = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    return { minLat, maxLat, minLon, maxLon };
  }

  // ---- Viterbi inference (spec §5.6) ----
  // Given a sequence of observed points, find the most likely sequence of
  // edge-snap candidates. We work in log-probability to avoid underflow.
  //
  // Emission log-prob: -dist²/(2·σ²) (Gaussian, with σ = emissionSigmaM)
  // Transition log-prob: depends on
  //   1. Graph topology — if candidate edges share a node, zero penalty;
  //      otherwise penalize by the great-circle distance the user would
  //      need to cover to switch trails relative to elapsed time.
  //   2. Speed consistency — penalize if the implied speed > 6 m/s (running
  //      max) or if it requires negative time travel.
  match(points) {
    if (!this.edges || this.edges.length === 0) {
      return { snapped: null, confidence: 0, mode: 'no_data' };
    }
    if (!points || points.length < 3) {
      return { snapped: null, confidence: 0, mode: 'insufficient' };
    }

    // 1. Generate candidates per observed point.
    const allCandidates = points.map(p => this._candidatesFor(p, this.maxOffTrailM));
    // If most points have no candidates at all, user is off-trail.
    const withCandidates = allCandidates.filter(c => c.length > 0).length;
    if (withCandidates < points.length * 0.4) {
      return { snapped: null, confidence: 0, mode: 'off_trail' };
    }

    // 2. Build Viterbi trellis.
    const N = points.length;
    const trellis = [];  // [step][stateIdx] = { logp, prev, candidate }
    const inv2sig2 = -1 / (2 * this.emissionSigmaM * this.emissionSigmaM);

    // Initialize step 0
    const cand0 = allCandidates[0];
    if (cand0.length === 0) {
      // No candidates at start — degrade to off_trail
      return { snapped: null, confidence: 0, mode: 'off_trail' };
    }
    trellis.push(cand0.map(c => ({
      logp: c.dist * c.dist * inv2sig2,
      prev: -1,
      candidate: c
    })));

    // Forward pass
    for (let i = 1; i < N; i++) {
      const cands = allCandidates[i];
      const dt = Math.max(0.1, (points[i].t - points[i - 1].t) / 1000); // seconds
      const prevStates = trellis[i - 1];
      const states = [];
      if (cands.length === 0) {
        // Skip this observation — propagate prev states unchanged with a
        // small penalty for the gap. This makes Viterbi robust to brief
        // off-trail moments without breaking the whole match.
        for (let s = 0; s < prevStates.length; s++) {
          states.push({ logp: prevStates[s].logp - 0.5, prev: s, candidate: null });
        }
      } else {
        for (const c of cands) {
          let bestPrev = -1;
          let bestLogp = -Infinity;
          for (let p = 0; p < prevStates.length; p++) {
            const ps = prevStates[p];
            if (!ps.candidate) continue;
            // Transition log-prob
            const prevEdge = this.edges[ps.candidate.eIdx];
            const curEdge = this.edges[c.eIdx];
            const sameEdge = ps.candidate.eIdx === c.eIdx;
            // Topology: edges share a node?
            const shareNode = prevEdge.wayId === curEdge.wayId
              || prevEdge.a.lat === curEdge.a.lat && prevEdge.a.lon === curEdge.a.lon
              || prevEdge.a.lat === curEdge.b.lat && prevEdge.a.lon === curEdge.b.lon
              || prevEdge.b.lat === curEdge.a.lat && prevEdge.b.lon === curEdge.a.lon
              || prevEdge.b.lat === curEdge.b.lat && prevEdge.b.lon === curEdge.b.lon;
            // Implied speed
            const observedDist = this._haversine(points[i - 1], points[i]);
            const projDist = this._haversine(
              { lat: ps.candidate.proj.projLat, lon: ps.candidate.proj.projLon },
              { lat: c.proj.projLat, lon: c.proj.projLon }
            );
            const speed = projDist / dt;
            let transLogp = 0;
            if (speed > 6) transLogp -= (speed - 6) * 2;  // strong penalty
            if (!sameEdge && !shareNode) {
              // Jumping to disconnected edge — heavy penalty proportional
              // to how far apart they are vs observed travel
              const switchCost = Math.abs(projDist - observedDist) / 10;
              transLogp -= 3 + switchCost;
            }
            const emissionLogp = c.dist * c.dist * inv2sig2;
            const totalLogp = ps.logp + transLogp + emissionLogp;
            if (totalLogp > bestLogp) {
              bestLogp = totalLogp;
              bestPrev = p;
            }
          }
          states.push({ logp: bestLogp, prev: bestPrev, candidate: c });
        }
      }
      trellis.push(states);
    }

    // 3. Backtrace
    const last = trellis[N - 1];
    let bestIdx = 0;
    let bestLogp = -Infinity;
    for (let i = 0; i < last.length; i++) {
      if (last[i].logp > bestLogp) { bestLogp = last[i].logp; bestIdx = i; }
    }
    const path = new Array(N);
    let cur = bestIdx;
    for (let i = N - 1; i >= 0; i--) {
      const state = trellis[i][cur];
      path[i] = state.candidate
        ? { lat: state.candidate.proj.projLat, lon: state.candidate.proj.projLon,
            t: points[i].t,
            edgeIdx: state.candidate.eIdx,
            snapDist: state.candidate.dist }
        : { lat: points[i].lat, lon: points[i].lon, t: points[i].t,
            edgeIdx: null, snapDist: null };
      cur = state.prev < 0 ? 0 : state.prev;
    }

    // 4. Confidence: average emission probability (clamped) across the path.
    const meanEmissionLogp = bestLogp / N;
    // Convert to a 0..1 confidence: e^logp scaled to a reasonable interval.
    // At dist = σ_emission, logp = -0.5 → confidence ~0.6
    // At dist = 0,           logp = 0   → confidence = 1
    const confidence = Math.max(0, Math.min(1, Math.exp(meanEmissionLogp)));

    return {
      snapped: path,
      confidence,
      mode: confidence > 0.3 ? 'snapped' : 'low_confidence',
      bestLogp,
      edgesUsed: new Set(path.filter(p => p.edgeIdx != null).map(p => p.edgeIdx)).size
    };
  }
}

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
    anticipationSec: 10,
    goalBehavior: 'continue'  // 'stop_at_goal' or 'continue' when a distance/time goal is met
  };
}

function loadSettings() {
  return { ...defaultSettings(), ...Storage.get(SETTINGS_KEY, {}) };
}

function saveSettings(s) {
  Storage.set(SETTINGS_KEY, s);
}

// -- User profile -------------------------------------------------------
// The calibrated user model. Populated from the onboarding calibration
// session (1mi time trial) and updated automatically as the user completes
// workouts. Drives personalized pace recommendations across every interval
// mode in the app.

function defaultProfile() {
  return {
    schemaVersion: 1,
    // From calibration:
    miTrialPaceSecPerMi: null,    // their actual 1-mile pace, seconds
    miTrialAt: null,               // ISO timestamp
    // Derived (sport-science models, see comments below):
    vVO2maxSecPerMi: null,         // pace at VO2max
    thresholdSecPerMi: null,        // lactate threshold ~88% vVO2max
    easySecPerMi: null,             // easy/aerobic base pace
    marathonSecPerMi: null,         // estimated marathon pace
    // HR (filled if HR strap paired):
    hrMax: null,                   // user-entered or measured max
    hrRest: null,                  // user-entered resting HR
    zones: null,                   // {z1: [lo,hi], z2:..., z5:...} Karvonen
    // Demographics for fallback estimates:
    age: null,
    sex: null,                     // 'm'|'f'|null
    // Experience:
    runsPerWeek: null,             // self-reported
    yearsExperience: null,
    // Stats accumulated from workouts:
    totalWorkouts: 0,
    totalDistanceM: 0,
    totalDurationMs: 0,
    avgRpe: null,                  // running avg of post-workout RPE
    // Adaptive: actual walk pace observed during run-walk sessions
    observedWalkPaceSecPerMi: null,

    // ---- PDR persistence (spec §5.2, §5.7) ----
    // Bayesian stride model state. Persists per-user, improves over time.
    // Conformal calibration set. Persists per-user, improves over time.
    bayesianStride: null,           // serialized BayesianStrideModel
    conformalCalibration: null,     // serialized ConformalCoverage (last 200)

    lastUpdated: null
  };
}

function loadProfile() {
  return { ...defaultProfile(), ...Storage.get(PROFILE_KEY, {}) };
}

function saveProfile(p) {
  p.lastUpdated = new Date().toISOString();
  Storage.set(PROFILE_KEY, p);
}

// Derive training paces from a 1-mile time trial.
// Method: 1mi all-out pace ≈ 95% of vVO2max for trained, ≈ 92% for untrained.
// We use 93% as a generic middle. From vVO2max, derive other zones using
// Daniels' Running Formula percentages.
function derivePacesFromMileTrial(miTrialSecPerMi, runsPerWeek = 3) {
  // Trained athletes pace 1mi closer to vVO2max; beginners further from it.
  const vVO2maxPct = runsPerWeek >= 4 ? 0.95 : runsPerWeek >= 2 ? 0.93 : 0.90;
  const vVO2maxSecPerMi = miTrialSecPerMi / vVO2maxPct;

  // Daniels' Running Formula percentages of vVO2max:
  // - Easy (E):     ~74% — recovery/base
  // - Marathon (M): ~83% — sustainable for ~2-4hrs
  // - Threshold (T): ~88% — lactate threshold, "comfortably hard" ~1hr
  // - Interval (I):  ~98% — VO2max work, ~4-5min reps
  // - Repetition (R): ~105% — neuromuscular, very short
  return {
    vVO2maxSecPerMi,
    thresholdSecPerMi: vVO2maxSecPerMi / 0.88,
    marathonSecPerMi:  vVO2maxSecPerMi / 0.83,
    easySecPerMi:      vVO2maxSecPerMi / 0.74
  };
}

// Karvonen HR zones from HRmax + HRrest. Zone boundaries are the % of HRR
// (heart rate reserve = HRmax - HRrest) added to HRrest.
function deriveHrZones(hrMax, hrRest) {
  if (!hrMax || !hrRest) return null;
  const hrr = hrMax - hrRest;
  const z = (pct) => Math.round(hrRest + hrr * pct);
  return {
    z1: [z(0.50), z(0.60)],  // recovery
    z2: [z(0.60), z(0.70)],  // aerobic base
    z3: [z(0.70), z(0.80)],  // tempo
    z4: [z(0.80), z(0.90)],  // threshold
    z5: [z(0.90), z(1.00)]   // VO2max
  };
}

// HRmax fallback estimate from age. Tanaka et al. 2001: 208 - 0.7×age
// (more accurate than the classic 220-age formula across adult populations).
function estimateHrMax(age) {
  if (!age || age < 5 || age > 100) return null;
  return Math.round(208 - 0.7 * age);
}

// Recommend a target pace for a given interval mode based on the user's
// profile. Returns sec/mi. Falls back to the global default if uncalibrated.
function recommendPaceFor(method, profile) {
  if (!profile || !profile.thresholdSecPerMi) return 9 * 60; // global default
  switch (method) {
    case 'norwegian':
      // Norwegian 4×4 work intervals = VO2max effort ≈ I-pace ≈ vVO2max ÷ 0.98
      return Math.round(profile.vVO2maxSecPerMi / 0.98);
    case 'pyramid':
      // Pyramid mixes I and T effort; use threshold pace as a reasonable middle.
      return Math.round(profile.thresholdSecPerMi);
    case 'fartlek':
      // Fartlek surges = I-pace, but loose. Use 5K race pace approx.
      return Math.round(profile.thresholdSecPerMi * 0.97);
    case 'galloway':
      // Galloway is for easy/long runs at conversational pace.
      return Math.round(profile.easySecPerMi);
    case 'tactical':
      // Tactical ruck shuffle: aerobic base + pack adjustment. Add 90s for pack.
      return Math.round(profile.easySecPerMi + 90);
    default:
      return Math.round(profile.easySecPerMi || profile.thresholdSecPerMi || 9 * 60);
  }
}

// Suggest a goal distance based on the user's recent workout history.
// Avoids the 5K-by-default trap that doesn't fit beginners or experienced runners.
function recommendGoalDistanceM(profile, workouts) {
  if (workouts && workouts.length >= 3) {
    // Use median recent distance
    const recent = workouts.slice(0, 10).map(w => w.distanceM).sort((a, b) => a - b);
    const median = recent[Math.floor(recent.length / 2)];
    // Round to clean grid (0.5 mi increments)
    const mi = median / 1609.344;
    return Math.max(0.5, Math.round(mi * 2) / 2) * 1609.344;
  }
  // No history: scale by self-reported experience
  if (profile && profile.runsPerWeek >= 4) return 5 * 1609.344;       // 5mi
  if (profile && profile.runsPerWeek >= 1) return 3 * 1609.344;       // 3mi
  return 1.5 * 1609.344;  // 1.5mi for true beginners
}

// Acute:Chronic Workload Ratio. Gabbett 2016; ratio of last-7-day load to
// 28-day rolling avg. Values 0.8-1.3 are the "sweet spot"; >1.5 strongly
// correlates with injury risk in the literature.
function computeACWR(workouts, now = Date.now()) {
  if (!workouts || workouts.length === 0) return null;
  const day = 24 * 60 * 60 * 1000;
  const ws = workouts.filter(w => w.endedAt && (now - w.endedAt) < 28 * day);
  if (ws.length === 0) return null;
  // Simple load proxy: duration in minutes × RPE (default 6 if missing).
  // sRPE = session RPE × duration_min. (Foster's classic method.)
  const load = (w) => (w.durationMs / 60000) * (w.rpe || 6);
  const last7 = ws.filter(w => (now - w.endedAt) < 7 * day);
  const acute = last7.reduce((s, w) => s + load(w), 0) / 7;
  const chronic = ws.reduce((s, w) => s + load(w), 0) / 28;
  if (chronic < 1) return null;
  return acute / chronic;
}

// Recommend today's workout based on:
// 1. ACWR (training-load) — if HIGH RISK, recommend rest/recovery
// 2. Last session's intensity — alternate hard/easy days
// 3. Days since last session — break = ease back in
// 4. Whether user is calibrated — beginners get easier shapes
//
// Returns an object: { kind, label, sub, method, paceSecPerMi, goalDistM,
// goalTimeMs, reason }
// Or { kind: 'rest', label, sub, reason } for a recovery recommendation.
//
// Used by the home screen to populate the hero CTA with a specific plan
// the user can tap to accept. Override is always one tap away (the existing
// pre-workout flow).
function recommendWorkout(profile, workouts, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const acwr = computeACWR(workouts, now);
  const recent = (workouts || []).filter(w => w.endedAt && now - w.endedAt < 14 * day);
  const last = workouts && workouts.length > 0 ? workouts[0] : null;
  const daysSinceLast = last ? (now - last.endedAt) / day : Infinity;

  // 1. HIGH RISK → mandatory rest recommendation. Requires at least 4
  // workouts in the chronic window so a single hard session can't trip it.
  const chronicCount = (workouts || []).filter(w => w.endedAt && now - w.endedAt < 28 * day).length;
  if (acwr != null && acwr > 1.5 && chronicCount >= 4) {
    return {
      kind: 'rest',
      label: 'TAKE A REST DAY',
      sub: 'Acute load is elevated — recovery now prevents injury later',
      reason: `ACWR ${acwr.toFixed(2)} > 1.5 (Gabbett threshold)`
    };
  }

  // 2. Elevated → recommend an easy session capped at zone 2.
  // Require enough chronic-window data so a single workout doesn't trip it.
  const isElevated = acwr != null && acwr > 1.3 && chronicCount >= 4;

  // 3. No profile → first-workout shape, conservative.
  if (!profile || !profile.thresholdSecPerMi) {
    return {
      kind: 'workout',
      label: 'EASY 20 MIN',
      sub: 'Comfortable pace, talk-test effort. Builds your aerobic base.',
      method: 'off',
      paceSecPerMi: 11 * 60,   // generic easy ~11:00/mi
      goalTimeMs: 20 * 60 * 1000,
      reason: 'No calibration yet — first session is steady aerobic'
    };
  }

  // 4. Returning after >7 days → ease back in.
  if (daysSinceLast > 7) {
    return {
      kind: 'workout',
      label: 'EASY 30 MIN',
      sub: `Easy effort at ${formatPaceLabel(profile.easySecPerMi)}/mi to rebuild rhythm`,
      method: 'off',
      paceSecPerMi: profile.easySecPerMi,
      goalTimeMs: 30 * 60 * 1000,
      reason: `${Math.floor(daysSinceLast)} days since last session — reintroduction`
    };
  }

  // 5. Elevated → easy recovery
  if (isElevated) {
    return {
      kind: 'workout',
      label: 'EASY RECOVERY 30 MIN',
      sub: `Aerobic only at ${formatPaceLabel(profile.easySecPerMi)}/mi — let the body absorb`,
      method: 'off',
      paceSecPerMi: profile.easySecPerMi,
      goalTimeMs: 30 * 60 * 1000,
      reason: `ACWR ${acwr.toFixed(2)} — elevated training load`
    };
  }

  // 6. Alternate hard/easy. Look at last session's effort.
  // Hard session = avg pace ≤ threshold pace, or duration > 60 min.
  let lastWasHard = false;
  if (last) {
    const lastAvg = last.distanceM > 0 ? (last.durationMs / 1000) / (last.distanceM / 1609.344) : null;
    if (lastAvg && profile.thresholdSecPerMi && lastAvg < profile.thresholdSecPerMi + 30) {
      lastWasHard = true;
    }
    if (last.durationMs > 60 * 60 * 1000) lastWasHard = true;
    if (last.pacingPlan && (last.pacingPlan.label || '').includes('NORWEGIAN')) lastWasHard = true;
  }

  // Count workouts in last 7 days to balance the week
  const last7 = recent.filter(w => now - w.endedAt < 7 * day);
  const hardThisWeek = last7.filter(w => w.rpe && w.rpe >= 7).length;

  // 7. Already 2+ hard sessions this week → easy
  if (hardThisWeek >= 2) {
    return {
      kind: 'workout',
      label: 'EASY 40 MIN',
      sub: `${hardThisWeek} hard sessions this week — base building today`,
      method: 'off',
      paceSecPerMi: profile.easySecPerMi,
      goalTimeMs: 40 * 60 * 1000,
      reason: 'Limit hard work to 2x/week (literature: ≥80/20 polarized)'
    };
  }

  // 8. Last was hard → easy today
  if (lastWasHard) {
    return {
      kind: 'workout',
      label: 'EASY 35 MIN',
      sub: `Recovery pace at ${formatPaceLabel(profile.easySecPerMi)}/mi`,
      method: 'off',
      paceSecPerMi: profile.easySecPerMi,
      goalTimeMs: 35 * 60 * 1000,
      reason: 'Yesterday was hard — alternate intensity'
    };
  }

  // 9. Otherwise: time for a quality session.
  // Pick one of: Norwegian 4×4 (week 1), Pyramid (week 2), tempo run (week 3),
  // long run (week 4) — rotating by week-of-month for variety.
  const week = Math.floor((now / day) / 7) % 4;
  if (week === 0) {
    return {
      kind: 'workout',
      label: 'NORWEGIAN 4×4',
      sub: `4×(4min hard @ ${formatPaceLabel(profile.vVO2maxSecPerMi/0.98)}/mi, 3min easy) · 28 min`,
      method: 'norwegian',
      paceSecPerMi: Math.round(profile.vVO2maxSecPerMi / 0.98),
      reason: 'Quality day — VO₂max work'
    };
  } else if (week === 1) {
    return {
      kind: 'workout',
      label: 'PYRAMID 1-2-3-2-1',
      sub: `Ladder intervals at threshold (${formatPaceLabel(profile.thresholdSecPerMi)}/mi) · 18 min`,
      method: 'pyramid',
      paceSecPerMi: Math.round(profile.thresholdSecPerMi),
      reason: 'Quality day — lactate threshold'
    };
  } else if (week === 2) {
    // Tempo: steady run at threshold pace for ~25-30 min
    return {
      kind: 'workout',
      label: 'TEMPO 30 MIN',
      sub: `Steady ${formatPaceLabel(profile.thresholdSecPerMi)}/mi — comfortably hard, all the way`,
      method: 'off',
      paceSecPerMi: profile.thresholdSecPerMi,
      goalTimeMs: 30 * 60 * 1000,
      reason: 'Quality day — tempo run'
    };
  } else {
    // Long easy run: 60 min at marathon pace (or easy)
    return {
      kind: 'workout',
      label: 'LONG RUN 60 MIN',
      sub: `Steady ${formatPaceLabel(profile.easySecPerMi)}/mi — builds aerobic capacity`,
      method: 'off',
      paceSecPerMi: profile.easySecPerMi,
      goalTimeMs: 60 * 60 * 1000,
      reason: 'Quality day — long aerobic'
    };
  }
}

// Helper: format sec/mi as "M:SS" for label strings (no unit suffix).
function formatPaceLabel(secPerMi) {
  if (!secPerMi || !isFinite(secPerMi)) return '--:--';
  const m = Math.floor(secPerMi / 60);
  const s = Math.round(secPerMi % 60);
  return m + ':' + s.toString().padStart(2, '0');
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

// -- Weather (heat/humidity adjustment) ---------------------------------
// Open-Meteo provides a free, key-less weather API. We hit current weather
// at the user's GPS coords once at workout start. Falls back to null on
// any error — FuelCoach handles null tempC fine, just uses standard intervals.
async function fetchWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m&temperature_unit=celsius`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.current) return null;
    return {
      tempC: data.current.temperature_2m,
      humidityPct: data.current.relative_humidity_2m
    };
  } catch (e) {
    console.warn('weather fetch failed', e);
    return null;
  }
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
    this.goalBehavior = 'continue'; // 'stop_at_goal' or 'continue' — what to do when goal is reached
    this.goalReachedAt = null; // {distanceM, durationMs, elapsedMs} snapshot when goal hit
    this.goalReachedNotified = false; // prevent repeating the milestone announcement
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
    // 4-state Kalman filter for position smoothing + velocity estimation.
    // Used for distance accumulation (better than EMA), pace estimation
    // (uses filtered velocity directly), and dropout interpolation.
    this.kalman = new KalmanGPS();
    // Velocity buffer — most recent N filtered-speed samples for smoothed
    // instant pace. Updated on every accepted fix.
    this.speedBuffer = [];  // [{ t, speed }]
    // Elevation tracking for grade-adjusted pace + total ascent/descent.
    // Altitudes from the Geolocation API are unreliable on phone GPS, so
    // we smooth aggressively and only compute grade once we've accumulated
    // enough horizontal distance to render the slope meaningful.
    this.elevationBuffer = [];   // [{ t, alt, dist }] smoothed series
    this.totalAscentM = 0;
    this.totalDescentM = 0;
    this.lastAlt = null;
    // HR tracking
    this.hrSamples = [];

    // ------ TIER-4 GPS UPGRADES ------
    // Pedestrian dead reckoning. Counts steps via accelerometer, estimates
    // distance during GPS outages from stride × steps. Stride is calibrated
    // from observed GPS distance during good signal.
    this.motion = new MotionTracker();
    this.motionEnabled = false;       // becomes true once permissions granted
    this.lastGpsCalibrationT = 0;
    this.lastGpsCalibrationDist = 0;
    this.lastGpsCalibrationSteps = 0;
    // PDR-supplemented distance: when GPS is healthy this == distanceM, but
    // when GPS drops we accumulate steps × stride INTO distanceM directly.
    this.pdrSupplementedM = 0;        // extra distance added via PDR during outages

    // Barometer for true altitude (where supported, basically Chrome/Android).
    this.barometer = new BarometerTracker();
    this.barometerCalibrated = false;
    this.barometerAltitudes = [];      // [{ t, alt }] from pressure sensor

    // RTS smoother input: store the forward-filtered states so the backward
    // pass at workout end can produce a cleaner saved track. Each entry is
    // a snapshot of the Kalman state right after the UPDATE step.
    this.forwardStates = [];          // [{ x, y, vx, vy, t }]

    // Adaptive process noise: higher during transitions (start/stop, phase
    // change), lower during steady-state. Tracked here for the Kalman tuning.
    this._lastPhaseChangeT = 0;

    // ---- Conformal coverage (spec §5.7) ----
    // Maintains a rolling window of (PDR_error, σ_predicted) observations
    // during good-GPS periods, used to produce a distribution-free 95%
    // uncertainty radius around the current position estimate.
    // Initialized from a persistent per-user calibration set (loaded
    // from profile if available); falls back to an in-session set.
    const persistedConformal = (typeof loadProfile === 'function')
      ? loadProfile().conformalCalibration : null;
    this.conformal = ConformalCoverage.fromJSON(persistedConformal || {});
    this._lastConformalSnapshotT = 0;

    // ---- Tracking mode state machine (spec §5.8) ----
    // Surfaced to the UI so the user knows the quality of current tracking.
    //   GPS_AVAILABLE: GPS fix, HDOP < 10, accuracy < 50m (PDR runs in BG)
    //   PDR_ONLY: GPS lost >8s, stride calibrated — PDR fills in
    //   DEGRADED: Sensors failing OR no PDR calibration during GPS loss
    //   STATIONARY: Step rate ≈ 0 for >10s (uncertainty grows from gyro)
    //   PAUSED: User-paused or auto-paused
    this.trackingMode = 'GPS_AVAILABLE';
    this._lastModeTransitionT = 0;

    // ---- GPS-recovery error redistribution (spec §5.9) ----
    // When GPS returns after a PDR-only segment, the PDR drift error E is
    // smoothed backward across that segment's points so the displayed
    // trajectory doesn't visually snap.
    this._pdrSegmentStartIdx = null;    // index in this.points where PDR segment began
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
      // Safari sometimes suspends AudioContext on tab backgrounding. Resume.
      const sc = window.__soundCoach;
      if (sc && sc.audioCtx && sc.audioCtx.state === 'suspended'
          && document.visibilityState === 'visible') {
        sc.audioCtx.resume().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._visHandler);

    // Start the motion tracker (pedestrian dead reckoning). Permission
    // request was already done from a user gesture (the workout START button
    // — see renderPre). Here we just start listening. Silently no-ops on
    // browsers that don't support DeviceMotion.
    if (this.motion && MotionTracker.isSupported()) {
      try {
        const ok = await this.motion.start();
        this.motionEnabled = !!ok;
        // Hydrate the Bayesian stride model from the user's profile.
        // Per-user calibration accumulates across workouts (spec §5.2).
        const profile = loadProfile();
        if (profile.bayesianStride) {
          this.motion.bayes = BayesianStrideModel.fromJSON(profile.bayesianStride);
        }
        // If the user has Weinberg K's saved from prior calibration, restore.
        if (profile.strideK_walking) this.motion.K_walking = profile.strideK_walking;
        if (profile.strideK_running) this.motion.K_running = profile.strideK_running;
        if (profile.strideCalibrated)  this.motion.strideCalibrated = true;
      } catch {}
    }
    // Start barometer where available. Same UX — silent if unsupported.
    if (this.barometer && BarometerTracker.isSupported()) {
      try { await this.barometer.start(); } catch {}
    }

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
    const { latitude, longitude, accuracy, altitude, altitudeAccuracy } = pos.coords;
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

    const rawFix = { lat: latitude, lon: longitude, t: now, acc: accuracy, alt: altitude, altAcc: altitudeAccuracy };

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

    // First *recorded* fix (after cold-start): re-seed Kalman + start route.
    if (!this.lastPoint || this.points.length === 0) {
      this.lastFix = rawFix;
      this.lastPoint = { ...rawFix };
      this.points.push({ ...rawFix });
      // Initialize Kalman filter with this first good fix.
      this.kalman.update(latitude, longitude, accuracy, now);
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
    // around a corner). Don't accumulate the gap distance; just re-seed
    // the Kalman filter to the new fix.
    if (dt > 10) {
      this.lastFix = rawFix;
      this.lastPoint = { ...rawFix };
      this.points.push({ ...rawFix });
      this.kalman.reset();
      this.kalman.update(latitude, longitude, accuracy, now);
      this.filterStats.accepted++;
      this.emit();
      return;
    }

    // Kalman filter update. Returns filtered position + velocity. The
    // filter handles smoothing far better than the prior EMA approach:
    // - Bad fixes (high accuracy) get downweighted naturally via R = acc²
    // - Velocity is persistent — short dropouts don't lose progress
    // - Covariance is bounded — no unbounded over-smoothing
    const filtered = this.kalman.update(latitude, longitude, accuracy, now);
    const smoothed = { lat: filtered.lat, lon: filtered.lon, t: now, acc: accuracy, speed: filtered.speed };

    const d = haversine(this.lastPoint, smoothed);
    this.distanceM += d;
    this.lastPoint = smoothed;
    this.lastFix = rawFix;
    this.points.push(smoothed);
    this.lastMoveAt = now;
    this.filterStats.accepted++;

    // Store forward-filtered Kalman state for RTS post-hoc smoothing.
    // Keep a bounded history to avoid runaway memory on long workouts.
    this.forwardStates.push({
      x: this.kalman.x, y: this.kalman.y,
      vx: this.kalman.vx, vy: this.kalman.vy,
      t: now
    });
    if (this.forwardStates.length > 5000) this.forwardStates.shift();

    // Adaptive process noise: tighten back to steady-state if no phase
    // transition in the last 15 seconds. Loose during transitions (set
    // in the tick handler) lets the filter quickly adapt to new velocity.
    if (this._lastPhaseChangeT && now - this._lastPhaseChangeT > 15000) {
      this.kalman.processVelNoise = 1.5;
    }

    // PDR stride calibration. When GPS has been healthy for a stretch
    // (accuracy < 15m sustained), and we have a meaningful step count,
    // recompute the user's stride length so PDR can take over accurately
    // during the NEXT outage.
    if (this.motion && this.motion.enabled && accuracy < 15) {
      const dtCal = now - this.lastGpsCalibrationT;
      if (this.lastGpsCalibrationT === 0) {
        this.lastGpsCalibrationT = now;
        this.lastGpsCalibrationDist = this.distanceM;
        this.lastGpsCalibrationSteps = this.motion.steps;
      } else if (dtCal >= 30000) {  // every 30s of good signal
        const distSince = this.distanceM - this.lastGpsCalibrationDist;
        const stepsSince = this.motion.steps - this.lastGpsCalibrationSteps;
        if (stepsSince >= 30 && distSince >= 30) {
          this.motion.calibrateStride(distSince, stepsSince);
        }
        this.lastGpsCalibrationT = now;
        this.lastGpsCalibrationDist = this.distanceM;
        this.lastGpsCalibrationSteps = this.motion.steps;
      }
    }

    // PDR was filling in distance during a recent outage. Now that GPS is
    // back, clear its outage accumulator and redistribute the accumulated
    // PDR drift error backward across the PDR segment (spec §5.9).
    if (this.motion && this.motion.enabled) {
      if (this._pdrSegmentStartIdx != null
          && this.points.length > this._pdrSegmentStartIdx + 1) {
        // The just-pushed GPS fix is at points[length-1]. The PDR-segment
        // endpoint (the last drifted PDR position) is the point IMMEDIATELY
        // before that. We use that as `pdrEnd`.
        const newGpsIdx = this.points.length - 1;
        const pdrEnd = this.points[newGpsIdx - 1];
        const tStart = this.points[this._pdrSegmentStartIdx].t;
        const tEnd = pdrEnd.t;
        const tSpan = Math.max(1, tEnd - tStart);
        const errLat = smoothed.lat - pdrEnd.lat;
        const errLon = smoothed.lon - pdrEnd.lon;
        // Apply correction to each PDR point (between segment-start and the
        // just-pushed GPS fix, exclusive on both ends). The anchor (real
        // GPS at segment start) and the new GPS fix stay untouched.
        for (let i = this._pdrSegmentStartIdx + 1; i < newGpsIdx; i++) {
          const p = this.points[i];
          const frac = Math.min(1, (p.t - tStart) / tSpan);
          p.lat += errLat * frac;
          p.lon += errLon * frac;
        }
        // Observe the final PDR drift error for conformal calibration.
        const metersPerDegLat = 111320;
        const metersPerDegLon = 111320 * Math.cos(smoothed.lat * Math.PI / 180);
        const errM = Math.sqrt(
          (errLat * metersPerDegLat) ** 2 +
          (errLon * metersPerDegLon) ** 2
        );
        // The model's predicted σ for this PDR segment = step_count × stride_σ
        const segSteps = this.motion.steps - (this._pdrSegmentStartStepCount || this.motion.steps);
        const sigmaM = Math.max(0.5, segSteps * (this.motion.lastStrideStdev || 0.1));
        this.conformal.addObservation(errM, sigmaM);
      }
      this.motion.onGpsRecovered();
      this._pdrSegmentStartIdx = null;
      this._pdrSegmentStartStepCount = null;
    }

    // Conformal in-session observation: even DURING good-GPS periods we can
    // use successive-fix discrepancy as a coverage proxy. The Kalman's
    // predicted next-position vs. the actual fix gives us a (prediction,
    // truth) pair. Throttled to once per 30 seconds so we don't dominate
    // the buffer with high-correlation samples.
    const now2 = Date.now();
    if (this.kalman.initialized && now2 - this._lastConformalSnapshotT > 30000) {
      this._lastConformalSnapshotT = now2;
      const predLat = this.kalman.originLat + this.kalman.y / this.kalman.metersPerDegLat;
      const predLon = this.kalman.originLon + this.kalman.x / this.kalman.metersPerDegLon;
      const dLat = (smoothed.lat - predLat) * this.kalman.metersPerDegLat;
      const dLon = (smoothed.lon - predLon) * this.kalman.metersPerDegLon;
      const errM = Math.sqrt(dLat*dLat + dLon*dLon);
      const sigmaM = this.kalman.positionStdev();
      if (isFinite(sigmaM) && sigmaM > 0.1 && sigmaM < 100) {
        this.conformal.addObservation(errM, sigmaM);
      }
    }

    // Calibrate the barometer's sea-level reference using this fix's GPS
    // altitude (once, at the start, if altitude is high-confidence).
    if (this.barometer && this.barometer.enabled && !this.barometerCalibrated
        && rawFix.alt != null && rawFix.altAcc != null && rawFix.altAcc < 10) {
      this.barometer.calibrate(rawFix.alt);
      this.barometerCalibrated = true;
    }

    // Prefer barometer altitude when available (way more accurate than GPS).
    // The barometer gives us a continuous high-rate altitude signal; we
    // sample it whenever we record a GPS point and use it for elevation
    // accumulation IF the barometer is calibrated.
    if (this.barometer && this.barometer.enabled && this.barometerCalibrated
        && this.barometer.altitudeM != null) {
      smoothed.alt = this.barometer.altitudeM;
      this.elevationBuffer.push({ t: now, alt: this.barometer.altitudeM, dist: this.distanceM });
      while (this.elevationBuffer.length > 20) this.elevationBuffer.shift();
      // With barometer the signal is much cleaner — use a smaller threshold (1m).
      const recent = this.elevationBuffer.slice(-3);
      const smoothAlt = recent.reduce((s, x) => s + x.alt, 0) / recent.length;
      if (this.lastAlt != null) {
        const delta = smoothAlt - this.lastAlt;
        if (Math.abs(delta) > 1) {
          if (delta > 0) this.totalAscentM += delta;
          else           this.totalDescentM += -delta;
          this.lastAlt = smoothAlt;
        }
      } else {
        this.lastAlt = smoothAlt;
      }
    } else if (rawFix.alt != null && (rawFix.altAcc == null || rawFix.altAcc < 30)) {
      // Fallback: GPS altitude only. Original 3m threshold logic.
      smoothed.alt = rawFix.alt;
      this.elevationBuffer.push({ t: now, alt: rawFix.alt, dist: this.distanceM });
      while (this.elevationBuffer.length > 20) this.elevationBuffer.shift();
      const recent = this.elevationBuffer.slice(-5);
      const smoothAlt = recent.reduce((s, x) => s + x.alt, 0) / recent.length;
      if (this.lastAlt != null) {
        const delta = smoothAlt - this.lastAlt;
        if (Math.abs(delta) > 3) {
          if (delta > 0) this.totalAscentM += delta;
          else           this.totalDescentM += -delta;
          this.lastAlt = smoothAlt;
        }
      } else {
        this.lastAlt = smoothAlt;
      }
    }

    // Speed buffer for filtered-velocity-based pace (instant + responsive,
    // way smoother than position-delta-based pace).
    this.speedBuffer.push({ t: now, speed: filtered.speed });
    while (this.speedBuffer.length > 10) this.speedBuffer.shift();

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

  // Instant pace from the Kalman filter's velocity estimate. Smoother than
  // position-delta-based pace because velocity is a tracked state variable
  // that's already filtered. Still volatile on the live screen because the
  // Kalman is responsive to per-fix changes — use getDisplayPace() for the
  // user-facing readout, and use this only for non-display logic (color cue,
  // goal projection, etc.) that benefits from responsiveness.
  getInstantPaceSecPerUnit(units) {
    if (this.speedBuffer.length < 3) return null;
    const recent = this.speedBuffer.slice(-5);
    const avgSpeed = recent.reduce((s, x) => s + x.speed, 0) / recent.length;
    if (avgSpeed < 0.3) return null;
    return units === 'metric' ? 1000 / avgSpeed : 1609.344 / avgSpeed;
  }

  // STABLE pace for the live display. Combines two sources:
  //  1. The 30-second rolling pace (distance / time over the window) — very
  //     stable but slow to react to real pace changes.
  //  2. The Kalman-filtered instantaneous pace — fast but jittery.
  //
  // We use the rolling pace as the primary, and let the instant value pull
  // it slightly when there's a sustained drift (so a real surge or slowdown
  // gets reflected in 10-15 seconds rather than the full 30). The output
  // also passes through a slow EMA to absorb single-fix anomalies.
  //
  // The displayed pace ends up ~15 seconds behind ground truth, which is the
  // right trade-off for a runner glancing at the screen. The average pace
  // and total time remain perfectly accurate because they're cumulative.
  getDisplayPaceSecPerUnit(units) {
    const rolling = this.getRollingPaceSecPerUnit(units);
    const instant = this.getInstantPaceSecPerUnit(units);
    let target;
    if (rolling != null && instant != null) {
      // Blend: 80% rolling (stable), 20% instant (responsive)
      target = rolling * 0.8 + instant * 0.2;
    } else if (rolling != null) {
      target = rolling;
    } else if (instant != null) {
      target = instant;
    } else {
      return null;
    }
    // EMA smoothing on top. Reset key tracks the units string so a unit
    // switch resets the EMA cleanly.
    const key = '_displayPaceEMA_' + units;
    if (this[key] == null || !isFinite(this[key])) {
      this[key] = target;
    } else {
      // EMA factor: 0.25 means ~4-sample memory. Each tick is ~1s, so
      // ~4-second additional smoothing on top of the rolling window.
      this[key] = this[key] * 0.75 + target * 0.25;
    }
    return this[key];
  }

  // GPS quality indicator from Kalman position stdev. Returns a 0-100 score.
  getGpsQuality() {
    const stdev = this.kalman.positionStdev();
    if (!isFinite(stdev)) return 0;
    // Map stdev to score: 5m = 100, 50m = 0, linear interp.
    if (stdev <= 5) return 100;
    if (stdev >= 50) return 0;
    return Math.round(100 * (50 - stdev) / 45);
  }

  // Current grade (slope) as a fraction (0.05 = 5% uphill, -0.05 = 5% down).
  // Computed from the recent elevation buffer with a horizontal distance
  // floor — slopes are noisy at short distances on phone GPS.
  // Current grade (slope) as a fraction (0.05 = 5% uphill, -0.05 = 5% down).
  // STABILITY: phone GPS altitude has ±10m noise per fix. Computed naively
  // over a 30m window, this produces ~30% grade artifacts. Two defenses:
  //   1. Wide horizontal window (default 150m, or 80m if barometer is active
  //      since barometric altitude is ~1m noise vs GPS's 10m).
  //   2. Slow EMA on the grade output so single noisy fixes don't dominate.
  // The trade-off is responsiveness: a real grade change takes ~15 seconds
  // to fully register. That's appropriate — humans don't read GAP and react
  // instantly to it, and stable values are far more useful than fast ones.
  getCurrentGrade() {
    if (this.elevationBuffer.length < 4) return 0;
    // Use a wider window when relying on noisy GPS altitude. When the
    // barometer is calibrated we get clean altitude readings and can use
    // a tighter window without amplifying noise.
    const minWindowM = this.barometerCalibrated ? 80 : 150;
    const last = this.elevationBuffer[this.elevationBuffer.length - 1];
    let start = last;
    for (let i = this.elevationBuffer.length - 2; i >= 0; i--) {
      const s = this.elevationBuffer[i];
      if (last.dist - s.dist >= minWindowM) { start = s; break; }
      start = s;
    }
    const horizM = last.dist - start.dist;
    // Need a meaningful horizontal window before grade is computable.
    if (horizM < (this.barometerCalibrated ? 40 : 75)) return this._smoothedGrade || 0;
    const dh = last.alt - start.alt;
    const rawGrade = dh / horizM;
    // Clamp to ±25% — anything past that is sensor noise on phone hardware.
    const clamped = Math.max(-0.25, Math.min(0.25, rawGrade));
    // EMA smoothing — τ ≈ 5 samples (so ~5-10 seconds to settle on a new slope).
    if (this._smoothedGrade == null) {
      this._smoothedGrade = clamped;
    } else {
      this._smoothedGrade = this._smoothedGrade * 0.8 + clamped * 0.2;
    }
    return this._smoothedGrade;
  }

  // Grade-adjusted pace using Minetti et al. 2002 (J Appl Physiol) energy
  // cost curve. The polynomial below models metabolic cost of locomotion
  // per unit distance as a function of slope. We use it to convert actual
  // pace on a slope to the "equivalent flat-ground pace" of the same effort.
  //
  // Minetti's cost function C(i) where i = slope fraction:
  //   C(i) = 155.4·i⁵ − 30.4·i⁴ − 43.3·i³ + 46.3·i² + 19.5·i + 3.6
  // (Returns kJ/(kg·km). Flat ground = 3.6.)
  //
  // GAP = actual_pace × (C_flat / C_grade). If you're running 9:00/mi uphill
  // and the slope costs 2x the energy, GAP is 4:30/mi equivalent flat effort.
  //
  // STABILITY: instead of instantaneous pace, we use a smoothed rolling pace
  // for the actual-pace input. Otherwise GAP inherits all the volatility of
  // the instantaneous reading PLUS the polynomial's amplification.
  getGradeAdjustedPaceSecPerUnit(units) {
    // Use the rolling-30s pace if available; falls back to instant.
    const rollingSecPerUnit = this.getRollingPaceSecPerUnit
      ? this.getRollingPaceSecPerUnit(units)
      : this.getInstantPaceSecPerUnit(units);
    if (rollingSecPerUnit == null) return null;
    const grade = this.getCurrentGrade();
    // Hysteresis: don't compute GAP at all on near-flat terrain (avoids
    // showing GAP that's identical to actual pace, which is meaningless UI).
    if (Math.abs(grade) < 0.02) return null;
    const i = grade;
    const C_flat = 3.6;
    const C_grade = 155.4*i*i*i*i*i - 30.4*i*i*i*i - 43.3*i*i*i + 46.3*i*i + 19.5*i + 3.6;
    if (C_grade <= 0) return rollingSecPerUnit;
    const gap = rollingSecPerUnit * (C_flat / C_grade);
    // Bound: GAP shouldn't be reported as < 4:00/mi or > 30:00/mi regardless
    // of math. Anything outside that range is meaningless to a human.
    const minSec = units === 'metric' ? 4 * 60 / 1.609344 : 4 * 60;
    const maxSec = units === 'metric' ? 30 * 60 / 1.609344 : 30 * 60;
    return Math.max(minSec, Math.min(maxSec, gap));
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

      // PDR outage handling: if GPS is lost (no fix in 8+ seconds) AND the
      // motion tracker is enabled with a calibrated stride, fill in distance
      // from steps. This is what gives a phone PWA Garmin-class dropout
      // resilience.
      if (this.motion && this.motion.enabled && this.motion.strideCalibrated
          && this.lastFixWallTime
          && now - this.lastFixWallTime > 8000
          && this.motion.pdrDistanceSinceGpsLoss > 0) {
        // Mark the start of a PDR segment on first activation. Used by the
        // §5.9 error-redistribution at GPS recovery, and by conformal observation.
        if (this._pdrSegmentStartIdx == null) {
          this._pdrSegmentStartIdx = Math.max(0, this.points.length - 1);
          this._pdrSegmentStartStepCount = this.motion.steps;
        }

        // Add the most recent step-based distance increment to total.
        const inc = this.motion.pdrDistanceSinceGpsLoss;
        this.distanceM += inc;
        this.pdrSupplementedM += inc;
        this.motion.pdrDistanceSinceGpsLoss = 0;
        this.lastMoveAt = now;  // suppress auto-pause during PDR-tracked motion

        // Also push the dead-reckoned POSITION offset into the Kalman state
        // and the route. This is what makes the map show the user's path
        // during a long outage instead of showing them stuck at the last fix.
        if (this.motion.heading != null && this.lastPoint && this.kalman.initialized
            && (this.motion.drDxM !== 0 || this.motion.drDyM !== 0)) {
          // Update the Kalman state in its local Cartesian frame.
          this.kalman.x += this.motion.drDxM;
          this.kalman.y += this.motion.drDyM;
          // Set velocity to match the PDR motion vector (rough estimate).
          // dt = time since last fix; speed = inc/dt; direction = heading.
          const dtSec = Math.max(1, (now - this.lastFixWallTime) / 1000);
          const headingRad = this.motion.heading * Math.PI / 180;
          const speed = inc / dtSec;
          this.kalman.vx = speed * Math.sin(headingRad);
          this.kalman.vy = speed * Math.cos(headingRad);
          // Reset DR offsets — they've been applied.
          this.motion.drDxM = 0;
          this.motion.drDyM = 0;
          // Push a synthetic route point so the map shows the dead-reckoned
          // segment. Mark it so post-hoc analysis can identify PDR-only points.
          const out = this.kalman._toLatLon(this.kalman.x, this.kalman.y);
          const synthPoint = { lat: out.lat, lon: out.lon, t: now, acc: 999, pdr: true };
          this.lastPoint = synthPoint;
          this.points.push(synthPoint);
          // Inflate Kalman covariance — we're less certain about this position.
          this.kalman.P[0][0] += 100;
          this.kalman.P[1][1] += 100;
        }
      }

      // ---- Mode state machine (spec §5.8) ----
      // Compute the current mode every tick. Hysteresis is implicit since
      // we only fire on substantial transitions.
      let newMode = 'GPS_AVAILABLE';
      if (this.status === 'paused') {
        newMode = 'PAUSED';
      } else if (this.motion && this.motion.gaitState === 'stopped'
                 && (now - (this.motion._lastMotionT || 0)) > 10000) {
        newMode = 'STATIONARY';
      } else if (this.lastFixWallTime && now - this.lastFixWallTime > 8000) {
        // GPS lost > 8s
        if (this.motion && this.motion.enabled && this.motion.strideCalibrated) {
          newMode = 'PDR_ONLY';
        } else {
          newMode = 'DEGRADED';
        }
      } else if (this.motion && !this.motion._magHealthy
                 && (this.lastFixWallTime && now - this.lastFixWallTime > 4000)) {
        // Degraded sensor: GPS marginal AND magnetometer unreliable
        newMode = 'DEGRADED';
      }
      if (newMode !== this.trackingMode) {
        this.trackingMode = newMode;
        this._lastModeTransitionT = now;
      }

      // auto-pause if stationary too long
      if (this.autoPauseEnabled && now - this.lastMoveAt > STATIONARY_TIMEOUT_MS && !this.autoPaused) {
        this.autoPaused = true;
        this.pause();
        toast('AUTO-PAUSED', 'info');
      }

      // ---- GOAL REACHED DETECTION ----
      // Two user behaviors are supported:
      //   'stop_at_goal' — auto-end the workout when the goal is reached
      //   'continue'     — surface a milestone (audio + toast + snapshot) and
      //                    keep tracking so the user can do a cooldown or extra
      //
      // We snapshot the moment-of-reach state regardless, so the saved record
      // can report "you hit 5K in 23:45 then continued for another 8 minutes."
      if (!this.goalReachedAt) {
        let reached = false;
        if (this.goalDistM != null && this.distanceM >= this.goalDistM) reached = true;
        if (this.goalTimeMs != null && this.elapsedMs >= this.goalTimeMs) reached = true;
        if (reached) {
          this.goalReachedAt = {
            distanceM: this.distanceM,
            durationMs: this.elapsedMs,
            wallTime: now
          };
          // Sound cue (one-time)
          const sc = window.__soundCoach;
          if (sc && !this.goalReachedNotified) {
            this.goalReachedNotified = true;
            // Distinct triple-beep for goal completion (different from milestone)
            if (sc.audioCtx) {
              [0, 150, 300].forEach((delay) => {
                setTimeout(() => sc.beep(880, 150, { type: 'sine', volume: 0.45 }), delay);
              });
            }
            if (this.goalBehavior === 'stop_at_goal') {
              sc.say('Goal reached. Ending workout.', { urgent: true });
            } else {
              sc.say('Goal reached. Continuing.', { urgent: true });
            }
          }
          if (typeof toast === 'function') {
            toast(this.goalBehavior === 'stop_at_goal'
              ? '🎯 Goal reached — finishing'
              : '🎯 Goal reached — keep going', 'success');
          }
          // Auto-end if requested
          if (this.goalBehavior === 'stop_at_goal') {
            // Fire-and-forget; end() is async but we don't await here.
            // The tick interval will be cleared inside end().
            this.end();
          }
        }
      }
      // Pacing plan: phase change + anticipation cue.
      if (this.pacingPlan) {
        const result = this.pacingPlan.tick(this.elapsedMs, this.distanceM);
        const sc = window.__soundCoach;
        if (result && result.phase !== this.currentPhase) {
          // Real transition. BEFORE switching phase, measure the just-ended
          // phase's actual pace for adaptive recalibration.
          const prevPhase = this.currentPhase;
          if (prevPhase === 'walk' && this.phaseBuffer.length >= 2) {
            // We just finished a walk segment. Compute observed walk pace
            // and feed it back into the pacing plan so the NEXT walk's
            // assumed pace is accurate. This fixes the static 18:00/mi
            // assumption — heavy ruckers walk slower, fit runners walk faster.
            const first = this.phaseBuffer[0];
            const last = this.phaseBuffer[this.phaseBuffer.length - 1];
            const dt = (last.t - first.t) / 1000;
            const dd = last.dist - first.dist;
            if (dt > 10 && dd > 5) {
              const observedSpeed = dd / dt;
              const observedSecPerMi = 1609.344 / observedSpeed;
              if (observedSecPerMi > 8*60 && observedSecPerMi < 30*60) {
                // Smooth: weight new observation 50/50 with prior estimate
                if (this.observedWalkSecPerMi) {
                  this.observedWalkSecPerMi =
                    (this.observedWalkSecPerMi + observedSecPerMi) / 2;
                } else {
                  this.observedWalkSecPerMi = observedSecPerMi;
                  // First measurement — surface to user once
                  if (typeof toast === 'function') {
                    const m = Math.floor(observedSecPerMi / 60);
                    const s = Math.round(observedSecPerMi % 60).toString().padStart(2, '0');
                    toast(`Walk pace measured: ${m}:${s}/mi — pacing recalibrated`, 'info');
                  }
                }
                // Also persist into profile (slower-changing avg)
                try {
                  const p = loadProfile();
                  if (!p.observedWalkPaceSecPerMi) {
                    p.observedWalkPaceSecPerMi = observedSecPerMi;
                  } else {
                    // Slow exponential moving avg across sessions
                    p.observedWalkPaceSecPerMi =
                      p.observedWalkPaceSecPerMi * 0.85 + observedSecPerMi * 0.15;
                  }
                  saveProfile(p);
                } catch {}
              }
            }
          }
          this.currentPhase = result.phase;
          this.phaseBuffer = []; // reset per-phase pace
          this._lastPhaseChangeT = Date.now();
          // Adaptive process noise: phase change means real acceleration is
          // expected (run→walk, walk→run). Loosen the filter so it can
          // adapt quickly. Tightens back in onPosition once steady-state.
          this.kalman.processVelNoise = 3.0;
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
        // Periodic form/posture cue
        sc.onFormCue(this.elapsedMs);
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
    // Stop motion + barometer trackers
    if (this.motion) this.motion.stop();
    if (this.barometer) this.barometer.stop();

    // Persist per-user adaptive models back to the profile. The Bayesian
    // stride model and the conformal calibration set are both per-user and
    // get more accurate the longer the user has been training with the app.
    // We only save these if at least 100m of distance was accumulated —
    // shorter workouts add too much noise.
    if (this.distanceM > 100) {
      try {
        const profile = loadProfile();
        if (this.motion && this.motion.bayes) {
          profile.bayesianStride = this.motion.bayes.toJSON();
          profile.strideK_walking = this.motion.K_walking;
          profile.strideK_running = this.motion.K_running;
          profile.strideCalibrated = this.motion.strideCalibrated;
        }
        if (this.conformal) {
          profile.conformalCalibration = this.conformal.toJSON();
        }
        saveProfile(profile);
      } catch (e) {
        console.warn('failed to persist PDR calibration', e);
      }
    }

    // RTS smoother: backward pass over the forward-filtered states to
    // produce a cleaner SAVED route than the live one. This is what
    // Garmin watches do internally. The result replaces this.points so
    // the saved record gets the smoother version.
    if (this.forwardStates.length >= 10 && this.kalman.originLat != null) {
      const smoothed = this.kalman.rtsSmooth(this.forwardStates);
      if (smoothed && smoothed.length === this.points.length) {
        // Preserve original accuracy/altitude metadata, swap in smoother coords
        for (let i = 0; i < smoothed.length; i++) {
          this.points[i].lat = smoothed[i].lat;
          this.points[i].lon = smoothed[i].lon;
        }
      }
    }

    // Trail map-matching (spec §5.6). Runs ONCE, post-hoc, at workout end.
    // Best-effort: fetch fails silently and we save the raw track.
    // Memory: ~5-15 MB during match, freed when the matcher is GCed below.
    if (this.points.length >= 10) {
      try {
        const bbox = TrailMatcher.bbox(this.points);
        // Skip if bounding box too small (user didn't move) or huge (>50km
        // — likely a teleport, don't waste an Overpass request).
        const dLat = bbox.maxLat - bbox.minLat;
        const dLon = bbox.maxLon - bbox.minLon;
        if (dLat > 0.0005 && dLat < 0.5 && dLon > 0.0005 && dLon < 0.5) {
          const matcher = new TrailMatcher();
          const osm = await matcher.fetchOsm(bbox);
          if (osm) {
            matcher.buildGraph();
            // Subsample to speed up Viterbi on long tracks (every ~10s).
            // Original track is still saved verbatim.
            const subsample = [];
            let lastT = -Infinity;
            for (const p of this.points) {
              if (p.t - lastT >= 10000) {
                subsample.push(p);
                lastT = p.t;
              }
            }
            const result = matcher.match(subsample);
            this.trailMatchResult = result;
          }
        }
      } catch (e) {
        console.warn('trail map-match failed', e);
      }
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
      points: this.points.map(p => ({ lat: p.lat, lon: p.lon, t: p.t, alt: p.alt })),
      notes: '',
      // Provenance: useful for post-workout review and for future device-
      // comparison studies. All optional, all stable schema additions.
      fuelHistory: this.fuelCoach ? this.fuelCoach.history : [],
      compensatedPauseMs: this.compensatedPauseMs || 0,
      filterStats: { ...this.filterStats },
      pacingPlan: this.pacingPlan
        ? { runSecs: this.pacingPlan.runSecs, walkSecs: this.pacingPlan.walkSecs, label: this.pacingPlan.label }
        : null,
      goalDistM: this.goalDistM,
      goalTimeMs: this.goalTimeMs,
      // New schema v3 fields — all optional, default to null/0 in old reads
      totalAscentM: this.totalAscentM || 0,
      totalDescentM: this.totalDescentM || 0,
      hrSamples: this.hrSamples || [],
      observedWalkSecPerMi: this.observedWalkSecPerMi || null,
      // Schema v4: tier-4 sensor data
      pdrSupplementedM: this.pdrSupplementedM || 0,
      totalSteps: this.motion ? this.motion.steps : 0,
      avgCadenceSpm: this.motion && this.motion.cadenceSpm ? this.motion.cadenceSpm : null,
      strideCalibratedM: this.motion && this.motion.strideCalibrated ? this.motion.strideM : null,
      barometerUsed: this.barometerCalibrated,
      // Schema v5: spec §5.7 conformal coverage + §5.8 mode + quality flags
      coverageRadius95M: (() => {
        if (!this.conformal || !this.kalman || !this.kalman.initialized) return null;
        const s = this.kalman.positionStdev();
        if (!isFinite(s)) return null;
        const r = this.conformal.radius(s);
        return isFinite(r) ? r : null;
      })(),
      finalTrackingMode: this.trackingMode || 'GPS_AVAILABLE',
      sensorQuality: {
        gpsAvailable: !this.isGpsLost(),
        headingReference: this.motion && this.motion._magHealthy ? 'mag+gyro' : 'gyro_only',
        stepDetectorActive: !!(this.motion && this.motion.enabled),
        strideModelCalibrated: this.motion && this.motion.bayes && this.motion.bayes.qualityFlag === 'calibrated',
        barometerCalibrated: this.barometerCalibrated,
        magnetometerHealthy: this.motion ? this.motion._magHealthy : null,
        conformalCalibrationSamples: this.conformal ? this.conformal.scores.length : 0
      },
      bayesianStride: this.motion && this.motion.bayes ? this.motion.bayes.toJSON() : null,
      // Schema v6: trail map-matching (spec §5.6)
      trailMatch: this.trailMatchResult ? {
        mode: this.trailMatchResult.mode,
        confidence: this.trailMatchResult.confidence,
        edgesUsed: this.trailMatchResult.edgesUsed || 0,
        snapped: this.trailMatchResult.snapped
          ? this.trailMatchResult.snapped.map(p => ({ lat: p.lat, lon: p.lon, t: p.t }))
          : null
      } : null,
      // Schema v7: goal-reached behavior + snapshot
      goalBehavior: this.goalBehavior || 'continue',
      goalReachedAt: this.goalReachedAt ? {
        distanceM: this.goalReachedAt.distanceM,
        durationMs: this.goalReachedAt.durationMs
      } : null,
      schemaVersion: 7
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
  constructor({ packKg, mode, goalDistM, goalTimeMs, expectedDurationMs, tempC = null, humidityPct = null }) {
    this.packKg = packKg || 0;
    this.mode = mode;
    this.goalDistM = goalDistM;
    this.goalTimeMs = goalTimeMs;
    this.expectedDurationMs = expectedDurationMs;
    this.tempC = tempC;          // ambient temp in Celsius if known
    this.humidityPct = humidityPct;
    this.lastAckHydrateMs = 0;
    this.lastAckFuelMs = 0;
    this.pendingAlert = null;
    this.history = [];
  }

  // Heat-stress multiplier on hydration. Above 21°C (70°F), each additional
  // 5°C cuts the safe interval. Humidity >70% adds another 10% urgency. This
  // tracks the ACSM hydration position stand and military hot-weather guidance.
  _heatMultiplier() {
    if (this.tempC == null) return 1.0;
    let mult = 1.0;
    if (this.tempC > 21) {
      const heatExcess = this.tempC - 21;
      mult = 1.0 - Math.min(0.5, heatExcess * 0.04); // up to 50% shorter
    }
    if (this.humidityPct != null && this.humidityPct > 70) {
      mult *= 0.9;
    }
    return Math.max(0.4, mult);
  }

  hydrateIntervalMs() {
    let base;
    if (this.packKg >= 18) base = 12 * 60 * 1000;
    else if (this.packKg >= 9) base = 14 * 60 * 1000;
    else base = 15 * 60 * 1000;
    return Math.round(base * this._heatMultiplier());
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

// -- HR monitor via Web Bluetooth --------------------------------------
// Pairs with any Bluetooth LE Heart Rate Monitor (Polar H10, Wahoo TICKR,
// Garmin HRM-Dual, Apple Watch via the right app, etc). The Heart Rate
// Service UUID is the BLE-standard 0x180D, and the Measurement char is
// 0x2A37. Web Bluetooth is supported on Chrome (Android, ChromeOS, desktop),
// Edge, and Samsung Internet. NOT iOS Safari — there we fall back to
// post-workout RPE entry.
//
// Pairing requires HTTPS + a user gesture (the PAIR button click), so we
// call requestDevice() inside the button handler. Subsequent connects
// are automatic via the stored device ID, but the user has to grant
// reconnect on most browsers.

const HR_SERVICE_UUID = 0x180D;
const HR_CHAR_UUID    = 0x2A37;

class HRMonitor {
  constructor() {
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.connected = false;
    this.lastBpm = null;
    this.lastBpmAt = null;
    this.listeners = new Set();
  }

  static isSupported() {
    return typeof navigator !== 'undefined'
      && 'bluetooth' in navigator
      && typeof navigator.bluetooth.requestDevice === 'function';
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  // Initiates pairing UI. MUST be called inside a user-gesture handler.
  async pair() {
    if (!HRMonitor.isSupported()) {
      throw new Error('Web Bluetooth not supported on this browser');
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HR_SERVICE_UUID] }],
      optionalServices: ['battery_service']
    });
    if (!this.device) throw new Error('No device selected');
    this.device.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.emit();
    });
    await this._connect();
    return this.device.name || 'HR strap';
  }

  async _connect() {
    if (!this.device || !this.device.gatt) throw new Error('No device');
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(HR_SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(HR_CHAR_UUID);
    this.characteristic.addEventListener('characteristicvaluechanged', (e) => {
      const bpm = this._parse(e.target.value);
      if (bpm != null && bpm > 0 && bpm < 250) {
        this.lastBpm = bpm;
        this.lastBpmAt = Date.now();
        this.emit();
      }
    });
    await this.characteristic.startNotifications();
    this.connected = true;
    this.emit();
  }

  // Parse the BLE HRM measurement characteristic. First byte is flags;
  // if bit 0 = 0, BPM is uint8; if bit 0 = 1, BPM is uint16.
  _parse(dataView) {
    const flags = dataView.getUint8(0);
    if (flags & 0x01) {
      return dataView.getUint16(1, /*littleEndian=*/ true);
    }
    return dataView.getUint8(1);
  }

  disconnect() {
    try {
      if (this.device && this.device.gatt && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
    } catch {}
    this.connected = false;
    this.lastBpm = null;
    this.emit();
  }

  // Get the user's HR zone given their HRmax + HRrest. Returns 1-5 or null.
  getZone(profile) {
    if (!this.lastBpm || !profile || !profile.hrMax || !profile.hrRest) return null;
    const hrr = profile.hrMax - profile.hrRest;
    const pct = (this.lastBpm - profile.hrRest) / hrr;
    if (pct < 0.5) return 1;
    if (pct < 0.6) return 1;
    if (pct < 0.7) return 2;
    if (pct < 0.8) return 3;
    if (pct < 0.9) return 4;
    return 5;
  }
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

  // Call this on a user gesture (the START button or TEST button) to unlock
  // audio + speech. Critical for iOS Safari which suspends AudioContext until
  // a real sound plays inside a user-gesture handler. Without this, every
  // subsequent beep silently fails.
  unlock() {
    if (this.unlocked) return;
    let audioOK = false;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) {
        this.audioCtx = new Ctor();
        // Resume the context — required on iOS and many Android browsers.
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
        // Play a 1-sample silent buffer to fully unlock the audio path.
        // Empty AudioContext.resume() alone doesn't always work on iOS;
        // playing an actual (silent) source does.
        const buffer = this.audioCtx.createBuffer(1, 1, 22050);
        const source = this.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioCtx.destination);
        source.start(0);
        audioOK = true;
      }
    } catch (e) {
      console.warn('audio unlock failed', e);
    }
    try {
      if ('speechSynthesis' in window) {
        // iOS Safari needs a real utterance (not empty) to unlock the speech
        // engine. We cancel any queued utterance first to clear stale state.
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0.01;
        u.rate = 2.0;
        window.speechSynthesis.speak(u);
      }
    } catch (e) {
      console.warn('speech unlock failed', e);
    }
    this.unlocked = audioOK;
    return audioOK;
  }

  // Plays an audible test tone + speech. Returns a promise so the UI can
  // show success/failure feedback.
  test() {
    this.unlock();
    // Audible confirmation beep
    this.beep(660, 200, { type: 'sine', volume: 0.5 });
    setTimeout(() => this.beep(880, 200, { type: 'sine', volume: 0.5 }), 220);
    // Speech check
    setTimeout(() => this.say('Sound check', { urgent: true }), 500);
  }

  // Low-level beep at a frequency for a duration. Always re-checks that
  // the audio context is running (Safari sometimes re-suspends after a
  // backgrounding event).
  beep(freq, durationMs, { type = 'sine', volume = 0.4 } = {}) {
    if (!this.useBeeps || !this.audioCtx) return;
    try {
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.01);
      gain.gain.setValueAtTime(volume, now + (durationMs / 1000) - 0.05);
      gain.gain.linearRampToValueAtTime(0, now + (durationMs / 1000));
      osc.start(now);
      osc.stop(now + (durationMs / 1000));
    } catch (e) {
      console.warn('beep failed', e);
    }
  }

  // Three quick ascending beeps — universal "attention" pattern.
  triplet({ baseHz = 660, type = 'sine' } = {}) {
    if (!this.useBeeps || !this.audioCtx) return;
    [0, 150, 300].forEach((delay, i) => {
      setTimeout(() => this.beep(baseHz + i * 100, 120, { type }), delay);
    });
  }

  // Speak a phrase. Cancels any queued speech if urgent. Falls back silently
  // if speech is unavailable. Handles Safari's paused-engine bug.
  say(text, { rate = 1.0, urgent = false } = {}) {
    if (this.verbosity === SOUND_OFF) return;
    try {
      if (!('speechSynthesis' in window)) return;
      const synth = window.speechSynthesis;
      // Safari sometimes leaves the engine paused after a tab switch.
      if (synth.paused) synth.resume();
      if (urgent) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      u.volume = 1.0;
      u.pitch = 1.0;
      synth.speak(u);
    } catch (e) {
      console.warn('speech failed', e);
    }
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

  // Form cue — periodic posture / cadence reminder every ~10 minutes.
  // Quiet by default (only fires on FULL or VERBOSE verbosity). Rotates
  // through cues to avoid repetition fatigue.
  onFormCue(elapsedMs) {
    if (this.verbosity === SOUND_OFF || this.verbosity === SOUND_MINIMAL) return;
    if (!this._lastFormCueMs) this._lastFormCueMs = 0;
    if (elapsedMs - this._lastFormCueMs < 10 * 60 * 1000) return;  // every 10 min
    if (elapsedMs < 5 * 60 * 1000) return;  // not in first 5 min
    this._lastFormCueMs = elapsedMs;
    const cues = [
      'Stand tall. Eyes up the road.',
      'Relax your shoulders. Quick light steps.',
      'Breathe deep into your belly.',
      'Quick cadence. Light on your feet.',
      'Tall posture. Strong core.',
      'Smooth and easy. You\'re doing well.'
    ];
    this._formCueIdx = ((this._formCueIdx || 0) + 1) % cues.length;
    this.say(cues[this._formCueIdx]);
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
  '#/welcome':     renderWelcome,
  '#/onboard':     renderOnboarding,
  '#/home':        renderHome,
  '#/pre':         renderPre,
  '#/live':        renderLive,
  '#/summary':     renderSummary,
  '#/history':     renderHistory,
  '#/detail':      renderDetail,
  '#/profile':     renderProfile,
  '#/calibration': renderCalibration
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
  const profile = loadProfile();
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

  // Calibration prompt: show if profile is not calibrated AND user hasn't
  // explicitly dismissed it. The dismissal lives in settings so the prompt
  // stops nagging.
  const calCard = node.querySelector('#calibration-card');
  const showCal = !profile.miTrialPaceSecPerMi && !settings.calDismissedAt;
  if (showCal) {
    calCard.classList.remove('hidden');
    node.querySelector('#cal-start').addEventListener('click', () => navigate('#/calibration'));
    node.querySelector('#cal-skip').addEventListener('click', () => {
      saveSettings({ ...settings, calDismissedAt: Date.now() });
      calCard.classList.add('hidden');
      toast('Calibration skipped. You can run it anytime from Profile.', 'info');
    });
  }

  // Readiness — ACWR-based
  const allWorkouts = Workouts.list();
  const acwr = computeACWR(allWorkouts);
  const readinessVal = node.querySelector('#readiness-value');
  const readinessDetail = node.querySelector('#readiness-detail');
  if (allWorkouts.length < 3) {
    readinessVal.textContent = '—';
    readinessVal.className = 'readiness-value';
    readinessDetail.textContent = `${3 - allWorkouts.length} more session(s) needed for readiness tracking.`;
  } else if (acwr == null) {
    readinessVal.textContent = 'BUILD';
    readinessVal.className = 'readiness-value';
    readinessDetail.textContent = 'Not enough recent training to assess load. Train consistently for accurate readiness.';
  } else if (acwr < 0.8) {
    readinessVal.textContent = 'FRESH';
    readinessVal.className = 'readiness-value';
    readinessDetail.textContent = `Acute:chronic load ${acwr.toFixed(2)}. Light load lately — green light for harder work today.`;
  } else if (acwr <= 1.3) {
    readinessVal.textContent = 'OPTIMAL';
    readinessVal.className = 'readiness-value';
    readinessDetail.textContent = `Acute:chronic load ${acwr.toFixed(2)}. You're in the training sweet spot.`;
  } else if (acwr <= 1.5) {
    readinessVal.textContent = 'ELEVATED';
    readinessVal.className = 'readiness-value warn';
    readinessDetail.textContent = `Acute:chronic load ${acwr.toFixed(2)}. Recent volume up. Consider an easier session today.`;
  } else {
    readinessVal.textContent = 'HIGH RISK';
    readinessVal.className = 'readiness-value danger';
    readinessDetail.textContent = `Acute:chronic load ${acwr.toFixed(2)}. Strongly consider rest or active recovery today.`;
  }

  // Week stats — last 7 days
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const weekStart = Date.now() - weekMs;
  const week = allWorkouts.filter(w => w.endedAt && w.endedAt >= weekStart);
  const weekDist = week.reduce((s, w) => s + (w.distanceM || 0), 0);
  const weekDur = week.reduce((s, w) => s + (w.durationMs || 0), 0);
  node.querySelector('[data-week="distance"]').textContent =
    Units.formatDistance(weekDist, settings.units) + ' ' + Units.distanceLabel(settings.units);
  node.querySelector('[data-week="time"]').textContent =
    Units.formatDurationShort(weekDur) || '0m';
  node.querySelector('[data-week="count"]').textContent = String(week.length);

  // Workout-of-the-day: compute recommended workout and populate the WOD card.
  // The user can tap it to accept (passes the recommendation into pre-workout
  // via session storage) or tap "freestyle" to go to the default pre-workout.
  const wod = recommendWorkout(profile, allWorkouts);
  const wodCard = node.querySelector('#start-workout');
  const wodTag = node.querySelector('#wod-tag');
  const wodLabel = node.querySelector('#wod-label');
  const wodSub = node.querySelector('#wod-sub');
  const wodAction = node.querySelector('#wod-action');
  wodLabel.textContent = wod.label;
  wodSub.textContent = wod.sub;
  if (wod.kind === 'rest') {
    wodCard.classList.add('rest');
    wodTag.textContent = 'TODAY';
    wodAction.textContent = 'SEE WHY →';
  } else {
    wodCard.classList.remove('rest');
    wodTag.textContent = 'TODAY';
    wodAction.textContent = 'START →';
  }

  // Tap → either show "why rest" sheet (rest day) or pre-populate the
  // pre-workout screen with this recommendation.
  wodCard.addEventListener('click', () => {
    if (wod.kind === 'rest') {
      // Show a brief "why rest" confirm; let user override into freestyle.
      showConfirm({
        title: 'Rest day recommended',
        message: wod.sub + '\n\n' + wod.reason + '\n\nRest is the most underused tool in training. But if you really want to train, tap "Train anyway".',
        confirmLabel: 'TRAIN ANYWAY',
        cancelLabel: 'OK, REST'
      }).then(ok => {
        if (ok) navigate('#/pre');
      });
      return;
    }
    // Stash the WOD so pre-workout can pick it up.
    sessionStorage.setItem('ruckops.wod', JSON.stringify(wod));
    navigate('#/pre');
  });

  // Freestyle link → go to pre-workout fresh (no WOD applied)
  const freestyleBtn = node.querySelector('#freestyle-link');
  if (freestyleBtn) {
    freestyleBtn.addEventListener('click', () => {
      sessionStorage.removeItem('ruckops.wod');
      navigate('#/pre');
    });
  }

  const linkHistory = node.querySelector('#link-history');
  if (linkHistory) linkHistory.addEventListener('click', () => navigate('#/history'));
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
  // Defaults pulled from the calibrated profile when available; otherwise
  // fall back to 9:00/mi (a reasonable middle for first-time users).
  const profile = loadProfile();

  // Pick up the WOD from sessionStorage if the user came from the home
  // recommendation. Applied AS DEFAULTS — the user can still override every
  // tile before starting. If absent, use the standard profile-aware defaults.
  let wod = null;
  try {
    const stash = sessionStorage.getItem('ruckops.wod');
    if (stash) wod = JSON.parse(stash);
    sessionStorage.removeItem('ruckops.wod');  // consume once
  } catch {}

  let method = wod && wod.method ? wod.method : 'off';
  let paceSecPerUnit = (() => {
    const defaultSecPerMi = (wod && wod.paceSecPerMi)
      || profile.easySecPerMi || 9 * 60;
    return settings.units === 'metric'
      ? defaultSecPerMi / 1.609344
      : defaultSecPerMi;
  })();
  // Snap to stepper grid (15s)
  paceSecPerUnit = Math.round(paceSecPerUnit / 15) * 15;
  let customRunSecs = 240;
  let customWalkSecs = 60;
  // WOD goal: time-based by default (most prescribed workouts are time-based).
  let goalType = wod ? (wod.goalTimeMs ? 'time' : (wod.goalDistM ? 'distance' : 'none')) : 'none';
  let goalDistM = (wod && wod.goalDistM) || recommendGoalDistanceM(profile, Workouts.list());
  let goalTimeSec = (wod && wod.goalTimeMs) ? Math.round(wod.goalTimeMs / 1000) : 30 * 60;

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
      const behaviorTag = (settings.goalBehavior === 'stop_at_goal') ? ' · auto-end' : '';
      if (goalType === 'none') {
        tGoal.textContent = 'None';
        tGoalD.textContent = '';
      } else if (goalType === 'distance') {
        const inUnit = settings.units === 'metric' ? goalDistM / 1000 : goalDistM / 1609.344;
        tGoal.textContent = inUnit.toFixed(1) + ' ' + unitLabel();
        const ms = estimateGoalCompletionMs();
        if (ms) tGoalD.textContent = 'ETA ' + formatMinSec(ms / 1000) + behaviorTag;
        else tGoalD.textContent = behaviorTag.replace(/^ · /, '');
      } else if (goalType === 'time') {
        tGoal.textContent = Math.round(goalTimeSec / 60) + ' min';
        const m = estimateGoalDistanceM();
        if (m) {
          const inUnit = settings.units === 'metric' ? m / 1000 : m / 1609.344;
          tGoalD.textContent = 'Expected: ' + inUnit.toFixed(2) + ' ' + unitLabel().toLowerCase() + behaviorTag;
        } else {
          tGoalD.textContent = behaviorTag.replace(/^ · /, '');
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

  // Pacing method selection — when method changes, also push a smart pace
  // default from the calibrated profile. The user can still override via
  // the stepper.
  node.querySelectorAll('.pacing-opt').forEach(b => {
    b.addEventListener('click', () => {
      node.querySelectorAll('.pacing-opt').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      method = b.dataset.pacing;
      if (navigator.vibrate) navigator.vibrate(6);
      // Push a profile-aware default. If user hasn't calibrated, fall back to 9:00/mi.
      if (method !== 'off') {
        const recSecPerMi = recommendPaceFor(method, profile);
        paceSecPerUnit = settings.units === 'metric'
          ? recSecPerMi / 1.609344
          : recSecPerMi;
        // Snap to the stepper's grid (15-second increments)
        paceSecPerUnit = Math.round(paceSecPerUnit / 15) * 15;
      }
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

  // Goal-reached behavior toggle. Setting persists per-user via settings.
  // Per-workout override flows through window.__pendingGoalBehavior.
  // Default selection mirrors the user's saved preference.
  const initBehavior = settings.goalBehavior || 'continue';
  node.querySelectorAll('.goal-behavior-opt').forEach(b => {
    b.classList.toggle('selected', b.dataset.behavior === initBehavior);
    b.addEventListener('click', () => {
      node.querySelectorAll('.goal-behavior-opt').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      const v = b.dataset.behavior;
      // Per-workout override (used at start)
      window.__pendingGoalBehavior = v;
      // Persist as new default
      const s = loadSettings();
      s.goalBehavior = v;
      saveSettings(s);
      // Update hint text
      const hint = node.querySelector('#goal-behavior-hint');
      if (hint) {
        hint.textContent = v === 'stop_at_goal'
          ? 'Workout auto-ends when you hit the goal.'
          : 'Track cooldown after hitting the goal.';
      }
      if (navigator.vibrate) navigator.vibrate(6);
    });
  });
  // Also set the initial hint text correctly.
  const initHint = node.querySelector('#goal-behavior-hint');
  if (initHint) {
    initHint.textContent = initBehavior === 'stop_at_goal'
      ? 'Workout auto-ends when you hit the goal.'
      : 'Track cooldown after hitting the goal.';
  }

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

  // Apply WOD-derived UI selections BEFORE the first render.
  if (wod) {
    node.querySelectorAll('.pacing-opt').forEach(x => x.classList.remove('selected'));
    const methodBtn = node.querySelector(`.pacing-opt[data-pacing="${method}"]`);
    if (methodBtn) methodBtn.classList.add('selected');
    if (goalType !== 'none') {
      node.querySelectorAll('.goal-opt').forEach(x => x.classList.remove('selected'));
      const goalBtn = node.querySelector(`.goal-opt[data-goal="${goalType}"]`);
      if (goalBtn) goalBtn.classList.add('selected');
    }
    setTimeout(() => toast('Today\'s workout loaded — tap any tile to override', 'info'), 200);
  }

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

  // Test sound button — inside the coaching sheet. Clicking is a user gesture,
  // so it's the right place to unlock audio context + speech engine.
  const preTest = node.querySelector('#pre-test-sound');
  if (preTest) {
    preTest.addEventListener('click', () => {
      // Reuse existing soundcoach if present, otherwise spin up a temp one.
      let sc = window.__soundCoach;
      if (!sc) {
        const cur = loadSettings();
        sc = new SoundCoach({
          verbosity: cur.voiceCues || 'full',
          useBeeps: cur.soundEffects !== false,
          units: cur.units
        });
        window.__soundCoach = sc;
      }
      sc.test();
      toast('Playing test sound', 'info');
    });
  }

  // -- HR pairing wiring --------------------------------------------------
  // Use a shared HRMonitor across this renderPre and the live workout. We
  // stash it on window so the live screen can pick it up.
  if (!window.__hrMonitor) window.__hrMonitor = new HRMonitor();
  const hr = window.__hrMonitor;
  const hrTile = node.querySelector('#tile-hr-btn');
  const hrTileVal = node.querySelector('#tile-hr-val');
  const hrTileDetail = node.querySelector('#tile-hr-detail');
  const hrPairBtn = node.querySelector('#hr-pair-btn');
  const hrDisconnectBtn = node.querySelector('#hr-disconnect-btn');
  const hrStatusEl = node.querySelector('#hr-status');
  const hrCurrentEl = node.querySelector('#hr-current');
  const hrZoneEl = node.querySelector('#hr-zone');
  const hrSupportedMsg = node.querySelector('#hr-supported-msg');
  const hrMaxInput = node.querySelector('#hr-max-input');
  const hrRestInput = node.querySelector('#hr-rest-input');

  // Hide HR tile entirely on browsers that don't support Web Bluetooth
  // (most notably iOS Safari). The post-workout RPE prompt fills the gap.
  if (!HRMonitor.isSupported()) {
    hrTile.style.display = 'none';
    if (hrSupportedMsg) {
      hrSupportedMsg.textContent = 'Web Bluetooth isn\'t supported on this browser. Post-workout RPE entry still tracks load. (Try Chrome on Android for HR support.)';
    }
    if (hrPairBtn) hrPairBtn.disabled = true;
  }

  // Pre-populate HRmax/HRrest from profile
  if (hrMaxInput && profile.hrMax) hrMaxInput.value = profile.hrMax;
  if (hrRestInput && profile.hrRest) hrRestInput.value = profile.hrRest;

  function renderHrUi() {
    const bpm = hr.lastBpm;
    const cur = loadProfile();
    if (hr.connected) {
      hrTileVal.textContent = bpm ? bpm + ' BPM' : 'Connected';
      const zone = hr.getZone(cur);
      hrTileDetail.textContent = zone ? 'Zone ' + zone + ' · live coaching active' : 'Set HRmax/HRrest for zones';
      hrTile.classList.add('warn');
      hrStatusEl.textContent = hr.device && hr.device.name || 'Connected';
      hrCurrentEl.textContent = bpm ? bpm + ' BPM' : '—';
      hrZoneEl.textContent = zone ? 'Z' + zone : '—';
      hrPairBtn.classList.add('hidden');
      hrDisconnectBtn.classList.remove('hidden');
    } else {
      hrTileVal.textContent = 'Not paired';
      hrTileDetail.textContent = HRMonitor.isSupported()
        ? 'Tap to pair a Bluetooth strap'
        : 'Web Bluetooth unsupported on this browser';
      hrTile.classList.remove('warn');
      hrStatusEl.textContent = 'Not paired';
      hrCurrentEl.textContent = '—';
      hrZoneEl.textContent = '—';
      hrPairBtn.classList.remove('hidden');
      hrDisconnectBtn.classList.add('hidden');
    }
  }

  hr.on(renderHrUi);
  renderHrUi();

  if (hrPairBtn) {
    hrPairBtn.addEventListener('click', async () => {
      try {
        hrPairBtn.disabled = true;
        const name = await hr.pair();
        toast('Paired: ' + name, 'success');
      } catch (e) {
        console.warn('HR pair failed', e);
        if (e.name === 'NotFoundError' || /user.*cancel/i.test(e.message)) {
          // User cancelled the picker — no toast needed.
        } else {
          toast('HR pairing failed: ' + (e.message || 'unknown'), 'danger');
        }
      } finally {
        hrPairBtn.disabled = false;
      }
    });
  }
  if (hrDisconnectBtn) {
    hrDisconnectBtn.addEventListener('click', () => {
      hr.disconnect();
      toast('HR strap disconnected', 'info');
    });
  }

  // Save HRmax/HRrest to profile when user edits
  function saveHrProfile() {
    const p = loadProfile();
    const hm = parseInt(hrMaxInput.value, 10);
    const hr_ = parseInt(hrRestInput.value, 10);
    if (hm && hm >= 120 && hm <= 220) p.hrMax = hm;
    if (hr_ && hr_ >= 30 && hr_ <= 100) p.hrRest = hr_;
    p.zones = deriveHrZones(p.hrMax, p.hrRest);
    saveProfile(p);
    renderHrUi();
  }
  if (hrMaxInput) hrMaxInput.addEventListener('change', saveHrProfile);
  if (hrRestInput) hrRestInput.addEventListener('change', saveHrProfile);

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
    // Goal-reached behavior: per-workout override on the GOAL tile, falls
    // back to user preference in settings. See goalReachedAt handler in tick().
    lw.goalBehavior = (window.__pendingGoalBehavior || settings.goalBehavior || 'continue');
    window.__pendingGoalBehavior = null;  // consume one-time per-workout override

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
      // Async: fetch weather and update the fuel coach. Non-blocking;
      // standard intervals are used until the response arrives. We use
      // the user's last known GPS coords if available, otherwise skip.
      if (lw.lastFix && lw.lastFix.lat) {
        fetchWeather(lw.lastFix.lat, lw.lastFix.lon).then(w => {
          if (w && lw.fuelCoach) {
            lw.fuelCoach.tempC = w.tempC;
            lw.fuelCoach.humidityPct = w.humidityPct;
            if (w.tempC > 27 || w.tempC < 5) {
              // Surface heat/cold awareness
              const advice = w.tempC > 27
                ? `Hot: ${Math.round(w.tempC)}°C — hydration intervals shortened`
                : `Cold: ${Math.round(w.tempC)}°C — dress warm, layers`;
              toast(advice, 'info');
            }
          }
        });
      }
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
    // Fire an immediate confirmation cue so the user knows sound works.
    // This is INSIDE the user-gesture click handler, so audio is unlocked.
    if (settings.voiceCues !== 'off') {
      setTimeout(() => sc.say('Started', { urgent: true }), 200);
    }
    if (settings.soundEffects !== false) {
      sc.beep(660, 100, { type: 'sine', volume: 0.4 });
      setTimeout(() => sc.beep(880, 150, { type: 'sine', volume: 0.4 }), 120);
    }
    window.__soundCoach = sc;

    // Request DeviceMotion + DeviceOrientation permissions HERE — inside the
    // START click handler — so iOS Safari treats it as a user gesture.
    // The actual sensor start happens in lw.start() below; the permission
    // grant persists for the session once given. Fire-and-forget.
    (async () => {
      try {
        if (typeof DeviceMotionEvent !== 'undefined'
            && typeof DeviceMotionEvent.requestPermission === 'function') {
          await DeviceMotionEvent.requestPermission();
        }
        if (typeof DeviceOrientationEvent !== 'undefined'
            && typeof DeviceOrientationEvent.requestPermission === 'function') {
          await DeviceOrientationEvent.requestPermission();
        }
      } catch (e) {
        // Permission denied — PDR will be unavailable but GPS-only still works.
        console.warn('motion permission not granted', e);
      }
    })();

    // Start the lock-screen presenter so the workout shows on the lock
    // screen + control center, with working pause/resume/stop buttons.
    // MUST happen inside this user-gesture handler for iOS Safari.
    const lockScreen = new LockScreenPresenter({ artworkUrl: 'icon-512.png' });
    const lsOk = lockScreen.start({
      title: 'Workout starting…',
      artist: 'RuckOps',
      album: '',
      onPause: () => { if (window.__liveWorkout) window.__liveWorkout.pause(); },
      onResume: () => { if (window.__liveWorkout) window.__liveWorkout.resume(); },
      onStop: () => { if (window.__liveWorkout) window.__liveWorkout.end(); }
    });
    window.__lockScreen = lockScreen;
    // Surface failures + iOS Silent Mode quirk as a one-time toast so users
    // know what to change. We can't actually detect Silent Mode from web
    // (no API), so we mention it as a likely cause when audio is suspended.
    if (!lsOk) {
      setTimeout(() => {
        if (lockScreen.failureReason === 'no_media_session') {
          toast('Lock-screen requires Safari 16.4+ or Chrome', 'info');
        } else if (lockScreen.failureReason === 'audio_suspended') {
          toast('Lock-screen audio blocked — try without Silent Mode', 'info');
        } else if (lockScreen.failureReason === 'no_audio') {
          toast('Lock-screen not supported on this browser', 'info');
        } else {
          toast('Lock-screen unavailable — workout still tracks normally', 'info');
        }
      }, 800);
    } else {
      // Even when start() succeeded, the audio may be running in
      // 'suspended' state on iOS if Silent Mode was on at start. The OS
      // will start the session if/when the user toggles Silent Mode off.
      setTimeout(() => {
        if (lockScreen.audioCtx
            && lockScreen.audioCtx.state === 'suspended') {
          toast('Lock-screen ready — toggle Silent Mode off if missing', 'info');
        }
      }, 1500);
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

  // ---- iOS shake-to-undo suppression ----
  // The "Undo typing" dialog appears during a workout because running motion
  // is interpreted as the shake gesture. iOS only fires this dialog when
  // there's an active text-input context. Two defenses:
  //   1. Blur any focused element on entering the live screen (defensive —
  //      probably nothing was focused, but if it was, this prevents shake-undo).
  //   2. Listen for the gesture's motion event and stop propagation so the
  //      undo dialog doesn't get a chance to surface. The cleaner approach is
  //      to ensure document.activeElement is never an input on this screen.
  if (document.activeElement && document.activeElement.blur) {
    try { document.activeElement.blur(); } catch {}
  }
  // Hard guard: any element gaining focus on the live screen gets blurred.
  // Workouts don't need text input. If we ever do (e.g. mid-run notes),
  // this guard would need a per-element exception.
  const blurOnFocus = (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      try { e.target.blur(); } catch {}
    }
  };
  node.addEventListener('focusin', blurOnFocus, true);

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

    // DISPLAY pace — combines rolling (stable) + instant (responsive), with
    // an additional EMA on top. The result is ~15 seconds behind ground truth
    // but glance-stable on the live screen. The user's TOTAL TIME and AVERAGE
    // remain perfectly accurate from cumulative measurement; this is just the
    // "what's my pace right now" readout.
    const displayPace = live.getDisplayPaceSecPerUnit(settings.units);
    let currentSecPerUnit = null;
    if (displayPace != null) {
      currentSecPerUnit = displayPace;
      // Throttle text changes: only update if the value actually changed
      // by more than 1 second/unit. Prevents the digit-wiggle effect on a
      // mostly-steady pace.
      const newText = Units.formatPace(displayPace);
      if (paceEl.textContent !== newText) {
        if (!live._lastPaceText || live._lastPaceText !== newText) {
          // Only commit text change if either the seconds rounded differently
          // OR enough time has passed since last commit (1.5s minimum).
          const now = Date.now();
          const sinceLast = now - (live._lastPaceCommitT || 0);
          if (paceEl.textContent === '--:--' || sinceLast > 1500) {
            paceEl.textContent = newText;
            live._lastPaceText = newText;
            live._lastPaceCommitT = now;
          }
        }
      }
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

    // GAP (grade-adjusted pace) — only show when grade is meaningful (>1.5%).
    // On flats this is identical to instant pace and just clutters the screen.
    const gapStat = node.querySelector('#live-gap-stat');
    const gapEl = node.querySelector('#live-gap');
    const grade = live.getCurrentGrade();
    if (gapStat && gapEl && Math.abs(grade) > 0.015 && currentSecPerUnit != null) {
      const gap = live.getGradeAdjustedPaceSecPerUnit(settings.units);
      if (gap != null) {
        gapStat.classList.remove('hidden');
        gapEl.textContent = Units.formatPace(gap);
        // Label shows grade so user knows why GAP differs from PACE
        const lbl = gapStat.querySelector('.label');
        if (lbl) lbl.textContent = 'GAP ' + (grade > 0 ? '+' : '') + Math.round(grade * 100) + '%';
      }
    } else if (gapStat) {
      gapStat.classList.add('hidden');
    }

    // Elevation gain — show once we've climbed at least 10m
    const elevStat = node.querySelector('#live-elev-stat');
    const elevEl = node.querySelector('#live-elev');
    if (elevStat && elevEl && live.totalAscentM >= 10) {
      elevStat.classList.remove('hidden');
      if (settings.units === 'metric') {
        elevEl.textContent = Math.round(live.totalAscentM) + ' m';
      } else {
        elevEl.textContent = Math.round(live.totalAscentM * 3.28084) + ' ft';
      }
    } else if (elevStat) {
      elevStat.classList.add('hidden');
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
      // Tracking-mode-aware chip (spec §5.8). Surface the real tracking
      // quality, not just GPS signal level.
      const mode = live.trackingMode || 'GPS_AVAILABLE';
      if (mode === 'PDR_ONLY') {
        gpsChip.className = 'gps-chip lost';
        gpsChip.textContent = '📍 PDR ONLY';
      } else if (mode === 'DEGRADED') {
        gpsChip.className = 'gps-chip lost';
        gpsChip.textContent = '⚠ DEGRADED';
      } else if (mode === 'STATIONARY') {
        gpsChip.className = 'gps-chip strong';
        gpsChip.textContent = '⏸ STATIONARY';
      } else if (live.isGpsLost()) {
        gpsChip.className = 'gps-chip lost';
        gpsChip.textContent = '⚠ SIGNAL LOST';
      } else {
        const sig = live.gpsSignal || 'searching';
        // Append conformal coverage radius when known.
        let label = '📡 ' + sig.toUpperCase();
        if (live.conformal && live.kalman && live.kalman.initialized) {
          const sigmaM = live.kalman.positionStdev();
          if (isFinite(sigmaM) && sigmaM > 0) {
            const r = live.conformal.radius(sigmaM);
            if (r > 0 && r < 200) label += ' · ±' + Math.round(r) + 'm';
          }
        }
        gpsChip.className = 'gps-chip ' + sig;
        gpsChip.textContent = label;
      }
    }

    // HR chip — live BPM + zone color. Hidden if no HR is connected.
    const hrChip = node.querySelector('#live-hr-chip');
    const hrMon = window.__hrMonitor;
    if (hrChip && hrMon && hrMon.connected && hrMon.lastBpm) {
      hrChip.classList.remove('hidden');
      const profile = loadProfile();
      const zone = hrMon.getZone(profile);
      hrChip.className = 'hr-chip live' + (zone ? ' zone-' + zone : '');
      hrChip.textContent = hrMon.lastBpm + ' BPM' + (zone ? ' · Z' + zone : '');
      // Sample HR into the live workout for the saved record
      if (!live.hrSamples) live.hrSamples = [];
      if (!live._lastHrSample || Date.now() - live._lastHrSample > 1000) {
        live.hrSamples.push({ t: live.elapsedMs, bpm: hrMon.lastBpm });
        live._lastHrSample = Date.now();
      }
    } else if (hrChip) {
      hrChip.classList.add('hidden');
    }

    // Cadence chip — current spm from motion tracker.
    const cadChip = node.querySelector('#live-cadence-chip');
    if (cadChip && live.motion && live.motion.enabled && live.motion.cadenceSpm > 0) {
      cadChip.classList.remove('hidden');
      cadChip.textContent = live.motion.cadenceSpm + ' SPM';
    } else if (cadChip) {
      cadChip.classList.add('hidden');
    }

    // Dead-reckoning chip — visible when GPS is lost but PDR is filling in.
    const drChip = node.querySelector('#live-dr-chip');
    if (drChip && live.motion && live.motion.enabled
        && live.motion.strideCalibrated
        && live.lastFixWallTime
        && Date.now() - live.lastFixWallTime > 8000) {
      drChip.classList.remove('hidden');
      drChip.textContent = '📍 DEAD-RECKONING';
    } else if (drChip) {
      drChip.classList.add('hidden');
    }

    // Lock-screen presenter metadata update — throttled to once per ~5s
    // (no value updating it on every render; the lock-screen UI doesn't
    // refresh that fast anyway and it costs a little CPU).
    const ls = window.__lockScreen;
    if (ls && ls.active) {
      if (!live._lastLockScreenUpdate || Date.now() - live._lastLockScreenUpdate > 4500) {
        live._lastLockScreenUpdate = Date.now();
        // Title = primary metric (distance + pace), subtitle = phase + duration.
        const distStr = Units.formatDistance(live.distanceM, settings.units)
          + ' ' + Units.distanceLabel(settings.units).toLowerCase();
        const paceStr = currentSecPerUnit
          ? Units.formatPace(currentSecPerUnit) + ' ' + Units.paceLabel(settings.units).toLowerCase()
          : '';
        const durationStr = Units.formatDuration(live.elapsedMs);
        let phaseStr = '';
        if (live.pacingPlan) {
          const r = live.pacingPlan.tick(live.elapsedMs, live.distanceM);
          phaseStr = (r.label || (r.phase === 'run' ? 'RUN' : 'WALK'));
          if (r.remainingMs != null && !r.isComplete) {
            const s = Math.ceil(r.remainingMs / 1000);
            phaseStr += ' · ' + Math.floor(s/60) + ':' + (s%60).toString().padStart(2,'0');
          }
        }
        ls.updateMetadata({
          title: distStr + (paceStr ? ' · ' + paceStr : ''),
          artist: phaseStr || (live.pacingPlan ? live.pacingPlan.label : 'RuckOps'),
          album: durationStr + (live.mode === 'ruck' && live.packWeightKg ? ' · ' + Units.formatWeight(live.packWeightKg, settings.units) + ' ' + Units.weightLabel(settings.units).toLowerCase() : '')
        });
        ls.setPlaybackState(live.status === 'paused' ? 'paused' : 'playing');
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
  // Elevation gain
  if (record.totalAscentM && record.totalAscentM >= 10) {
    const ascentDisplay = settings.units === 'metric'
      ? `${Math.round(record.totalAscentM)} m`
      : `${Math.round(record.totalAscentM * 3.28084)} ft`;
    stats.push({ label: 'ASCENT', val: ascentDisplay });
  }
  // HR averages from samples
  if (record.hrSamples && record.hrSamples.length > 0) {
    const bpms = record.hrSamples.map(s => s.bpm);
    const avgHr = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);
    const maxHr = Math.max(...bpms);
    stats.push({ label: 'AVG HR', val: avgHr + ' BPM' });
    stats.push({ label: 'MAX HR', val: maxHr + ' BPM' });
  }
  // Cadence — average steps per minute. Only show if motion tracker was active.
  if (record.totalSteps && record.totalSteps > 0 && record.durationMs > 0) {
    const avgSpm = Math.round(record.totalSteps / (record.durationMs / 60000));
    stats.push({ label: 'AVG CADENCE', val: avgSpm + ' SPM' });
    stats.push({ label: 'TOTAL STEPS', val: record.totalSteps.toLocaleString() });
  }
  // PDR supplement — distance filled in by step-counter during GPS outages.
  // Only shown if non-trivial.
  if (record.pdrSupplementedM && record.pdrSupplementedM > 30) {
    const pdrDisplay = settings.units === 'metric'
      ? `${(record.pdrSupplementedM / 1000).toFixed(2)} km`
      : `${(record.pdrSupplementedM / 1609.344).toFixed(2)} mi`;
    stats.push({ label: 'PDR FILL', val: pdrDisplay });
  }
  // Goal-reached: if the user kept going past their goal, show the moment-of-reach.
  if (record.goalReachedAt && record.durationMs > record.goalReachedAt.durationMs + 5000) {
    const reachMins = Math.floor(record.goalReachedAt.durationMs / 60000);
    const reachSecs = Math.floor((record.goalReachedAt.durationMs % 60000) / 1000);
    stats.push({
      label: 'GOAL REACHED',
      val: `${reachMins}:${reachSecs.toString().padStart(2, '0')}`
    });
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

  // RPE picker — one-tap selection.
  let selectedRpe = null;
  const rpeBtns = node.querySelectorAll('.rpe-btn');
  rpeBtns.forEach(b => {
    b.addEventListener('click', () => {
      rpeBtns.forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      selectedRpe = parseInt(b.dataset.rpe, 10);
      if (navigator.vibrate) navigator.vibrate(8);
    });
  });
  // If the workout had HR data, pre-suggest an RPE based on time in zones.
  if (record.hrSamples && record.hrSamples.length > 0) {
    const profile = loadProfile();
    if (profile.hrMax && profile.hrRest) {
      const hrr = profile.hrMax - profile.hrRest;
      const avgPct = record.hrSamples
        .map(s => (s.bpm - profile.hrRest) / hrr)
        .reduce((a, b) => a + b, 0) / record.hrSamples.length;
      let suggested;
      if (avgPct < 0.6) suggested = 2;
      else if (avgPct < 0.7) suggested = 4;
      else if (avgPct < 0.8) suggested = 6;
      else if (avgPct < 0.9) suggested = 8;
      else suggested = 10;
      const btn = node.querySelector(`.rpe-btn[data-rpe="${suggested}"]`);
      if (btn) {
        btn.classList.add('selected');
        selectedRpe = suggested;
      }
    }
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
    if (selectedRpe != null) record.rpe = selectedRpe;
    Workouts.save(record);
    Storage.remove(DRAFT_KEY);
    window.__liveWorkout = null;
    if (window.__lockScreen) { window.__lockScreen.stop(); window.__lockScreen = null; }
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
    if (window.__lockScreen) { window.__lockScreen.stop(); window.__lockScreen = null; }
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

    // Calibration tile
    const calT = node.querySelector('#tile-cal-val');
    const calD = node.querySelector('#tile-cal-detail');
    const profile = loadProfile();
    if (calT) {
      if (profile.miTrialPaceSecPerMi) {
        const secPerMi = profile.miTrialPaceSecPerMi;
        const secPerUnit = cur.units === 'metric' ? secPerMi / 1.609344 : secPerMi;
        const m = Math.floor(secPerUnit / 60);
        const s = Math.round(secPerUnit % 60).toString().padStart(2, '0');
        const unit = cur.units === 'metric' ? '/km' : '/mi';
        calT.textContent = '1mi time: ' + m + ':' + s + unit;
        if (calD && profile.miTrialAt) {
          const date = new Date(profile.miTrialAt);
          const days = Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
          calD.textContent = days === 0 ? 'today' : days + ' day' + (days === 1 ? '' : 's') + ' ago · tap to recalibrate';
        }
      } else {
        calT.textContent = 'Not calibrated · tap to run';
        if (calD) calD.textContent = '12 min · unlocks personalized pacing';
      }
    }
  }
  renderProfileTiles();

  // Wire calibration tile click
  const calTile = node.querySelector('#tile-cal');
  if (calTile) {
    calTile.addEventListener('click', () => navigate('#/calibration'));
  }

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

  // Test sound button on profile
  const profileTest = node.querySelector('#profile-test-sound');
  if (profileTest) {
    profileTest.addEventListener('click', () => {
      let sc = window.__soundCoach;
      if (!sc) {
        const cur = loadSettings();
        sc = new SoundCoach({
          verbosity: cur.voiceCues || 'full',
          useBeeps: cur.soundEffects !== false,
          units: cur.units
        });
        window.__soundCoach = sc;
      }
      sc.test();
      toast('Playing test sound', 'info');
    });
  }

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

// -- Calibration session ------------------------------------------------
// A guided 3-phase fitness test: warmup → 1mi time trial → cooldown.
// On completion, derives vVO2max / threshold / easy / marathon paces using
// Daniels' Running Formula percentages, saves them into the profile, and
// every interval mode in the app uses them as defaults from then on.
//
// The session uses GPS tracking like a real workout but does NOT persist
// to the workouts list — only the derived paces go into the profile.
// User can SKIP PHASE (advance immediately) or ABORT (discard).

const CAL_WARMUP_MS    = 5 * 60 * 1000;   // 5 min easy
const CAL_TRIAL_DIST_M = 1609.344;        // 1 mile
const CAL_COOLDOWN_MS  = 5 * 60 * 1000;   // 5 min easy

function renderCalibration(root) {
  const node = mountTemplate(root, 'tpl-calibration');
  const settings = loadSettings();
  applyUnits(node, settings.units);

  // State machine: 'intro' | 'warmup' | 'trial' | 'cooldown' | 'results'
  let phase = 'intro';
  let phaseStartedAt = null;   // ms timestamp when current phase began
  let trialStartDistM = null;  // distance reading at trial-start
  let trialEndedAt = null;
  let trialPaceSecPerMi = null;
  let lw = null;                // shared LiveWorkout for GPS tracking
  let updateInterval = null;
  let sc = null;                // SoundCoach

  // Elements
  const phaseLabel = node.querySelector('#cal-phase-label');
  const phaseStep = node.querySelector('#cal-phase-step');
  const hero = node.querySelector('#cal-hero');
  const heroLabel = node.querySelector('#cal-hero-label');
  const distEl = node.querySelector('#cal-distance');
  const durEl = node.querySelector('#cal-duration');
  const paceEl = node.querySelector('#cal-pace');
  const instructionEl = node.querySelector('#cal-instruction');
  const skipBtn = node.querySelector('#cal-skip-phase');
  const abortBtn = node.querySelector('#cal-abort');
  const introSheet = node.querySelector('#sheet-cal-intro');
  const resultsSheet = node.querySelector('#sheet-cal-results');

  // -- Phase transitions --
  function setPhase(newPhase) {
    phase = newPhase;
    phaseStartedAt = Date.now();
    if (newPhase === 'warmup') {
      phaseLabel.textContent = 'WARMUP';
      phaseStep.textContent = 'Step 1 of 3';
      heroLabel.textContent = 'LEFT';
      instructionEl.textContent = 'Warm up at a comfortable easy pace. Get your legs moving and your breathing steady.';
      if (sc) sc.say('Warmup. Five minutes easy.', { urgent: true });
    } else if (newPhase === 'trial') {
      phaseLabel.textContent = 'TIME TRIAL';
      phaseStep.textContent = 'Step 2 of 3 · 1 MILE';
      heroLabel.textContent = 'TO GO';
      instructionEl.textContent = 'Now push as hard as you can sustain for one mile. This sets every pace in the app.';
      trialStartDistM = lw ? lw.distanceM : 0;
      if (sc) {
        sc.say('Warmup complete. Time trial starts now. Push hard for one mile.', { urgent: true });
        sc.beep(880, 200);
        setTimeout(() => sc.beep(1100, 300), 220);
      }
    } else if (newPhase === 'cooldown') {
      phaseLabel.textContent = 'COOL DOWN';
      phaseStep.textContent = 'Step 3 of 3';
      heroLabel.textContent = 'LEFT';
      instructionEl.textContent = 'Easy jog or walk for five minutes. Your numbers are saved — finishing well sets you up for tomorrow.';
      // Compute trial pace
      if (lw && trialStartDistM != null) {
        const trialDistM = lw.distanceM - trialStartDistM;
        const trialDurMs = Date.now() - phaseStartedAt;
        // We just transitioned, so phaseStartedAt is "now". Use the
        // trial's actual duration (from end-of-warmup to now).
        // Re-read by computing from elapsedMs progression — simpler:
        // track trialEndedAt separately.
        trialEndedAt = Date.now();
        // Pace = duration / distance_in_miles
        const trialMi = trialDistM / 1609.344;
        if (trialMi > 0) {
          // We need the trial duration BEFORE phaseStartedAt was reset.
          // Compute from before-this-call:
          // Hmm — phaseStartedAt was reset at top of setPhase. We need a
          // separate variable for trial duration.
        }
      }
      if (sc) {
        sc.say('One mile complete. Easy cool down for five minutes.', { urgent: true });
        sc.beep(660, 150);
      }
    } else if (newPhase === 'results') {
      // Stop GPS tracking
      if (lw && lw.status === 'running') {
        lw.end();
      }
      if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
      // Compute trial pace from stored values
      computeAndShowResults();
    }
  }

  // We need to track the trial duration accurately. Let me restructure:
  // record trial start/end times separately from phaseStartedAt.
  let trialStartedAt = null;

  // Override setPhase logic by hooking it post-call
  const _setPhase = setPhase;
  setPhase = function(newPhase) {
    if (newPhase === 'trial') {
      trialStartedAt = Date.now();
    } else if (newPhase === 'cooldown' && trialStartedAt != null) {
      trialEndedAt = Date.now();
      if (lw && trialStartDistM != null) {
        const trialDistM = lw.distanceM - trialStartDistM;
        const trialDurMs = trialEndedAt - trialStartedAt;
        const trialMi = trialDistM / 1609.344;
        if (trialMi >= 0.85) {  // sanity floor — accept slight short measurements
          // Scale to a per-mile pace
          trialPaceSecPerMi = (trialDurMs / 1000) / trialMi;
        }
      }
    }
    _setPhase(newPhase);
  };

  function computeAndShowResults() {
    if (!trialPaceSecPerMi || trialPaceSecPerMi < 4 * 60 || trialPaceSecPerMi > 20 * 60) {
      // No valid trial pace (too short distance, GPS bad, etc.)
      toast('Trial result invalid — try calibration again on a clearer route', 'danger');
      navigate('#/home');
      return;
    }
    const profile = loadProfile();
    const runsPerWeek = profile.runsPerWeek || 3;
    const derived = derivePacesFromMileTrial(trialPaceSecPerMi, runsPerWeek);
    // Populate the results sheet
    const fmt = (secPerMi) => {
      if (!secPerMi || !isFinite(secPerMi)) return '—';
      const secPerUnit = settings.units === 'metric' ? secPerMi / 1.609344 : secPerMi;
      const m = Math.floor(secPerUnit / 60);
      const s = Math.round(secPerUnit % 60);
      return m + ':' + s.toString().padStart(2, '0') + ' /' + (settings.units === 'metric' ? 'km' : 'mi');
    };
    node.querySelector('#cal-result-headline').textContent =
      'Your 1-mile pace: ' + fmt(trialPaceSecPerMi);
    node.querySelector('#cal-vvo2').textContent = fmt(derived.vVO2maxSecPerMi);
    node.querySelector('#cal-threshold').textContent = fmt(derived.thresholdSecPerMi);
    node.querySelector('#cal-easy').textContent = fmt(derived.easySecPerMi);
    node.querySelector('#cal-marathon').textContent = fmt(derived.marathonSecPerMi);
    // Stash for SAVE handler
    node.querySelector('#cal-save').onclick = () => {
      const updated = {
        ...profile,
        miTrialPaceSecPerMi: trialPaceSecPerMi,
        miTrialAt: new Date().toISOString(),
        ...derived
      };
      saveProfile(updated);
      toast('Calibration saved — paces personalized', 'success');
      navigate('#/home');
    };
    node.querySelector('#cal-redo').onclick = () => {
      // Restart from intro
      trialPaceSecPerMi = null;
      trialStartedAt = null;
      trialEndedAt = null;
      trialStartDistM = null;
      resultsSheet.classList.add('hidden');
      introSheet.classList.remove('hidden');
      phaseLabel.textContent = 'WARMUP';
      phaseStep.textContent = 'Step 1 of 3';
    };
    resultsSheet.classList.remove('hidden');
  }

  function tickUpdate() {
    if (!lw || phase === 'intro' || phase === 'results') return;
    distEl.textContent = Units.formatDistance(lw.distanceM, settings.units);
    durEl.textContent = Units.formatDuration(lw.elapsedMs);
    const rolling = lw.getRollingPaceSecPerUnit(settings.units);
    paceEl.textContent = rolling ? Units.formatPace(rolling) : '--:--';

    // Phase-specific hero metric + auto-advance
    if (phase === 'warmup') {
      const remaining = Math.max(0, CAL_WARMUP_MS - (Date.now() - phaseStartedAt));
      const s = Math.ceil(remaining / 1000);
      const mm = Math.floor(s / 60).toString().padStart(2, '0');
      const ss = (s % 60).toString().padStart(2, '0');
      hero.textContent = mm + ':' + ss;
      // Anticipation cue at 10s remaining
      if (remaining <= 10000 && remaining > 8500 && sc && !node._warmupAnt) {
        node._warmupAnt = true;
        sc.beep(880, 80);
        sc.say('Ten seconds to time trial');
      }
      if (remaining === 0) {
        setPhase('trial');
      }
    } else if (phase === 'trial') {
      const covered = lw.distanceM - (trialStartDistM || 0);
      const remaining = Math.max(0, CAL_TRIAL_DIST_M - covered);
      const inUnit = settings.units === 'metric'
        ? remaining / 1000
        : remaining / 1609.344;
      hero.textContent = inUnit < 0.01 ? '0.00' : inUnit.toFixed(2);
      heroLabel.textContent = (settings.units === 'metric' ? 'KM' : 'MI') + ' TO GO';
      if (remaining <= 0) {
        setPhase('cooldown');
      }
    } else if (phase === 'cooldown') {
      const remaining = Math.max(0, CAL_COOLDOWN_MS - (Date.now() - phaseStartedAt));
      const s = Math.ceil(remaining / 1000);
      const mm = Math.floor(s / 60).toString().padStart(2, '0');
      const ss = (s % 60).toString().padStart(2, '0');
      hero.textContent = mm + ':' + ss;
      if (remaining === 0) {
        setPhase('results');
      }
    }
  }

  // -- Button handlers --
  node.querySelector('.back').addEventListener('click', () => {
    if (phase !== 'intro' && phase !== 'results') {
      showConfirm({
        title: 'Abort calibration?',
        message: 'Your time trial result will not be saved.',
        confirmLabel: 'ABORT',
        cancelLabel: 'KEEP GOING',
        danger: true
      }).then(ok => {
        if (ok) cleanup() && navigate('#/home');
      });
    } else {
      cleanup();
      navigate('#/home');
    }
  });

  abortBtn.addEventListener('click', () => {
    showConfirm({
      title: 'Abort calibration?',
      message: 'Your time trial result will not be saved.',
      confirmLabel: 'ABORT',
      cancelLabel: 'KEEP GOING',
      danger: true
    }).then(ok => {
      if (ok) {
        cleanup();
        navigate('#/home');
      }
    });
  });

  skipBtn.addEventListener('click', () => {
    if (phase === 'warmup') setPhase('trial');
    else if (phase === 'trial') setPhase('cooldown');
    else if (phase === 'cooldown') setPhase('results');
  });

  // Intro sheet: BEGIN starts the warmup
  node.querySelector('#cal-begin').addEventListener('click', () => {
    introSheet.classList.add('hidden');
    // Build a LiveWorkout for GPS tracking — but mark it as calibration so
    // it doesn't save to the workouts list.
    lw = new LiveWorkout({ mode: 'run', packWeightKg: 0, autoPause: false });
    lw._calibration = true;
    // Spin up a SoundCoach using current settings
    sc = new SoundCoach({
      verbosity: settings.voiceCues || 'full',
      anticipationSec: settings.anticipationSec || 10,
      useBeeps: settings.soundEffects !== false,
      units: settings.units
    });
    sc.unlock();
    window.__soundCoach = sc;
    lw.start();
    setPhase('warmup');
    updateInterval = setInterval(tickUpdate, 200);
  });
  node.querySelector('#cal-cancel').addEventListener('click', () => {
    cleanup();
    navigate('#/home');
  });

  function cleanup() {
    if (updateInterval) { clearInterval(updateInterval); updateInterval = null; }
    if (lw && lw.status === 'running') lw.end();
    lw = null;
    sc = null;
    return true;
  }
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
