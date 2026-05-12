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
