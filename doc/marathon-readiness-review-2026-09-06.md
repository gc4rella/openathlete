# Marathon readiness and free data imports

Reviewed 6 September 2026 against the current working tree, including the uncommitted adaptive-coach implementation. This is a software and training-workflow review, not an assessment of the athlete's personal marathon readiness.

**Verdict: promising training diary and planning foundation; not ready to rely on as the primary automatic marathon coach.** The most serious problems are in the connection between imported history, pace prescription, scheduling and automatic adaptation. Compilation and the existing tests pass, but they do not cover these integration failures.

## What is already present

- Calendar, structured workouts, planned/actual activity linking, RPE feedback, records, training-load charts and athlete metrics.
- A deterministic running-plan generator, separate from optional paid AI prose generation. The core generator does not require an LLM call.
- Marathon-specific periodization, long-run variants, recovery weeks, a taper, pace targets, availability input and injury-aware rules.
- Plan preview, persistence, lifecycle status, adjustment history and EN/FR/IT translation keys.
- Provider integration code for Strava, Garmin, Polar and Suunto, and reusable FIT/GPX stream parsers. These are implementation assets, not evidence that credentials, approvals or live sync work on this instance.

## Findings to fix before depending on the planner

### 1. P1 — Imported running records use the wrong unit when resolving fitness

`apps/api/src/modules/core/helpers/record.ts:243` stores a SPEED record as normalized **elapsed seconds over the distance**. `apps/api/src/modules/coach/services/plan-generation.service.ts:248` instead treats that value as meters/second and computes `distance / value`.

Confirmed with a synthetic GPS run passed through the real record calculator and the service's conversion: a 45-minute 10 km record is stored as approximately 2700, then becomes a **3.70-second 10 km effort**. The physiology filter rejects it, so actual running history is discarded and fitness falls back to a device metric, the desired finish time, or a default. Existing engine tests supply correctly formed efforts directly and miss this boundary.

Fix the unit contract and add an import-to-fitness regression test. Also filter records by running sport and actual activity date: `fetchBestEfforts()` does not restrict sport, while `apps/api/src/modules/queue/processors/activity-import.processor.ts:132` timestamps records with import time. Otherwise old or cycling performances can become apparently recent running evidence once the unit bug is fixed.

### 2. P1 — Zero baseline and aspirational goals can produce unsupported prescriptions

`apps/api/src/modules/coach/engine/periodization.ts:241` treats both missing history and an explicit zero as the marathon default of four hours/week. A reproduced five-day plan with zero baseline starts with 240 minutes, including an 80-minute long run and a 45-minute fartlek.

`apps/api/src/modules/coach/engine/physiology.ts:288` can infer fitness from the goal alone, and `vdotForProgress()` interpolates toward the desired fitness without requiring evidence of improvement. `apps/api/src/modules/coach/engine/index.ts:83` calculates the displayed prediction using goal VDOT whenever present. A runner with a 45-minute 10 km and a requested two-hour marathon receives a displayed two-hour prediction. This is the requested outcome being echoed, not an independent forecast.

Require a usable baseline or an explicit base-building path, preserve zero as zero, provide effort-based targets when fitness is unknown, separate goal from forecast, and warn when the available preparation time or training capacity cannot support the plan. Recent longest run and training consistency should inform the starting long run.

### 3. P1 — Race week overrides injury restrictions

`apps/api/src/modules/coach/engine/week-builder.ts:509` unconditionally turns race-week allocations into easy running and adds a running race after injury handling has selected cross-training.

Reproduced with pain 8/10 and WORSENING status: earlier weeks use cross-training, but the last week contains a 210-minute running race and four 20-minute easy runs. Preserve injury policy through race-week construction and surface an explicit decision about participation instead of silently restoring impact.

### 4. P1 — Automatic adaptation compounds and is not phase-aware

`apps/api/src/modules/coach/services/plan-adaptation.service.ts:550` scales the current session again on every evaluation. There is no persisted signal/version check preventing repeat application. A mocked persistence reproduction using the real service reduced one 60-minute session to 48, 38.4, then 30.7 minutes on three identical low-completion evaluations. Activity imports emit evaluation requests individually, including historical-import processing.

The decision has no recovery/taper/race-phase input, so a deliberately low taper load can trigger an increase. Race sessions are persisted as ordinary TRAINING events (`plan-materialization.service.ts:283`), and the adaptation query does not exclude them: race distance and duration can be resized as if they were a workout. The race also does not enter the app's COMPETITION-based upcoming-races view.

Make adaptation idempotent, coalesce backfill events, evaluate against a stable plan baseline, protect taper/recovery intent, and represent the goal race explicitly. Keep the race's distance/date fixed while allowing an explicit cancellation or participation change when necessary.

### 5. P1 — Weekly scheduling and manual-edit protection are incomplete

The Sunday 20:00 scheduler calls `adaptPlan()`, which selects the first week whose **end** is after now (`plan-adaptation.service.ts:163`). For a Monday–Sunday plan, this is the week about to finish, typically with no workouts left after 20:00, rather than the next week. Reproduced the selected week ID with the real service and mocked persistence.

The adaptation query excludes `manuallyEdited: true`, but ordinary calendar edits in `apps/api/src/modules/core/services/event.service.ts:391` do not set that flag. Only the new chat session-management tool sets it. Consequently edits made through the normal calendar remain eligible for automatic alteration.

Separate immediate current-week reactions from next-week planning, and mark athlete edits consistently across every editing entry point.

### 6. P1 — Calendar dates depend on the server timezone

The wizard constructs browser-local midnight dates (`apps/web/src/components/training-plan-wizard/training-plan-wizard.tsx:123`). Materialization and race-day selection then use server-local `getDay()`/`setHours()` methods.

Reproduced under `TZ=UTC`: Berlin Monday 7 September 2026 at midnight arrives as `2026-09-06T22:00:00Z` and is normalized to **Sunday 6 September at 00:00 UTC**. A Berlin Sunday race date in December is read as Saturday on that server. Calendar-day arithmetic helps DST within one timezone but does not solve browser/server timezone differences.

Store date-only plan/race values and the athlete's IANA timezone, then resolve scheduled instants explicitly. Cover both differing client/server zones and DST crossings.

### 7. P2 — Availability is a preference, not a scheduling constraint

`chooseTrainingDays()` can add undeclared days; allocation does not cap sessions to available time windows (`apps/api/src/modules/coach/engine/week-builder.ts:123`, `:293`). Materialization chooses the earliest start window without checking whether it fits the workout.

Reproduced with only Sunday/Tuesday/Thursday 07:00–07:30 windows and five requested training days: the plan scheduled Monday and Saturday too, and assigned 35–80-minute workouts. With two requested days, the example's designated long run was 80 minutes but the other workout was 120 minutes, while only 200 of the nominal 240 weekly minutes were scheduled.

Reject or explain incompatible frequency/time inputs; fit each session into one real window; recompute displayed totals from actual sessions; constrain the resulting weekly structure rather than only its target volume.

### 8. P2 — Plan status does not isolate calendar or watch workouts

Materialization creates ordinary calendar events even for DRAFT plans. The event-list query (`apps/api/src/modules/core/services/event.service.ts:215`) and daily watch-export query (`apps/api/src/modules/providers-sync/scheduler.service.ts:113`) do not filter training-plan status. Archiving a plan updates its status without removing its future sessions from those queries.

Therefore a saved draft or replaced plan can contribute extra calendar/watch workouts. Make activation and replacement atomic, and consistently filter or deactivate sessions from drafts and archived plans while preserving completed history.

### 9. P2 — Adaptation can disagree with the workout sent to the watch

`plan-adaptation.service.ts:611` scales TIME steps at the top level only. Interval repeats use an OPEN parent with timed child steps (`apps/api/src/modules/coach/engine/session-templates.ts:140`). Those child steps are not loaded or resized by this path. The session summary can become shorter while the interval block stays unchanged.

Scale the full workout tree, preserve appropriate recovery, and recompute duration, distance and load from the resulting structure. Keep the description and sport-specific targets consistent when downgrading or changing sport.

## Marathon product improvements after the correctness fixes

- A race-focused home screen: weeks remaining, this week's running distance and time, planned versus completed sessions, next key workout and long-run progression.
- A baseline review before plan creation: enough imported history, recent longest run, frequency, recent race/time trial, interruptions, and confidence in pace estimates. The existing eight-week volume calculation divides all available history by eight even if only one week has been imported.
- Explain when the generated plan is insufficient for the chosen objective. The reference 16-week, four-hour baseline, five-day fixture peaks at approximately 110 minutes for the designated long run. This is a concrete output to review against the athlete's needs, not proof of adequate marathon preparation.
- Fueling/hydration practice attached to long runs, race-day rehearsal notes, strength sessions, and recovery check-ins. These are not integrated into the current deterministic marathon schedule.
- A full session-level preview with actual dates, time/distance, intensity and recovery. The current wizard preview mainly shows phases, a volume bar chart and fitness-source badges.
- Treat load ratios as supporting indicators, and show missing-data/confidence states instead of treating a number as proof of readiness.

## Free import options

These are provider export paths verified against official documentation on the review date. **The exported files cannot yet be uploaded through a general activity-import screen in this checkout.** There are reusable FIT/GPX parsers behind provider sync, but no general FIT/TCX/GPX/ZIP activity-upload endpoint or UI was found. TCX and Apple Health XML need additional parser support.

| Source | No-subscription file path | Automatic sync / current app caveat |
| --- | --- | --- |
| Garmin Connect | Export Original, usually FIT, from an activity; account data export for history. [Garmin instructions](https://support.garmin.com/en-IN/?faq=W1TvTPW8JZ6LfJSfK512Q8). | Existing connector code requires approved credentials. Garmin says the developer program has no general licensing/maintenance fee but is for business use; some metrics can incur fees. It is not an assured personal self-hosting route. [Garmin API FAQ](https://developer.garmin.com/gc-developer-program/program-faq/). |
| Strava | Website → activity → Export Original, or Settings → My Account → Download your account → Request download. [Strava instructions](https://support.strava.com/en-us/articles/15401919-exporting-your-data-and-bulk-export). | Existing connector code supports activity import. Current developer docs require a Strava subscription to create an API application, so a new personal API integration is not zero-cost. This requirement concerns app creation, not a blanket claim about all users of existing integrations. [Strava developer guide](https://developers.strava.com/docs/getting-started/). |
| COROS | Training Hub → Activity List → Export Data → FIT/TCX; bulk history delivered by email. [COROS instructions](https://support.coros.com/hc/en-us/articles/33125636125204-Bulk-Export-Historical-Activity-Data). | Do not rely on the advertised integration here: the OAuth service has empty credentials and the activity queue has no COROS import branch. |
| Polar Flow | Diary → session → Export → FIT/TCX/GPX/CSV. [Polar instructions](https://support.polar.com/us-en/export-training-sessions-flow). | Strong candidate for free ongoing sync: Polar describes AccessLink as a free API and allows Flow users to register a client. Its exercise API only returns uploads from the last 30 days made after registration with that client. Existing app code's “full import” is also a 30-day window, not a full historical archive. [Polar API introduction](https://www.polar.com/blog/introducing-polar-open-accesslink-api/), [current API documentation](https://www.polar.com/accesslink-api/). |
| Suunto | Export a workout as FIT from the app; FIT preserves more workout information than GPX. [Suunto instructions](https://us.suunto.com/pages/what-type-of-files-can-i-export-from-the-suunto-app). | Existing connector code still needs provider credentials and live verification; file export avoids that dependency. |
| Apple Watch / Apple Health | Health → Summary → profile → Export All Health Data, producing XML data. [Apple instructions](https://support.apple.com/en-euro/guide/iphone/iph5ede58c3d/ios). | No implemented HealthKit bridge or Apple Health archive importer found. Native HealthKit reading could make ongoing sync easier with user permission, but would be additional iOS development, not a browser integration. [Apple authorization documentation](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data). |

For zero subscription cost, prioritize **direct device/app export → local import**. Prefer FIT when available, then TCX; accept GPX as a fallback with a clear indication of which streams/laps are missing. Activity files do not necessarily include daily sleep, HRV, resting HR or other recovery metrics.

Do not require a paid synchronization intermediary. Self-hosted software and deterministic planning can avoid subscription/API charges, but new hosting or optional AI calls are separate costs; use existing hardware and skip AI for a strict zero-additional-spend setup.

## Recommended implementation order

1. **Correct the planner before enabling automatic coaching:** record units/sport/date, baseline validation, goal versus prediction, race injury behavior, timezone correctness, idempotent and phase-aware adaptation, manual-edit protection, and plan-status isolation.
2. **Build one universal activity importer:** drag/drop multiple FIT/TCX/GPX files and ZIP archives; preview dates/sports/totals; preserve elapsed versus moving time, sensor timestamps, laps and provenance; report malformed files individually; track progress and permit retry. Reuse the current parsers and downstream calculations after verifying their missing-sample behavior.
3. **Make repeat imports safe:** scope provider IDs to athlete/provider, fingerprint files, identify the same workout arriving from a watch and Strava, and merge richer data rather than doubling mileage. Current storage has a global `externalId` uniqueness constraint, not a cross-source identity model.
4. **Recompute history once after a batch:** records and recent load must use activity dates; suppress per-file automatic plan resizing during backfill; expose the history span and missing-data confidence before creating a plan.
5. **Add the source-specific convenience path:** Polar AccessLink if using Polar; Apple Health ZIP first and native HealthKit later if using Apple Watch; existing approved Garmin/Suunto connections where available. Make provider setup/capabilities explicit in settings.
6. **Add marathon-specific execution support:** clear weekly distance, progressive long-run review, fueling rehearsal, strength, recovery and race-week views.

## Validation performed and limits

- `pnpm --filter @openathlete/api exec jest --runInBand`: **5 suites, 85 tests passed**.
- `pnpm --filter @openathlete/api --filter @openathlete/web tsc:check`: **passed**.
- `pnpm --filter @openathlete/api build`: **passed**.
- `pnpm --filter @openathlete/web build`: **passed**, with existing large-chunk and mixed static/dynamic import warnings.
- `node scripts/check-locale-parity.js`: **passed**; this checks key parity, not translation quality.
- Ran isolated synthetic checks through actual engine/service functions for record conversion, zero baseline, impossible goal prediction, limited availability, two-day allocation, race-week injury behavior, repeated adaptation, Sunday week selection and UTC/Berlin date interpretation. Service persistence was mocked; no athlete data was created or changed.
- Did not verify authenticated end-to-end UI flows, database migration state, real wearable imports, watch exports, or mobile/theme behavior. Passing builds and unit tests do not establish those behaviors.
- Application code and existing uncommitted work were left unchanged. This report is the only authored repository addition.
