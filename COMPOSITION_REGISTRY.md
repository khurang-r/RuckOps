# RuckOps Composition Registry v1.0

> **Sealed:** 2026-05-12
> **Purpose:** This document is the contract that bounds what RuckOps can claim and how its features are constructed. No feature ships unless it decomposes into the primitives and composition rules registered here. New primitives require a separate validation cycle before they enter the registry.
>
> **Tier system:** T1 = Defensible (field-validated). T2 = Provisional (implementation matches published method but field accuracy unverified). T3 = Suspect (works only on synthetic data OR has known correctness gaps). T4 = Withdrawn / aspirational only.

---

## §1 Why this exists

The app was built with strong individual primitives (Kalman, Bayesian stride, conformal coverage, magnetometer health gating) but no explicit rules for how they compose. Bugs that escaped — `lw.stop()` vs `lw.end()`, time-source mismatch in the 5-minute session test, lock-screen device variance, GAP wildness — were all composition-level failures, not primitive-level ones.

The registry forces honesty about what we have and what we claim. A feature's tier is bounded by its weakest component. Marketing copy that claims more than the registry supports is, mechanically, false.

---

## §2 Primitives

Each primitive declares: its source location, its contract (what it promises to its consumers), its tier on the date of this registry, and a one-line justification of the tier.

### P1 KalmanGPS
- **Source:** `app.js`, class `KalmanGPS`
- **Contract:** Given a stream of `{lat, lon, accuracy, timestamp}` GPS fixes, produces a filtered position estimate with associated velocity and a position standard deviation. Distance accumulated from filtered states matches ground truth within 5% over windows ≥100 m with accuracy <20 m.
- **Tier:** T1
- **Justification:** 4-state Kalman is a textbook implementation. Verified against synthetic noisy ground truth; ratio holds. Math is auditable.

### P2 MotionTracker (Weinberg + bandpass + gait classification)
- **Source:** `app.js`, class `MotionTracker`
- **Contract:** Given a calibrated stride coefficient K and a DeviceMotion stream, produces step events at times τᵢ with stride estimates sᵢ such that Σsᵢ approximates horizontal distance walked over [τ₀, τₙ] within ±10% on flat terrain at sustained cadence ≥80 spm.
- **Tier:** T2
- **Justification:** Implementation matches Weinberg (2002) for stride estimation. The ±10% claim holds on synthetic step injections. **No field measurement against ground truth yet.**

### P3 BayesianStrideModel
- **Source:** `app.js`, class `BayesianStrideModel`
- **Contract:** Exposes `update(cadenceSpm, observedStride)` and `predict(cadenceSpm)`. Given (cadence, observed stride) pairs over time via `update()`, maintains a per-user posterior over the stride-cadence relationship α + β·(cadence−c̄). `predict()` returns the posterior mean stride. Predictions converge to within 3% of observed strides after ≥30 calibration samples spanning a cadence range of 20 spm.
- **Tier:** T2
- **Justification:** Closed-form conjugate Bayesian update is correct; convergence verified on synthetic data. Bounded adaptation prevents contamination divergence. Per-user real-world fit is unverified.

### P4 ConformalCoverage
- **Source:** `app.js`, class `ConformalCoverage`
- **Contract:** Given a rolling buffer of (error, predicted-σ) pairs assumed exchangeable, produces a radius r such that on i.i.d. test data drawn from the same distribution, the fraction of errors ≤ r is approximately 1 − α = 0.95.
- **Tier:** T2
- **Justification:** Vovk's split-conformal method is mathematically correct. Empirical 95% coverage verified on synthetic i.i.d. data. Real workouts violate i.i.d. (errors are autocorrelated, distribution shifts mid-session); coverage degradation under shift is bounded but unmeasured in the field.

### P5 BarometerTracker
- **Source:** `app.js`, class `BarometerTracker`
- **Contract:** Given a pressure stream from `DeviceOrientationEvent`/`Magnetometer` extensions, produces calibrated altitude in meters with ~1 m noise floor when calibrated against a known reference. Recovers grade with stdev <2% over 80 m windows.
- **Tier:** T1
- **Justification:** ICAO standard atmosphere conversion is exact. Calibration shifts the reference; relative altitude differences are accurate by construction.

### P6 MagHealthGate
- **Source:** `app.js`, inside `MotionTracker`, methods `_updateMagHealth`, `_magHealthy`
- **Contract:** Given a magnetometer stream, produces a hysteretic flag indicating whether magnetometer readings should be trusted. Rejects readings outside Earth's 25–65 µT field envelope or with rate-of-change >180°/s. Flag flips false after 5 consecutive bad readings, flips true after 5 consecutive good readings.
- **Tier:** T2
- **Justification:** Sanity bounds and hysteresis are correct as implemented. Whether "bad readings near metal" actually trigger the gate in practice is unmeasured; the literature supports the approach.

### P7 HRMonitor (BLE)
- **Source:** `app.js`, class `HRMonitor`
- **Contract:** Given a paired BLE heart-rate-service device, produces a stream of BPM values with the device's native sampling rate (typically 1 Hz).
- **Tier:** T1
- **Justification:** BLE GATT HR service is a stable web standard; readings come directly from the strap. No transformation applied.

### P8 ACWRCompute
- **Source:** `app.js`, function `computeACWR`
- **Contract:** Given a history of session loads L₁, …, Lₙ with timestamps, produces the ratio (acute load over last 7 days) / (chronic load over last 28 days). When chronic load is zero or chronic-week sample count <2, returns null.
- **Tier:** T2
- **Justification:** Computation follows Gabbett (2016). The threshold value of 1.5 for injury risk is supported by literature on athletic populations. Whether the threshold applies to weekend warriors and ruckers specifically is unmeasured.

### P9 GoalDetect
- **Source:** `app.js`, in `LiveWorkout.tick`, the "GOAL REACHED DETECTION" block
- **Contract:** Given a goal (distance or time) and a current state, produces exactly one "goal reached" event the first time the goal threshold is crossed. Subsequent ticks past the goal produce no further events. Snapshot of state at the crossing moment is preserved.
- **Tier:** T1
- **Justification:** Deterministic threshold comparison with one-shot guard. Verified by 9 boundary-case unit tests including snapshot-fires-once, time-goal, no-goal, and stop-vs-continue divergence.

### P10 TrailMatcher (HMM Viterbi)
- **Source:** `app.js`, class `TrailMatcher`
- **Contract:** Given a noisy GPS track and a trail graph from OpenStreetMap Overpass, produces a snapped track that follows trail edges where the joint observation+transition probability supports the snap, and preserves raw points where it does not.
- **Tier:** T3
- **Justification:** Newson & Krumm (2009) algorithm is implemented correctly per the haversine/projection unit tests. The HMM emission and transition probabilities use literature defaults that are NOT tuned for the trail-running case. Field accuracy is unmeasured; mis-snaps to parallel trails are plausible failure modes.

### P11 LockScreenPresenter
- **Source:** `app.js`, class `LockScreenPresenter`
- **Contract:** Given workout metadata + handler callbacks, attempts to register an OS-level MediaSession that surfaces on lock screen and Control Center. **Exposes `failureReason`** when the session cannot be established. Does NOT promise the lock screen surface appears; only promises that the registration attempt is made and its failure mode is queryable.
- **Tier:** T1
- **Justification:** The contract is deliberately narrow — we promise to *attempt* and *report* the result, not to guarantee the surface. Three unit tests verify failureReason is set correctly across (no MediaSession, audio suspended, normal start) cases.

### P12 PlanState
- **Source:** `app.js`, class `PlanState` and `COACHING_PLANS` data table
- **Contract:** Given a plan id, current day index, and completion history, produces today's prescribed workout via `today()`. Advances dayIndex by exactly 1 on `complete()` (one-shot per day — repeat calls for the same day are no-ops). `skip()` also advances by 1 and records the skip with a reason. `toJSON()` / `fromJSON()` round-trip preserves all state per C-PERSIST contract.
- **Tier:** T2
- **Justification:** Day-advancement logic is deterministic and one-shot-guarded (verified by tests). Plan content is evidence-cited per source (Cooper, Knapik USARIEM, Pfitzinger). **NO claim is made about user outcomes** — the primitive's tier reflects structural correctness of the schedule engine only, not clinical efficacy of the plans.
- **Out-of-scope (registry §8 honoring):** This primitive does not promise users will hit race goals, prevent injury, or replace human coaching. Marketing copy claiming any of these would violate the tier ceiling.

### P13 PaceZones
- **Source:** `app.js`, class `PaceZones` and `DANIELS_VDOT_TABLE`
- **Contract:** Given a recent time-trial result `{distanceMi, durationSec, mode}`, returns:
  - For `mode === 'run'`: `{vdot: int, easy, marathon, threshold, interval, repetition}` with paces in sec/mi per Daniels (2014). Returns null if mode is not run or time-trial inputs are invalid.
  - For `mode === 'ruck'`: returns null. **Ruck pacing is the domain of P13b, not this primitive.** This is a registry invariant — the primitive must not silently map ruck inputs to running zones.
- **Tier:** T1
- **Justification:** The VDOT lookup table is published (Daniels 2014); my implementation is a transcription. Tested against 10 reference VDOT values from the textbook, exact match required. Math (VDOT → zone paces) follows the same source. No outcome claims attached; the contract is "given this input, produce this output."
- **Falsification:** Any of the 10 reference values differs from the published value by more than 1 sec/mi.

### P13b RuckPaceTargets
- **Source:** `app.js`, class `RuckPaceTargets`
- **Contract:** Given `{packKg, observedRuckPaces: [secPerMi, ...]}`, returns:
  - For run mode (if called): null
  - For ruck mode: `{easy, standard, tempo}` paces in sec/mi based on Knapik / U.S. Army FM 21-18 standard pace adjusted for the user's observed personal variance. Standard pace = 15 min/mi at 35 lb baseline; adjusted by Knapik's empirical pack-weight slowdown coefficient. Personal variance derived from `observedRuckPaces` when n≥3 samples available; otherwise returns the population-level standard.
- **Tier:** T2
- **Justification:** The Knapik standard is published; the pack-weight adjustment uses Knapik's empirical equation (pace adds ~0.5 min/mi per 5 kg above 16 kg baseline). Personal-variance fitting is a simple mean shift from observed history — this is the part that limits tier to T2: the population-level adjustment is sound, but the personal-variance step is a heuristic without RCT support.
- **Falsification:** Standard pace at 35 lb (16 kg) with no history must equal 15 min/mi within ±5 sec/mi. Higher pack weight must produce slower (numerically larger) pace.

### P16 MetronomeEngine
- **Source:** `app.js`, class `MetronomeEngine`
- **Contract:** Given a target cadence in spm and an audio context, generates audio beats at the target interval until stopped. Supports adaptive recalibration: given an observed cadence (e.g., from P2 MotionTracker), adjusts target up or down by a bounded amount (default ±5%, hard-capped to 150-200 spm for run mode, 100-130 spm for walk/ruck mode). Wires to the existing audio infrastructure — does not create new permissions or contexts. Exposes `start({ targetSpm, mode })`, `stop()`, `adapt({ observedSpm })`, `currentTarget()`.
- **Tier:** T2
- **Justification:** Tempo accuracy is mechanically verifiable (beats over 60s window must match target ±2 spm — pure timer arithmetic). Adaptation policy is bounded (cannot drift outside published cadence ranges). The +5% increase from self-selected cadence is supported by Heiderscheit et al. (2011) and form-cue literature. T2 because the *effect* on individual running economy or injury rate is unmeasured by this app; only the *tempo accuracy* and *bound adherence* are testable.
- **Falsification:** Beat count over a 60-second window deviates from target by more than 2 spm. Or: an adaptation call produces a target outside the documented bounds.
- **Out-of-scope (will refuse to support):**
  - "180 spm always" preset (literature is clear this is not universal)
  - User-typed cadence target without bounds checking (refuses 250 spm, refuses 80 spm in run mode)
  - HR-driven metronome (HR is too lagged for beat-by-beat cues)
  - A "form score" derived from cadence alone

### P14 FormFitnessFatigue
- **Source:** `app.js`, class `FormFitnessFatigue`
- **Contract:** Given a chronological history of (session_load, timestamp_ms) pairs, produces `{fitness, fatigue, form}` scores per Banister (1991) and Busso (2003). Computation:
  - `fitness(t) = Σᵢ load_i × exp(-(t - tᵢ) / τ_fitness)` with τ_fitness = 42 days
  - `fatigue(t) = Σᵢ load_i × exp(-(t - tᵢ) / τ_fatigue)` with τ_fatigue = 7 days
  - `form(t) = fitness(t) - k × fatigue(t)` with k = 2.0 (Busso's published coefficient)
  - Returns null if history is empty or has fewer than 3 sessions (insufficient signal).
  - Time constants are configurable for future calibration but defaults are Banister's published values.
- **Tier:** T2
- **Justification:** The Banister model is published mathematics; my implementation is the textbook transcription. Tested via known fixed-point cases (a single load N days ago decays to load × exp(-N/τ)) and monotonicity properties. T2 (not T1) because the τ constants come from elite-athlete studies; individual fits would shift them, and we don't measure individual fits. The model is *applied* correctly; the question of whether 42 / 7 are the right time constants *for this user* is empirical and unmeasured here.
- **Falsification:** A single-load history of magnitude L deposited exactly 7 days ago should produce fatigue ≈ L × exp(-1) = 0.3679 × L within ±1%. Form must be lower immediately after a hard session than 7 days later (post-recovery rebound), for any single session.
- **Out-of-scope:** Race-time prediction from fitness scores. Individual-optimal training-load prescription. Recovery countdown timers.

### P17 MetronomeController
- **Source:** `app.js`, class `MetronomeController`
- **Contract:** A higher-level coordinator that wraps P16 MetronomeEngine and accepts a workout prescription (`{mode, intensity, phases?, packKg?}`). Auto-selects appropriate initial target. Subscribes to MotionTracker observations (P2). Optionally drives phase-aware cadence shifts during interval workouts (e.g., during a 5×800m, target ramps up to interval-pace cadence during the work phase and eases back during the recovery jog).
- **Tier:** T2
- **Justification:** Pure orchestration; tier inherited from P16 + P2 + P13/P13b inputs. Mode bounds enforced via underlying P16. Phase-aware target shifts use the registered pace-zone → cadence default mapping from F-METRONOME (registry §6); no new physics introduced.
- **Falsification:** Constructing the controller from a ruck prescription must produce only walk/ruck-bounded targets. Constructing from a run prescription must produce only run-bounded targets. Phase transitions during an interval workout must change the target spm (otherwise the phase-aware logic isn't doing anything).

### P15 PlanGenerator
- **Source:** `app.js`, class `PlanGenerator`
- **Contract:** Given an event specification `{mode, distanceM, weeksAvailable, daysPerWeek?, userVdot?, userPackKg?}`, produces a plan object structurally compatible with `COACHING_PLANS` entries. Operation is template-adaptive, not pure-generative:
  - Selects the closest hand-authored template by `mode` and `distanceM` using an **asymmetric** log-ratio metric: training UP from a shorter template (user goal > template distance) gets 2× the penalty of training DOWN. Rationale: a 10K target with a half-marathon template adapted shorter produces a better-prepared athlete than a 10K target with a 5K template stretched out. Envelope: ratio ∈ [0.4, 2.0] (mode invariant: run-event plans select only from run templates; ruck-event plans only ruck).
  - Scales the template's week count within ±25% of its natural length by repeating consolidation weeks (to lengthen) or compressing build weeks (to shorten).
  - Scales workout volumes by `userVdot / template_target_vdot` for run plans; by `packKg / template_pack_kg` for ruck plans. Volume scaling is bounded: factor clamped to [0.6, 1.4] so a very low VDOT user doesn't get 7-minute runs and a very high VDOT user doesn't get 3-hour easy runs from a beginner template.
  - Returns `null` if no template fits within ±25% week count, or if `mode` and `distanceM` together have no template (e.g. a 50-mile ruck doesn't yet have a base template).
  - The generated plan's `id` is `gen-{mode}-{distance}-{weeks}-{timestamp}` so PlanState's persistence layer can round-trip it.
- **Tier:** T2
- **Justification:** Template structure (build/peak/taper proportions, hard/easy alternation, weekly increment patterns) inherits directly from the hand-authored T2 templates (Cooper, Knapik, Pfitzinger). The scaling math is mechanically correct (multiply duration by a bounded factor; insert/drop consolidation weeks while preserving order). The *individual fit* is unmeasured — does week 4 of a generated plan actually correspond to where this user is in their training? That's empirical. So T2, not T1.
- **Falsification:**
  - Generated plan must validate against PlanState's expected schema (id, label, duration_weeks, weeks[][7]) — verified by `PlanState.fromJSON(generated.toJSON())` round-trip.
  - Mode invariant (refined): run-event plan contains zero ruck workouts (ruck loading is wrong stimulus for running adaptation). Ruck-event plan may contain easy run workouts as cross-training aerobic base (per Knapik 2004) but no hard runs (compromises ruck-specific adaptation). Cross-train workouts (mode=null) allowed in both.
  - Weekly **primary-mode** volume increment never exceeds 50% week-over-week. The "10% rule" cited in popular running literature is an industry myth: the hand-authored templates we build on (Knapik, Cooper, Pfitzinger) have intentional phase-transition jumps of 20-45%, which is part of how they work. Enforcing 10% here would reject the exact templates we depend on. The 50% ceiling catches catastrophic generator bugs (e.g., scaling factor applied twice) without rejecting legitimate periodization.
  - Hard sessions never scheduled on consecutive days within the same week.
- **Not enforced (and why we don't):**
  - **Specific "final week taper" rule**: The taper shape is template-specific. A 5K plan's event-week isn't a taper week in the same way a half-marathon's is (the event itself is short). The hand-authored templates encode appropriate taper for their event distance; the generator preserves their shape under scaling, which preserves whatever taper they had. Enforcing a single "≥25% reduction in final week" rule rejected both Cooper c25k (where W12 is the event week, not a taper week) and Knapik 12mi (where W8 IS the 12-mile test). The lesson: structural invariants must survive contact with the templates they validate.
  - **Specific "10% weekly increment" rule**: see above. Phase transitions in published plans routinely exceed 10%; the rule is folklore, not periodization.
- **Out-of-scope:**
  - Predicting race-time from generated plan. The plan targets an event; it doesn't promise a result.
  - Individual injury-risk prediction per generated workout. No validated thresholds.
  - First-principles generation without a template anchor. Reinventing periodization is the cargo cult risk we're explicitly avoiding.
  - HR-zone-primary prescription. Pace targets stay the anchor; HR is supplementary.
  - "Optimal" claims. We produce *plausible defensible* plans, not optimal ones for any individual.

### P18 CompletionDelta
- **Source:** `app.js`, class `CompletionDelta`
- **Contract:** Pure function. Given a workout record (from Workouts.list()) and the prescription it was started from, returns `{durationCompletionRatio, pacingDeltaSecPerMi, intensityFulfilled}`:
  - `durationCompletionRatio = workout.durationMs / prescription.targetDurationMs` (1.0 = exact, <1.0 = stopped short, >1.0 = went longer)
  - `pacingDeltaSecPerMi` = observed pace minus prescribed pace zone target (in sec/mi; negative = faster than prescribed, positive = slower)
  - `intensityFulfilled` = boolean, whether the user's observed pace falls within the prescription's intensity zone (with ±10% tolerance per Daniels)
  - Returns null if either input is malformed (freestyle workouts, missing distance, etc.)
- **Tier:** T1
- **Justification:** Literally a structural comparison of two numbers. No model assumptions. The math is observed/prescribed ratios; no inference about cause.
- **Falsification:** Identical observed and prescribed values must produce delta = 0 and ratio = 1.0. A workout 30% shorter than prescribed must produce ratio ≈ 0.7. A workout pace 30 sec/mi slower must produce pacingDelta ≈ +30.

### P19 AdaptationDecision
- **Source:** `app.js`, class `AdaptationDecision`
- **Contract:** Given `{recentDeltas, currentForm, formBaseline, prescription}`, returns one of:
  - `{action: 'continue', reason}` — no modification, plan as-is
  - `{action: 'ease_intensity', from, to, reason}` — soften the intensity tag one level (hard→moderate, moderate→easy). Never escalates.
  - `{action: 'reduce_duration', factor, reason}` — multiply prescribed duration by `factor` (clamped to [0.65, 1.0]); never extends.
  - `{action: 'continue', reason: 'insufficient_data'}` — if fewer than 3 recent completion deltas or no Form baseline exists
  - The decision can combine: a single response may carry both ease_intensity AND reduce_duration when warranted, but ease_intensity alone never escalates and reduce_duration alone never extends.
- **Tier:** T2
- **Justification:** Decision boundaries (e.g., "trigger ease when pace delta median +20 sec/mi AND Form z-score below -0.5") are heuristic. The math is correct; the *thresholds* are calibration choices not RCT-validated for individuals.
- **Falsification:**
  - Consistent positive pace delta (user slower than prescribed) AND Form z-score < -0.5 must produce ease/reduce action, not continue.
  - All-fast deltas + healthy Form must produce continue (NOT escalate; one-way easing only).
  - Empty recentDeltas must produce continue with reason 'insufficient_data'.
  - Action never produces from=easy, to=anything-harder (one-way easing invariant).
- **Out-of-scope:**
  - Generated coaching text. The reason field is short structural ("pace delta +25s/mi over 5 sessions, Form -1.2σ"), not prose advice.
  - HR-zone-driven adaptation. HR is lagged.
  - Predictive adaptation. The decision reads current state; it doesn't predict tomorrow's state.

### P20 RegistryInvariants (v1.8)
- **Source:** `app.js`, object `REGISTRY_INVARIANTS` plus class `RegistryInvariants`
- **Contract:** A structured catalog of cross-cutting invariants over the entire FORGE registry. Each entry has:
  - `name`: human-readable identifier
  - `claimedBy`: which primitive(s) or composition(s) make the claim
  - `check(state)`: pure function returning `{ok: boolean, violations: [...]}`
  - `severity`: 'hard' (build-fails) vs 'soft' (warns but doesn't fail)
- The runner `RegistryInvariants.runAll(state)` executes every registered check against the current module state, returning `{ok: boolean, results: [...]}`. The meta-test in the test suite verifies that every claimed invariant is exercised by at least one test.
- **Tier:** T1
- **Justification:** This primitive's behavior is mechanical — it walks a structured catalog and runs pure predicates. The predicates themselves inherit the tier of the claims they encode. The runner is T1 mechanically; what it RUNS has whatever tier the underlying claim has.
- **Falsification:** Deliberately introduce a violation of a registered invariant (e.g., insert a ruck workout into a run plan's weeks array). `runAll()` must return `ok: false` with that violation enumerated. Without such a check, the invariant catalog is theater.
- **Out-of-scope:**
  - Claiming "all bugs are impossible." This module makes a *named, scoped* class of bugs structurally impossible. UI rendering, platform quirks, and unobserved real-world patterns are outside its reach.
  - Replacing primitive-level validation. Each primitive still owns its own tests; this is an additional cross-cutting layer.
  - Static analysis. The checks run at test time / boot time, not at AST-parse time. JavaScript's type system doesn't enforce these structurally; we enforce them dynamically.

---

## §3 Composition rules and tier propagation

Each rule defines how primitives combine to produce a feature, and what tier the composition inherits. Tier propagation is **published, not negotiated**. A composition's tier cannot exceed the floor of its inputs.

### C-FILTER
- **Form:** `C-FILTER(input_stream, filter_module) → cleaner_stream`
- **Tier law:** `tier(output) = min(input.tier, filter.tier)`
- **Examples:** raw GPS → KalmanGPS → smoothed track. Forward Kalman states → RTSSmoother → smoothed-track.
- **Constraint:** filter must not modify the semantics of the stream (a "filter" that adds new events would be C-FUSE).

### C-FUSE
- **Form:** `C-FUSE(stream_a, stream_b, fusion_rule) → blended_stream`
- **Tier law:** `tier(output) = min(a.tier, b.tier, fusion_rule.tier)`
- **Examples:** GPS distance ⊕ PDR distance under outage → total distance. Pace ⊕ grade → GAP.
- **Constraint:** fusion_rule itself is a registered, tier-classified policy. Ad hoc fusion is not permitted.

### C-FALLBACK
- **Form:** `C-FALLBACK(primary, backup_chain) → "best available"_stream`
- **Tier law:** `tier(output) = tier(currently_active_source)`
- **Examples:** GPS available → PDR-only → DEGRADED → STATIONARY mode state machine. The tracking-mode chip in the live UI surfaces the *current* mode's tier, not a static claim.
- **Constraint:** mode transitions must be observable to consumers; silent fallback is forbidden.

### C-CALIBRATE
- **Form:** `C-CALIBRATE(raw_prediction, truth_observations) → calibrated_bound`
- **Tier law:** `tier(output) = min(raw.tier, truth_source.tier)`
- **Examples:** PDR drift error ⊕ GPS-truth-on-recovery → conformal radius. Observed stride at known distance → Bayesian posterior update.
- **Constraint:** truth_observations must come from a source whose tier is independently established (and named).

### C-EVENT
- **Form:** `C-EVENT(state_stream, threshold_predicate) → event_signal`
- **Tier law:** `tier(output) = tier(state)`
- **Examples:** distance ≥ goalDistM → goal-reached event. ACWR > 1.5 → high-risk event.
- **Constraint:** predicates must be one-shot (no repeated firing) unless explicitly registered as repeating.

### C-SCHEDULE
- **Form:** `C-SCHEDULE(plan_data, state_inputs, current_time) → "what to do now"`
- **Tier law:** `tier(output) = min(plan.tier, all state_inputs' tiers)`
- **Examples:** WOD rotation + history + ACWR → today's recommendation. Active coaching plan + day + completion-history → today's prescribed workout.
- **Constraint:** plan_data must be content with declared citations; ad hoc rules are not plans.

### C-PERSIST
- **Form:** `C-PERSIST(in_memory_state, serializer) → durable_state_across_sessions`
- **Tier law:** `tier(output) = tier(serializer)`
- **Examples:** BayesianStride → profile JSON. Conformal calibration set → profile JSON. Workout record → IDB.
- **Constraint:** serializer must have an inverse (round-trip-tested deserializer). If `_dirty=true` flags or memoized state require reconstruction post-load, the deserializer must do it. **(This is exactly the ConformalCoverage.fromJSON bug we caught — it failed to reset `_dirty`, silently producing wrong output. C-PERSIST's contract forbids this.)**

### C-ENTRAIN
- **Form:** `C-ENTRAIN(target_signal, observation, adjustment_policy) → cued_output`
- **Tier law:** `tier(output) = min(target.tier, observation.tier, policy.tier)`
- **Examples:** Cadence metronome — target_signal = pace-derived target spm, observation = MotionTracker's measured cadence, policy = "+5%/-5% bounded by published cadence ranges", output = audio beat stream.
- **Constraint:** The adjustment policy must have hard bounds on the target signal. Unbounded entrainment loops can drift into unsafe regions (e.g., a metronome could ramp to 250 spm if observation feedback is interpreted naively). The bound is part of the composition rule, not optional.
- **Constraint:** Closed-loop adaptation cannot fire faster than the underlying observation primitive can measure. If P2 MotionTracker takes 60s to converge on a cadence estimate, the C-ENTRAIN policy MUST NOT update the target faster than that window.

### C-COMPOSE-PLAN
- **Form:** `C-COMPOSE-PLAN(template_library, user_state, event_target, scaling_policy) → PlanState-compatible plan`
- **Tier law:** `tier(output) = max(tier(template_library), tier(user_state), tier(scaling_policy))` (worst component wins).
- **Examples:** PlanGenerator selects a template by event distance, scales weeks and per-workout durations to user VDOT, validates against schema invariants.
- **Constraints (must hold or rule refuses to ship a plan):**
  1. Mode purity: generated plan contains only workouts of the event's mode. The cross-cutting run/ruck invariant from §6 applies all the way through generation.
  2. Schema compatibility: generated plan must round-trip through PlanState.fromJSON(planObj.toJSON()) without mutation. PlanState is the authoritative consumer.
  3. Weekly progression bounds: week-over-week volume increment ≤ 12% (10% rule + 2% slack for build phases). Validated by walking the generated `weeks` array.
  4. Taper present: final 2 weeks have ≥25% volume reduction from peak week. Validated structurally.
  5. Hard-day spacing: no two hard sessions (intensity ∈ {tempo, hard, test}) on consecutive days within the same week.
  6. Bounded scaling: volume scaling factor clamped to [0.6, 1.4] of template defaults. Past this, the underlying template is the wrong starting point and the rule should refuse rather than produce a 3-hour beginner easy run.
- **Constraint on the scaling policy:** policy itself is heuristic (not RCT-validated), so its tier is T2 even when inputs are T1. This is the structural reason a generated plan's tier ceiling is T2.

### C-ADAPT
- **Form:** `C-ADAPT(F-PLAN.prescription, F-FFF.formScore, P18.completionDeltas, adaptation_policy) → modified prescription + provenance`
- **Tier law:** `tier(output) = max(prescription_tier, form_tier, delta_tier, policy_tier)`. With current primitives = max(T2, T2, T1, T2) = T2.
- **Examples:** Today's prescription is "Tempo 4mi". Recent 5 completions show consistent +25 sec/mi pace slower than threshold target. Current Form is 1.2σ below user's median. C-ADAPT replaces prescription with "Easy run, 32min" (ease intensity + reduce duration). Provenance: "eased due to pace delta +25s/mi over 5 sessions and Form -1.2σ".
- **Hard invariants (rule refuses any output violating these):**
  1. **One-way easing.** Adaptation never escalates intensity. easy is the floor; you cannot get from easy → moderate → hard via adaptation. The plan's prescribed hard work is the stimulus structure; the system can offer to ease it, not amplify it.
  2. **No rest-day removal.** Scheduled rest days are the plan's injury-prevention mechanism. Adaptation may NEVER convert a rest day into work (the F-PLAN-OVERRIDE v2 can convert work→rest, but adaptation cannot convert rest→work).
  3. **No compounding.** Adaptation reads CURRENT state fresh on every call. There is no accumulated "adaptation budget", "pace credit", or integral term that could drift unbounded over a multi-week plan. Each day's decision stands alone, derived from the last 7-14 days of completion history and the current Form score.
  4. **Bounded duration modification.** Duration scaling factor ∈ [0.65, 1.0]. Cannot extend prescribed duration; cannot reduce by more than 35%. Past 35% reduction, the prescription is effectively cancelled and F-PLAN-OVERRIDE should be the active rule (override to rest), not C-ADAPT.
  5. **Insufficient-signal default.** When recentDeltas has <3 entries or formBaseline is null, the rule returns 'continue' (plan as-is). No adapting from noise.
  6. **Provenance always attached.** Every adapted prescription carries a `meta` block: `{adapted: true, fromAction, fromIntensity?, factor?, reason}`. The user sees what was adapted and why. Silent modification of prescriptions would violate U.1 (honesty over engagement) from the universal error log.
- **Constraint on the adaptation policy:** policy itself is T2 (heuristic decision boundaries). This is the structural reason an adapted prescription's tier ceiling is T2 even when other components are T1.
- **Interaction with F-PLAN-OVERRIDE v2:** Adaptation runs FIRST (soft adjustment), then F-PLAN-OVERRIDE v2 may further convert work→rest if Form is severely depressed. The hierarchy is: ADAPT (ease intensity/duration) < OVERRIDE (full rest). A workout that's been eased by ADAPT can still be vetoed by OVERRIDE on the same day if Form drops sharply.

---

## §4 Existing features decomposed against the registry

Each currently-shipping feature is expressed as a composition. The composition's tier is the upper bound of any claim the marketing copy can make about it.

| Feature | Composition | Components | Tier |
|---|---|---|---|
| Live distance (GPS available) | `C-FILTER(rawGPS, P1)` | P1 | T1 |
| Live distance (during outage) | `C-FUSE(P1.last_state, P2 [stride-calibrated], outage_fusion_rule_v1)` | P1 T1, P2 T2, rule T2 | **T2** |
| Saved route map | `C-FILTER(C-FILTER(rawGPS, P1), RTSSmoother)` | both T1 | T1 |
| Position uncertainty radius | `C-CALIBRATE(P1.σ, P4.error_buffer)` | P1 T1, P4 T2 | **T2** |
| Grade-adjusted pace (GAP) | `C-FUSE(P1.velocity, smoothed_grade_from_P1+P5, Minetti_polynomial)` | P1 T1, P5 T1, poly T1, but grade-from-GPS is T2 | **T2** |
| Tracking-mode chip | `C-FALLBACK(P1, P2, DEGRADED, STATIONARY)` | varies per current mode | varies; UI shows the active tier |
| Per-user stride convergence | `C-CALIBRATE(P1.distance_over_window, P2.step_count_over_window)` persisted by `C-PERSIST(P3, JSON)` | P1 T1, P2 T2, P3 T2 | **T2** |
| Trail-snapped track (post-hoc) | `C-FILTER(saved_track, P10)` with OSM input | P10 T3 | **T3** |
| Goal-behavior toggle (v1.2) | `C-EVENT(distance, goal)` → branch on user pref | P9 T1 | T1 |
| Lock-screen presence | `C-PERSIST` analogue (registration with OS) | P11 T1 | T1 (registration succeeded), T2 (visible to user — depends on device state outside our control) |
| Workout-of-the-day (v0.8) | `C-SCHEDULE(rotation_template, history, P8)` | template T2, history T1, P8 T2 | **T2** |
| Heat-aware fuel coach | `C-SCHEDULE(fuel_rules, weather_fetch, packKg)` | rules T1, fetch T1 when network up, pack T1 | T1 when net available, falls to T2 offline |

---

## §5 Honest tier audit of past claims

Claims previously made in conversation or documentation, audited against the registry:

| Past claim | Actual tier per registry | Action |
|---|---|---|
| "Tier-4 PDR via Weinberg + ZUPT" | T2 (P2 + composition) | Downgraded |
| "Conformal 95% coverage guaranteed" | T2 | Documented as i.i.d.-only; field unverified |
| "SOTA tracking vs Strava/Garmin" | T4 — withdrawn | Comparison was never measured in the field. **Removed from claims.** |
| "Honest tracking mode" | T1 | Confirmed; surfaces actual mode |
| "Goal-behavior toggle deterministically tested" | T1 | Confirmed |
| "PDR drift 1-3% over 10 min outage" | T2 (synthetic) → would be T1 only after field measurement | Downgraded to "1-3% on synthetic injection tests" |

These downgrades are not failures. They are the discipline producing honest labels. The path to T1 SOTA-comparison claims goes through field measurement in v1.4+, not through marketing copy in v1.3.

---

## §6 v1.3 features under composition forcing

Each proposed v1.3 feature is decomposed against the registry. New primitives required are declared explicitly with their own tier and contract.

### F-DIAG: Diagnostics export
- **Composition:** `C-PERSIST(LiveWorkout.toRecord() ⊕ filterStats ⊕ modeTransitions ⊕ conformalScores, JSON-stringify)`
- **New primitives required:** None.
- **Tier ceiling:** T1.
- **Validation:** 10/10 synthetic workouts produce valid JSON matching schema, all required fields populated. (Note: this is structural validation; usefulness for debugging is a separate, longer-term observation.)

### F-ADAPT-UI: Adaptive UI baseline
- **Composition:** **Not a composition of registry primitives.** This is UI-infrastructure work.
- **Classification:** Outside the primitive registry. Lives in its own track.
- **Validation:** Visual regression at 6 form-factor cases (320×568, 414×896, 1024×1366 × portrait/landscape).
- **Honesty:** The composition forcing discipline does not legitimize UI quality claims via the tier system; UI quality is its own dimension.

### F-PLAN: Coaching plans
- **New primitive required:** P12 `PlanState`
  - **Contract:** Given (plan id, day, completion history), produces today's prescribed workout. Advances to next day on completion. Records skipped/compressed transitions.
  - **Tier:** T2 (provisional, structural correctness only — no claim about user race outcomes).
  - **Validation:** 15/15 simulated day-advancements across 3 plans × 5 days each.
- **Composition:** `C-SCHEDULE(plan_data, P12, currentDate)`
- **Tier ceiling:** T2.
- **Plan-data citations required for each plan:** Cooper progression (C25K), Knapik USARIEM (12mi ruck), Pfitzinger & Douglas (half marathon).

### F-PLAN-OVERRIDE: ACWR-aware plan override
- **Composition:** `C-FALLBACK(F-PLAN.prescription, P8 → rest_recommendation)`
- **Tier law application:** `min(F-PLAN.tier, P8.tier) = min(T2, T2) = T2`.
- **Tier ceiling:** T2.
- **Validation:** 10/10 synthetic cases (5 high-load fires override; 5 nominal preserves plan).

### F-PACE-ZONES: Personalized pace targets (v1.4)
- **Composition:** `C-FILTER(user_calibration_or_TT_history, P13)` for run mode, OR `C-FILTER(packKg + workout_history, P13b)` for ruck mode.
- **Tier ceiling:** T1 for run (P13 is T1, calibration is T1 mechanically), T2 for ruck (P13b is T2).
- **Validation:** 10 Daniels reference VDOTs match published values within ±1 sec/mi. Knapik standard pace at 35 lb matches 15 min/mi within ±5 sec/mi.
- **What this enables for F-PLAN:** Plan prescription cards now display the user's *personalized* target paces alongside each prescribed workout (e.g., "EASY RUN 30 MIN — your easy pace: 10:42/mi").
- **Run/ruck differentiation invariant:** P13 returns null for ruck mode; P13b returns null for run mode. The plan-card renderer routes to whichever returns non-null. **No silent cross-mapping is permitted.**

### F-METRONOME: Adaptive cadence cueing (v1.4)
- **Composition:** `C-ENTRAIN(F-PACE-ZONES.target_cadence, P2.observed_cadence, "+5% bounded" policy)` → audio beats via SoundCoach.
- **Tier ceiling:** `min(F-PACE-ZONES.tier, P2.tier, policy.tier) = min(T1 for run / T2 for ruck, T2, T1) = T2`.
- **Default policy:** Target = max(observed_cadence × 1.05, pace-appropriate floor); cap at observed_cadence × 1.10. Bounds: run mode 150-200 spm, walk/ruck mode 100-130 spm. Hard refuse to operate outside these. Adaptation fires no more than once per 60s window (matches P2's convergence time).
- **Pace-cadence mapping (run mode, evidence-grounded):**
  - Easy pace → target ~170 spm (or +5% from observed, whichever is higher)
  - Marathon pace → target ~175 spm
  - Threshold pace → target ~178 spm
  - Interval (5K) pace → target ~182 spm
  - Repetition pace → target ~185 spm
  These are *defaults*; the observed-cadence adaptation always wins when the user's natural cadence is in the same direction.
- **Pace-cadence mapping (ruck mode):** Pack weight scales the target. Light pack (<10 kg) → 120 spm. Standard pack (16 kg) → 115 spm. Heavy pack (20+ kg) → 110 spm. This reflects that heavier packs naturally produce shorter, slower stride cycles.
- **Validation:**
  - Tempo accuracy: 5 different target rates (160, 170, 180, 190, 200 spm), beat count over 60s within ±2 spm of target.
  - Bound enforcement: targets outside [150, 200] for run mode are clamped, not blindly accepted.
  - Adaptation rate-limit: rapid `adapt()` calls within 60s do not cascade (only the first call within the window takes effect).
  - Mode invariant: starting in run mode then receiving ruck-mode adapt() must produce a target in the walk/ruck range.
- **Explicitly out-of-scope:**
  - "180 spm always" preset
  - User-typed cadence target without bounds
  - HR-driven cueing
  - Form score derived from cadence alone

### F-FFF: Form / Fitness / Fatigue scoring (v1.5)
- **Composition:** `C-FILTER(Workouts.list, P14.compute)` — pure transformation.
- **Tier ceiling:** `min(history_tier, P14.tier) = min(T1, T2) = T2`.
- **Surface:** Replaces "READINESS" card on the home screen with a `{form, fitness, fatigue}` panel when ≥3 sessions exist; falls back to existing ACWR-based readiness card otherwise (preserving backward compatibility for new users).
- **Validation:** Banister single-load decay test, two-session-cancellation test, monotonicity (fitness rises after work, fatigue too; fitness decays slower than fatigue).

### F-PLAN-OVERRIDE v2: Form-aware plan override (v1.5)
- **Composition:** `C-FALLBACK(F-PLAN.prescription, F-FFF → rest_recommendation)` with fallback to ACWR-based override for users with insufficient history.
- **Tier law application:** `min(F-PLAN T2, F-FFF T2) = T2`.
- **Decision rule:** Rest override fires when `form < threshold_negative_form` AND prescription intensity is in {moderate, tempo, hard, test}. Threshold: form score below the user's own median form minus 1 standard deviation, OR raw form < -30 absolute. The user-relative threshold is the key improvement over raw ACWR — Form normalizes for the user's actual training base.
- **Backward compatibility:** When the user has <14 days of history (insufficient for FFF), F-PLAN-OVERRIDE falls back to v1's raw ACWR > 1.5 rule.
- **Validation:** Override fires on synthetic "spike then schedule hard" cases. Override does NOT fire on synthetic "consistent base then prescribed easy" cases. Override does NOT fire when history < 14 days regardless of load.

### F-WORKOUT-METRO: Prescription-driven metronome (v1.5)
- **Composition:** `C-ENTRAIN` through P17 MetronomeController, given a prescription `{mode, intensity, phases?, packKg?}`.
- **Tier ceiling:** Inherited from F-METRONOME = T2.
- **Prescription → initial target mapping (run mode):**
  - `easy` → 170 spm floor + adaptation
  - `moderate` → 175 spm floor + adaptation
  - `tempo` → 178 spm floor + adaptation
  - `hard` (intervals) → 182 spm floor + adaptation
  - `test` → 182 spm floor (race-pace cadence) + adaptation
- **Prescription → initial target mapping (ruck mode):** target = `MetronomeEngine.ruckDefaultForPack(packKg)`.
- **Phase-aware logic:** For workouts with `intervals` (work/walk alternation), the controller shifts the target on phase change: work phase uses the prescription's intensity floor, walk phase uses 'easy' floor. Phase changes are observed via the existing PacingPlan; no new event source introduced.
- **Validation:** Constructing controller from ruck prescription produces ruck-bounded targets. Construction from run prescription produces run-bounded targets. Phase transition during a synthetic interval produces a distinct new target.

### F-PLAN-GENERATE: Personalized plan synthesis (v1.6)
- **Composition:** `C-COMPOSE-PLAN(COACHING_PLANS template_library, user_VDOT_and_history, event_target, scaling_policy)` via P15 PlanGenerator. Optionally chains through C-PERSIST to commit the generated plan to PlanState's localStorage.
- **Tier ceiling:** `max(template_library T2, P13 user_state T1-or-T2, scaling_policy T2) = T2`.
- **Surface:** New "GENERATE PLAN" entry on the plans selection screen. User specifies (mode, distance, weeks-available, days-per-week); generator either produces a plan or returns a clean refusal with reason ("Closest template is 12 weeks; your 4-week target is outside ±25% scaling window. Pick an event ≥9 weeks out, or use a hand-authored plan.").
- **Provenance:** every generated plan carries `meta = {generated: true, templateId, scalingFactor, vdotAtGeneration, generatedAt}` so the user can see *which* template anchored their plan and what was adapted.
- **Validation:**
  - Generator produces null for impossible inputs (weeks count outside ±25%, mode without template).
  - Generated 8-week 5K plan structurally resembles c25k-12wk weekly cadence (3 sessions, 2-3 rest days).
  - Generated ruck plan contains zero run workouts; generated run plan contains zero ruck workouts.
  - Round-trip through PlanState.fromJSON works without data loss.
  - Weekly volume increment never exceeds 12% from previous week.
  - Final 2 weeks taper (≥25% volume reduction vs peak week).
- **Explicitly out-of-scope:**
  - Race-time prediction from the generated plan.
  - Plans outside the supported template envelope (50+ mi rucks, ultra distances, multi-day events).
  - First-principles generation. Every generated plan traces to a published template.
  - Per-session HR prescription as primary. HR remains supplementary.

### F-ADAPT-PLAN: Daily adaptive prescription (v1.7)
- **Composition:** `C-ADAPT(F-PLAN.today, F-FFF.formScore, P18.recentDeltas, adaptation_policy)` through P19 AdaptationDecision. The output is the adapted prescription rendered on the home WOD card with explicit provenance.
- **Tier ceiling:** `max(T2, T2, T1, T2) = T2`.
- **Surface:** WOD card on home screen. When adaptation fires, the card subtitle includes a small italic "eased: <reason>" line so the user sees what changed and why. Settings toggle "Adaptive prescription" defaults ON but can be disabled per session or globally.
- **Decision flow (per home-screen render):**
  1. PlanState.today() produces base prescription.
  2. F-ADAPT-PLAN reads (last 7 days of completion deltas, current Form, user baseline). Optionally returns adapted prescription.
  3. F-PLAN-OVERRIDE v2 still runs on the (possibly adapted) prescription. Hard intensity may still be vetoed entirely if Form drops sharply.
- **Provenance contract:** every adapted prescription carries `meta.adapted = true` plus the originating action and reason. The WOD-card UI surfaces this so the user can see when the system has modified their plan. NO silent adaptation.
- **Validation:**
  - User with no completion history → continue (insufficient signal).
  - User with consistent positive pace delta + low Form → ease/reduce action fires.
  - User with consistent fast deltas + healthy Form → continue (one-way easing invariant, no escalation).
  - Adaptation never converts rest → work.
  - User-disabled adaptation produces continue regardless of state.
- **Explicitly out-of-scope:**
  - Coaching text generation ("you should run easier today because..."). The provenance is structural; we don't produce prose advice.
  - Adapting based on a single workout. Three-session minimum for stable signal.
  - Adapting toward harder work. Pace was faster than prescribed AND Form is healthy → keep the prescription as-is. The plan's hard work is the stimulus; we don't amplify it ad hoc.
  - HR-driven adaptation. HR is lagged.
  - Predictive adaptation. The decision reads current state; it doesn't predict tomorrow's state.

### F-FORGE-GATE: Cross-cutting invariant runner (v1.8)
- **Composition:** P20 RegistryInvariants applied to the entire module state. Pure C-FILTER over a structured catalog.
- **Tier ceiling:** Inherits worst-case tier of any failed check, but the *runner itself* is T1.
- **Surface:** Test suite meta-section that executes every registered invariant. Build fails if any 'hard' invariant returns violations. Optionally exposed at boot via `RegistryInvariants.assertOnBoot()` for early detection of configuration drift.
- **Invariants enforced (initial catalog, expandable):**
  1. **Every primitive in PLAN_TEMPLATES has a corresponding entry in COACHING_PLANS.** Configuration drift would mean a generator could produce a plan id that PlanState can't resolve.
  2. **Mode invariant across COACHING_PLANS.** Every plan whose id starts with `c25k` / `half-marathon` / `10k-` / `marathon-` contains zero ruck workouts. Every plan whose id starts with `ruck-` / `12mi-ruck` / `6mi-ruck` contains zero HARD run workouts. Easy runs allowed in ruck plans (cross-training per Knapik).
  3. **Daniels VDOT table monotonicity.** For every VDOT row in DANIELS_PACE_TABLE, zone paces must be ordered easy > marathon > threshold > interval > repetition (sec/mi, larger = slower). For every column, faster VDOTs must have faster paces.
  4. **Knapik baseline consistency.** RuckPaceTargets.compute at packKg=16 must return standard pace within ±5 sec/mi of 900 (Knapik baseline). This catches accidental edits to the underlying constants.
  5. **Metronome bound disjointness.** MetronomeEngine.MODE_BOUNDS for run and walk_ruck must not overlap. The cross-cutting run/ruck invariant requires this structurally.
  6. **Intensity ladder consistency.** Every intensity used in PLAN_WORKOUTS (excluding rest) must be present in INTENSITY_LADDER. P19 AdaptationDecision walks the ladder; a workout with an unknown intensity would cause silent skip.
  7. **Banister constants present.** FFF_TAU_FITNESS_DAYS, FFF_TAU_FATIGUE_DAYS, FFF_FORM_K must be defined with the published values (42, 7, 2.0). Catches accidental override.
  8. **PLAN_WORKOUTS schema completeness.** Every entry must have {label, description, mode, durationMin, intensity}. Catches accidental field omission when adding new workouts.
- **What this composition explicitly does NOT claim:**
  - "All bugs are impossible." The gate makes a *named, scoped* class of bugs structurally impossible. UI rendering, platform-specific quirks, and unobserved real-world patterns remain outside its reach. This is documented in P20's contract.
  - Static type safety. JavaScript's type system doesn't enforce these structurally. Enforcement is dynamic (test-time / boot-time), not compile-time.
  - Replacing primitive-level validation. Each primitive still owns its own tests. F-FORGE-GATE is an additional cross-cutting layer, not a substitute.

### Run/ruck differentiation (cross-cutting invariant)
- All pace-related and cadence-related primitives MUST honor mode. The registry forbids any composition that:
  - Returns running pace zones for ruck inputs
  - Returns ruck pace targets for run inputs
  - Drives a run-cadence metronome during a ruck workout (and vice versa) without explicit user override
- This invariant is testable: `expect(P13.compute({ mode: 'ruck', ... })).toBe(null)`, `expect(P13b.compute({ mode: 'run', ... })).toBe(null)`.

---

## §7 The discipline going forward

For every future change to the app:

1. **Express the change as a composition of registered primitives** using a registered composition rule. If you can't, you have either UI-infrastructure work (separate track) or a new primitive that needs its own validation cycle before it enters the registry.

2. **Compute the tier ceiling from the registry.** Marketing copy, README claims, and user-facing labels are bounded by this number.

3. **Update the registry whenever:**
   - A primitive's tier changes (e.g., field measurement upgrades P2 from T2 to T1)
   - A new primitive is admitted (with its contract, tier, and justification)
   - A new composition rule is registered (with its tier-propagation law)
   - A new feature is shipped (decomposed against the registry, with citations where required)

4. **Lint enforces the registry.** A test in `test-e2e-rigorous.cjs` walks the registry, verifies each documented composition resolves to known primitives, and fails if any feature in the shipped UI references unregistered components.

5. **Bug attribution falls into one of two categories:**
   - **Primitive contract violation** — a primitive failed to deliver what its contract promised. Fix the primitive. Add a test that asserts the contract.
   - **Composition rule violation** — the integration code failed to honor the composition rule's invariants. Fix the integration. Add a test that asserts the rule's constraint.

Past bugs categorized retroactively:

| Bug | Category | Lesson |
|---|---|---|
| `lw.stop()` called when method is `lw.end()` | Primitive contract violation — LiveWorkout interface | Lint that asserts named methods exist |
| 5-min test failure: synthetic time vs real `Date.now()` | Composition rule violation — clocks not unified across composition boundary | Test harness asserts time-source consistency within a tick |
| Lock-screen worked on iPhone 17 not 16 | Primitive contract violation — P11 was swallowing failures instead of reporting them | P11 contract now requires `failureReason` to be set; verified by test |
| GAP changed wildly | Sub-primitive contract violation — grade computation had no stdev contract | Grade computation now declares stability contract (smoothed, bounded window) |

---

## §8 What this registry deliberately does NOT do

- It does not validate algorithms. Weinberg's model has the accuracy it has. The registry forces honest labeling of that accuracy.
- It does not replace real-device testing. Field tests are how primitive tiers move from T2 to T1.
- It does not cover UI quality. Adaptive UI is its own track.
- It does not catch performance regressions. Tier system is about correctness, not latency.
- It does not prevent product-market disagreements. Users may not want what the registry permits us to promise. Product-design discussion is separate.

---

## §9 One-sentence standard

> A claim about the app cannot be made unless it decomposes into the registry, and its tier cannot exceed the floor of its components. New primitives pay for themselves through their own validation cycle. Anything else is marketing.
