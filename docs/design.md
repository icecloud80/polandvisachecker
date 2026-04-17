# Design Document

## 1. Architecture

- `src/chrome-cli.js`: the primary v1 entrypoint for `doctor`, `check`, `debug`, `collect-captcha`, and `diagnose-refresh`
- `src/launchd.js`: bundle generator for a 2-hour macOS `launchd` wrapper around the single-run checker
- `scripts/run-check-every-90-seconds.sh`: foreground shell helper that reruns the single-run checker every 90 seconds until the terminal session stops it
- `scripts/run-check-every-2-minutes.sh`: compatibility wrapper that forwards the old command name to the current 90-second helper
- `scheduler/`: tracked home for generated `launchd` install files, distinct from ignored runtime `artifacts/`
- `data/`: tracked home for the consolidated captcha image library, label manifest, and training export directory
- `model/`: tracked home for the current local captcha model and evaluation reports
- `src/captcha-labeler.js`: lightweight local web server that turns `labels.json` into a one-image-at-a-time labeling UI
- `src/captcha-suggest.js`: batch local-model suggester that fills `ocrText` for unlabeled captcha entries
- `src/captcha-training.js`: training export tool that validates confirmed labels and writes a stable train/val/test dataset
- `src/captcha-train-local.js`: pure-Node local trainer that decodes PNG captcha images, builds a hybrid classifier, and writes evaluation artifacts
- `src/captcha-analyze.js`: holdout-oriented analyzer that reads the current model artifacts and prints confusion, position, serif hard-case, symbol, and 5-attempt metrics
- `src/chrome-bridge.js`: AppleScript bridge that opens Chrome tabs and executes page JavaScript
- `src/chrome-page.js`: in-page DOM runtime for captcha detection, dropdown selection, and availability reading
- `src/chrome-utils.js`: shared captcha heuristics, bridge helpers, and snapshot normalization
- `src/status.js`: pure availability inference from page signals
- `src/notifier.js`: positive-hit local alert fan-out for desktop notification, terminal bell, speech, and webhook channels
- `test/*.test.js`: unit tests for inference, bridge helpers, and page-runtime source generation

## 2. Execution Flow

1. `check` loads config and ensures `artifacts/` exists.
2. The CLI opens real Chrome to `https://secure.e-konsulat.gov.pl/`.
3. The CLI switches the yellow top-bar `Wersja językowa / Language version` dropdown to `English`, opens `U`, then opens `United States of America`.
4. The CLI opens `Consulate General of the Republic of Poland in Los Angeles`, then `Schengen Visa - Register the form`.
5. The CLI verifies that Apple Events JavaScript is available in Chrome.
6. The page runtime snapshots the current state.
7. If the page is at captcha:
   - capture captcha image
   - capture an alternate processed captcha image in the page runtime
   - save image to `artifacts/`
   - run the local hybrid model against the available captcha variants first
   - evaluate distance, segmentation quality, and overall confidence
   - submit the best local-model guess only when it passes the quality gates
   - if the captcha is rejected, capture the refreshed image and retry automatically
   - fill the captcha input and click `Next`
8. If captcha success returns to the registration home, reopen the English homepage flow and re-enter the Los Angeles Schengen registration page.
9. If the page is at the selection step, the runtime selects:
   - `Type of service = Schengen Visa`
   - `Location = Los Angeles`
   - `I want to reserve a date for = 1 person`
10. The CLI writes a `post-captcha-before-selection` artifact once captcha is cleared.
11. The runtime reads the `Date` control and the reserved-message area.
12. The CLI writes a `post-captcha-after-selection` artifact with field diagnostics and selection action results.
13. `src/status.js` converts those signals into the final status object, including a body-text fallback for the final Polish no-slot sentence.
14. The CLI prints compact JSON and sends a positive-hit local alert only if dates are available.
15. The CLI prints one final Chinese summary line after the JSON: `有预约时间` or `没有预约时间`.
16. If the command is `collect-captcha`, the CLI saves captcha samples and a blank labeling manifest instead of submitting the form.
17. If the command is `diagnose-refresh`, the CLI runs refresh-only attempts, records before/after evidence, and writes a structured summary for Phase A analysis.
18. If the command is `captcha:label`, the local labeler selects the latest dataset, opens a tiny browser UI, and saves each `expectedText` update back into `labels.json`.
19. If the command is `captcha:suggest`, the local-model suggester scans unlabeled entries, writes `ocrText` and confidence metadata into the manifest, and leaves human confirmation to the labeler.
20. If the command is `captcha:prepare-train`, the training exporter validates the manifest, copies images into a training directory, assigns deterministic splits, and writes summary plus JSONL files.
21. If the command is `captcha:train-local`, the local trainer rebuilds the training directory, decodes PNG captchas, extracts 4 glyph vectors per image, trains a hybrid character model from the train split, and writes summary plus per-split prediction reports.
22. If the command is `captcha:analyze`, the analyzer reads the latest model artifacts and reprints holdout confusion, serif hard-case, position, symbol, and 5-attempt metrics.
23. If the command is `schedule:launchd`, the generator writes a shell script, a `.plist`, and an `INSTALL.md` guide into `scheduler/` so macOS can call the single-run `check` every 2 hours.
24. If the operator runs `scripts/run-check-every-90-seconds.sh`, the shell helper changes into the project root, runs one `npm run check`, and sleeps only the remaining seconds needed to keep an approximately 90-second cycle.
25. If the operator runs the older `scripts/run-check-every-2-minutes.sh` path, the wrapper immediately `exec`s into the new 90-second helper so existing habits keep working.

## 3. Rule Mapping

- Rule: the tool should only support the Los Angeles Schengen flow.
  Design: the bridge always starts from the e-Konsulat homepage, switches to English, opens the `U -> United States of America -> Consulate General of the Republic of Poland in Los Angeles -> Schengen Visa - Register the form` chain, and only then continues into the existing captcha flow.

- Rule: recurring execution should wrap the single-run checker instead of introducing a separate watch loop.
  Design: `src/launchd.js` generates a macOS `launchd` bundle whose shell script runs exactly one `src/chrome-cli.js check` per trigger.

- Rule: the user may want repeated execution in the current terminal without installing background scheduling.
  Design: `scripts/run-check-every-90-seconds.sh` provides a foreground loop that stays user-visible, keeps the cadence near 90 seconds, and exits naturally on `Ctrl-C`, while the older `run-check-every-2-minutes.sh` path remains a compatibility wrapper.

- Rule: post-captcha selection should only fill the three variable dropdowns.
  Design: the CLI no longer selects country or office after captcha.

- Rule: the exact Polish reserved message must be recognized.
  Design: the page runtime matches the Polish sentence directly and preserves the matched text in the snapshot.

- Rule: real selectable dates outrank message text.
  Design: `inferAvailability` returns `date_options_present` before evaluating reserved-message text.

- Rule: `check` should not block on manual captcha correction.
  Design: the CLI stays fully automated, either by submitting a 4-character OCR candidate or by refreshing the captcha and continuing to the next attempt.

- Rule: the CLI should only submit 4-character captcha candidates.
  Design: when OCR still cannot resolve 4 characters after raw and processed retries, the CLI clicks refresh instead of submitting a blank or noisy value.

- Rule: captcha refresh must behave like a real visible button activation.
  Design: the page runtime now uses the same stronger mouse-event sequence for `Odśwież` that it already uses for custom control triggers, instead of relying on `element.click()` alone.

- Rule: visible labels may sit inside nested button wrappers.
  Design: a shared page activation helper now triggers both the matched node and its nearest actionable ancestor so Material-style wrappers can still react to `Odśwież` and `Next`.

- Rule: some captcha refresh actions may require a real user gesture.
  Design: when DOM refresh leaves the captcha signature unchanged, the CLI asks the page runtime for the refresh button screen point and sends a macOS-level mouse click through a bridge fallback.

- Rule: refresh failures must be diagnosable from artifacts instead of terminal logs alone.
  Design: Phase A now has a dedicated `diagnose-refresh` mode that stores per-attempt JSON, button metadata, and before/after captcha images under an isolated run directory.

- Rule: a visible refresh label may live on a non-button node while the real click target sits on an ancestor wrapper.
  Design: the page runtime now enumerates all visible nodes whose searchable text matches the refresh pattern, records their actionable ancestors, and exposes click points for diagnostic fallback.

- Rule: if refresh-pattern matching returns nothing, diagnostics still need to reveal what the page considers actionable.
  Design: the refresh diagnostic payload now includes a raw dump of visible actionable controls, their search texts, and click points so pattern mismatches can be analyzed offline.

- Rule: live Material button markup may duplicate visible labels or emit Unicode variants that still look identical to the operator.
  Design: button-text matching now evaluates multiple normalized variants, including diacritic-stripped and duplicate-word-collapsed forms, before giving up on a clickable target.

- Rule: symbol-bearing captcha strings are valid business inputs.
  Design: OCR cleaning removes whitespace and control noise only, while preserving visible symbols such as `@`, `+`, and `=`.

- Rule: OCR should target a fixed 4-character captcha result.
  Design: Node-side OCR first extracts exact 4-character candidates from the raw output and only then falls back to shorter or sliced candidates.

- Rule: normal operation should produce compact output.
  Design: `check` prints only the compact status JSON, while `debug` prints the full normalized snapshot.

- Rule: positive-hit desktop notifications should be readable at a glance by the local operator.
  Design: `src/notifier.js` emits concise Chinese notification copy for local alerts and reused webhook payloads, while macOS local delivery now layers notification sound, terminal bell, and optional speech on top of the same payload.

- Rule: the live site entry path should match the visible English UI instead of assuming a stale deep link.
  Design: `src/chrome-cli.js` now drives a small sequence of homepage actions, while `src/chrome-page.js` exposes dedicated runtime actions for switching the language dropdown, clicking the `U` filter, and resolving the country / consulate / registration href targets.

- Rule: the homepage language dropdown must still be found when the top-bar label is visually present but not cleanly attached to the DOM control.
  Design: `src/chrome-page.js` now explicitly locates the yellow top-bar `Wersja językowa / Language version` dropdown, including the live `mat-select / role="combobox"` markup, scores it with layout and language-option evidence, and then switches that exact control to `English`.

- Rule: entry links must still work when the live Angular list renders `<a href="">` placeholders instead of concrete URLs.
  Design: `src/chrome-page.js` now treats country / consulate / registration links as dual-mode actions: inspect the raw anchor `href` attribute, use a real href only when that raw attribute is non-empty, otherwise trigger the matched clickable element inline and let `src/chrome-cli.js` wait for the route change.

- Rule: clicking an empty-`href` Angular entry must not reopen the current page.
  Design: `src/chrome-page.js` now detects placeholder anchors and skips the native `.click()` call for them, while still dispatching the synthetic pointer / mouse events that Angular handlers rely on.

- Rule: list-style country and consulate pages must click the exact matched row instead of the first link inside a broad container match.
  Design: `src/chrome-page.js` now ranks navigation candidates by tighter text / area heuristics and only falls back to descendants that also match the requested pattern, so `UNITED STATES OF AMERICA (14)` does not collapse to an unrelated sibling link.

- Rule: entry navigation should not continue until the next page has actually exposed the expected evidence.
  Design: `src/chrome-cli.js` now polls for consulate / registration / captcha evidence after each homepage navigation step, and if an inline click still does not advance the page, it retries once with a real pointer click using the target element's screen coordinates.

- Rule: a homepage click that lands directly on a later valid page should still count as successful progress.
  Design: `src/chrome-page.js` now lets each entry evidence action accept fallback downstream patterns plus specific `readAvailability()` reasons such as `registration_home`, `captcha_step`, `selection_step`, `all_dates_reserved`, and `date_options_present`, so `src/chrome-cli.js` does not reject flows that skip an intermediate page.

- Rule: once the page has already advanced to a valid downstream state, later stale entry clicks should be skipped instead of retried as hard failures.
  Design: `src/chrome-cli.js` now prechecks expected entry evidence before each country / consulate / registration action, and when a target cannot be resolved it rechecks the same evidence once more before throwing, so fast or self-refreshing transitions do not break the flow.

- Rule: the homepage language dropdown must never be mistaken for a post-captcha appointment-form dropdown.
  Design: `src/chrome-page.js` now removes the homepage language trigger from appointment choice ordering and only enables field-order fallback when at least two appointment-form dropdowns are visible, so the country page no longer collapses into a false `selection_step`.

- Rule: once the page is already in English, post-captcha service and location selection should explicitly target the English labels and option text.
  Design: `src/chrome-page.js` now exposes dedicated English field and option patterns for `Type of service` and `Location`, and `src/chrome-cli.js` uses those English-only patterns for the automatic service/location selection steps.

- Rule: captcha dataset collection should support later manual labeling.
  Design: `collect-captcha` writes a per-run dataset directory with image files and a `labels.json` template.

- Rule: Phase A datasets must stay traceable after collection.
  Design: each `labels.json` entry now stores a compact captcha signature hash plus refresh provenance fields, and the run directory also includes a `summary.json` with batch-level uniqueness and refresh-method counts.

- Rule: manual labeling must be fast enough for hundreds of samples.
  Design: `src/captcha-labeler.js` exposes a one-image-at-a-time browser UI with `Save` and `Save & Next`, backed directly by the existing `labels.json` manifest.

- Rule: machine defaults should accelerate labeling without pretending to be ground truth.
  Design: `src/captcha-suggest.js` now loads the current local captcha model, writes its machine guess into separate `ocrText` and confidence fields, and lets the labeler pre-fill the input from `ocrText` only when `expectedText` is still empty.

- Rule: completed labels should be convertible into a model-ready dataset without custom ad hoc scripts.
  Design: `src/captcha-training.js` exports copied images and stable JSONL manifests under `data/captcha-training-current/`, with deterministic 80/10/10 splits and a machine-suggestion baseline summary.

- Rule: the next model iterations should still run locally without extra ML setup.
  Design: `src/captcha-train-local.js` uses only Node built-ins plus the exported PNG dataset, then trains a lightweight hybrid classifier with global prototypes, position-aware exemplars, and position-aware multi-prototypes instead of depending on Python, NumPy, or Torch.

- Rule: live checker should now use the local model only.
  Design: `src/chrome-cli.js` loads `model/captcha-model-current/model.json`, scores each captcha variant with the hybrid model, and only submits the best local-model candidate when distance, segmentation quality, and overall confidence all clear the configured gates.

- Rule: once captcha is solved, selector debugging should not rely on terminal logs alone.
  Design: `src/chrome-cli.js` now writes post-captcha JSON artifacts before and after the dropdown selection step, while `src/chrome-page.js` includes per-field diagnostics for service, location, people count, and date.

- Rule: post-captcha field evidence must outrank stale captcha-path evidence.
  Design: `src/chrome-page.js` now evaluates visible `Termin` options, reserved-message text, and selection controls before falling back to `captcha_step`, so a reused `weryfikacja-obrazkowa` URL no longer traps the CLI on the wrong state.

- Rule: captcha submit should be followed by a next-page observation window, not by captcha-only waiting.
  Design: `src/chrome-cli.js` now calls a dedicated post-submit snapshot poll that keeps checking for selection controls, date options, or reserved-message evidence before deciding the flow is still on captcha.

- Rule: visible next-step field labels should count as post-captcha evidence even before the dropdown controls finish hydrating.
  Design: `src/chrome-page.js` now extracts `selectionLabelEvidence` from page text for `Rodzaj usługi`, `Lokalizacja`, `Chcę zarezerwować termin dla`, and `Termin`; `src/chrome-utils.js` preserves that evidence in normalized snapshots and lets it short-circuit captcha retry logic.

- Rule: if captcha input and captcha image are both gone after submit, the checker must re-check page state before refreshing captcha.
  Design: `src/chrome-cli.js` now treats the “reason still says captcha_step, but no captcha UI remains” state as a transient post-submit state and re-runs the post-submit observation window before any refresh attempt.

- Rule: if that transient state still survives the re-check, it should be treated as already past captcha.
  Design: `src/chrome-cli.js` now force-promotes the snapshot to `selection_step` when captcha input and captcha image are both gone after submit, so the main flow cannot fall back into captcha refresh again.

- Rule: post-captcha custom dropdowns must still be selectable when their DOM exposes almost no surrounding label text.
  Design: `src/chrome-page.js` now keeps text-based matching as the primary path, but if a visible `mat-select` cannot be matched by context text it falls back to the stable vertical order of the four live controls: service, location, people count, then date.

- Rule: the final “all reserved” Polish sentence must still be recognized when the live page inserts hard line breaks, non-breaking spaces, or diacritic-normalization differences.
  Design: `src/chrome-page.js` now extracts the unavailable message through three passes: raw-text match, normalized-space match, and diacritic-stripped normalized match.

- Rule: if page-level unavailable extraction still misses, the final result must still converge to the correct no-slot state.
  Design: `src/status.js` now re-checks `bodyTextSample` and `bodyTextTailSample` for the normalized Polish reserved sentence before falling back to `selection_step`.

- Rule: the generated schedule files must stay reviewable before installation.
  Design: `src/launchd.js` writes all generated artifacts into `scheduler/` first, including an `INSTALL.md` guide, and leaves the actual copy into `~/Library/LaunchAgents` as an explicit user step.

- Rule: repository cleanup should remove dead implementation branches once the Chrome CLI path becomes canonical.
  Design: the repo now keeps only the current Chrome CLI, labeling, training, notification, and launchd generator files; legacy Playwright, Tampermonkey, and camera-OCR code paths were removed.

## 4. Captcha Design

- Capture source:
  use the live image or canvas from the current page, plus a thresholded enlarged variant generated in-page
- OCR cleaning:
  keep only the known captcha alphabet: letters, digits, `@`, `#`, `+`, and `=`
- Default submit policy:
  auto-submit only 4-character local-model candidates that also pass distance, segmentation-quality, and confidence gates in `check`; otherwise refresh captcha and retry
- Retry behavior:
  allow up to five captcha attempts before returning the last observed state, and inside each attempt score both raw and processed captures with the same hybrid model
- Collection behavior:
  stay on the captcha page, save the preferred labeling image plus available variants, click refresh, wait for the captcha signature to change, and only then count the next sample
  if the signature is still unchanged after the refresh wait window, skip saving and retry the loop instead of persisting a duplicate sample
  each saved sample also records the refresh path that produced it, so later labeling and model evaluation can correlate OCR outcomes with `initial_page_load`, `dom_refresh`, `real_pointer_click`, or reopen flows
- Labeling behavior:
  prefer `data/captcha-images-current-labels.json` when it exists, otherwise fall back to the latest available dataset manifest; render one image at a time, and save `expectedText` plus `notes` back into `labels.json` after each submission
- Suggestion behavior:
  load `model/captcha-model-current/model.json`, predict each unlabeled local image with the same hybrid local model used by live `check`, write the best model output into `ocrText`, and keep the final confirmation in the browser UI
- Training-export behavior:
  use the confirmed `expectedText` labels only, reject incomplete data, copy images into a dedicated export directory, and write `all.jsonl`, `train.jsonl`, `val.jsonl`, `test.jsonl`, and `summary.json`
- Training-export resilience:
  when rebuilding `data/captcha-training-current/`, retry transient directory-removal failures such as `ENOTEMPTY`, `EBUSY`, or `EPERM` before surfacing a hard failure
- Local-training behavior:
  rebuild the exported training directory, decode 8-bit PNG captcha images locally, convert them to grayscale, compute an Otsu threshold, remove isolated noise, compare projection / equal-width / component-guided segmentation branches, vectorize each glyph with occupancy, projection, transition, scalar, and serif-sensitive edge features, build global prototypes plus position-aware exemplar / multi-prototype indices, then evaluate on train / val / test
- Checker-side model behavior:
  score raw and processed captcha variants with the local hybrid model, record the per-variant average distance, segmentation quality, and confidence in the attempt log, and submit the best local-model guess only when the quality gates pass; if the page still rejects it, continue to the next refreshed captcha until the retry limit is reached
- Post-captcha diagnostic behavior:
  enrich each page snapshot with `selectionDiagnostics`, including whether each field was found, what control type was matched, the current visible text, and the currently visible option list; also persist `selectionLabelEvidence` so “labels rendered but controls not ready yet” can be distinguished from a true captcha page; write that snapshot to JSON before and after the selection step
- Diagnostic behavior:
  stay on the captcha page, execute refresh attempts, store the pre/post captcha signatures and images, and persist the chosen refresh target, the broader refresh candidate list, and the raw visible-actionable-control dump for each attempt
- Scheduling behavior:
  keep `check` as a single-run entrypoint, generate a separate shell script that `cd`s into the project and runs one check, and point the generated plist at that script with `StartInterval=7200`
- Foreground-repeat behavior:
  keep `check` as the single-run entrypoint, and let `scripts/run-check-every-90-seconds.sh` wrap it with a terminal-bound loop that compensates for the last run duration before sleeping; keep the old 2-minute filename as a thin forwarding wrapper

## 5. Availability Inference

- Positive:
  `Termin` contains at least one non-placeholder option
- Negative:
  the exact Polish reserved message appears
- Conservative fallback:
  keep the current page-stage reason such as `captcha_step`, `selection_step`, `imperva_challenge`, or `unknown_or_waiting`

## 6. Failure Handling

- If Chrome JavaScript from Apple Events is disabled, `doctor`, `check`, and `debug` must emit an actionable fix message.
- If Chrome JavaScript from Apple Events is disabled, `collect-captcha` must fail with the same actionable fix message.
- If the site is blocked by Imperva or Incapsula, the snapshot reason must be `imperva_challenge`.
- If selectors fail after captcha, the snapshot reason should remain `selection_step` or `unknown_or_waiting` instead of falsely reporting availability.
- If OCR is weak and still not 4 characters after retries, the CLI should refresh the captcha instead of submitting an invalid value.
- If the page ignores a plain DOM click on `Odśwież`, the runtime should fall back to the stronger trigger path so captcha collection and retries keep moving.
- If Chrome needs a fresh window during collection, the tab-preparation fallback now uses a minimal two-line AppleScript flow: `tell application "Google Chrome" to activate` plus `tell application "Google Chrome" to Get URL ...`; complex tab reuse stays in the earlier page-probing stage so the fallback path remains stable and testable.
- If the runtime still cannot point at a usable refresh control, the diagnostic record should preserve all matched refresh candidates so selector misses can be analyzed offline.
- If the runtime still cannot match any refresh candidate, the diagnostic record should preserve the visible actionable controls so Phase A can inspect search texts and hidden-character issues directly from artifacts.
- If the user wants every-2-hours automation, the project should generate but not auto-install a `launchd` bundle, because writing directly into `~/Library/LaunchAgents` is a system-level choice better left explicit.
- If the user wants “run now until I stop this terminal,” the shell helper should be preferred over `launchd`, because the requested lifecycle is tied to the current foreground session.
- If a desktop notification fires on a scheduled run, the alert text should stay short enough for the macOS banner and should not depend on the terminal being open.

## 7. Testing Strategy

- Unit-test `inferAvailability` for:
  - date options present
  - exact Polish reserved message
  - dropdown evidence outranking the message
  - fallback to page-stage reason
- Unit-test page-runtime source generation for:
  - Polish field labels
  - exact Polish reserved message
  - custom combobox support
  - alternate captcha capture generation
- Unit-test bridge and helper utilities for:
  - English homepage entry URL generation
  - always-auto-submit captcha policy
  - symbol-preserving captcha sanitation
  - 4-character captcha candidate extraction
  - captcha collection file naming and manifest generation
  - captcha collection signature digest and provenance metadata
  - captcha collection batch summary generation
  - captcha collection deduplication signature selection
  - labeler dataset selection, progress summary, and entry update behavior
  - OCR suggestion selection and manifest update behavior
  - training split assignment, validation, and OCR baseline summary
  - PNG decode helpers, thresholding helpers, glyph-boundary selection, hybrid-model classification, and analysis helpers
  - post-captcha artifact writing and selection-diagnostic normalization
  - snapshot normalization
  - foreground repeat-check shell helper content
  - launchd label generation, shell/plist generation, and bundle writing

## 8. Known Risks

- The target site may still change DOM structure or field labels.
- The site may reject Chrome automation under some session conditions.
- OCR accuracy is inherently variable on captcha images.
- Symbol-preserving OCR can still over-trust incorrect 4-character guesses until confidence scoring is added.
- The current processed captcha variant is only threshold-based; some future captchas may need different preprocessing.
- Some successful captcha submissions may still bounce back to the registration home, which is why the fixed URL reopen path is retained.
- Captcha collection can still miss samples if the page temporarily fails to render an image after refresh, so the loop uses retries and a generous upper bound.
- A stronger `Odśwież` click helps, but if the site still refuses to refresh, the collection loop now stalls safely instead of silently writing duplicate images.
- Because the live page still returns nested button text, refresh reliability now depends on the shared activation helper rather than only on native `button.click()`.
- Even after widening candidate discovery, the visible refresh-text node may still not represent the real handler owner, so Phase A must compare candidate metadata before changing the click strategy again.
- The real-pointer fallback depends on macOS Accessibility permission; if that permission is missing, the CLI now logs a targeted setup hint instead of a bare Quartz failure.
- Even with the new fallback, refresh can remain unstable, so Phase A diagnostics are now the primary source of truth before changing OCR or training strategy.
- The local labeling UI writes the full manifest on every save, so concurrent edits from multiple browser tabs are not currently coordinated.
- OCR suggestions currently operate on the raw local image only; if suggestion quality remains poor, the next upgrade should add local preprocessed variants before OCR.
- The current hybrid trainer still overfits on the 206-image dataset, so its holdout performance does not yet beat the earlier global-prototype baseline.
- Even with multi-branch segmentation, the current preprocessing path is still single-threshold and may not generalize to all future captchas.
- The checker-side gate now uses distance, segmentation quality, and overall confidence, but those thresholds still need further live recalibration as the dataset grows toward 400-500 labeled images.
- Even after captcha succeeds, custom Material dropdown markup may still move or rename wrappers, so `selectionDiagnostics` should be treated as the source of truth before changing selector strategy again.
- The next-step page can render field labels before the underlying dropdown triggers become detectable, so `selectionLabelEvidence` is now the earliest reliable over-page signal and must remain higher priority than stale captcha URL/path hints.
- The page can briefly report `captcha_step` after submit even though the captcha input and image are already gone, so refresh logic now needs a final post-submit recheck before it is allowed to touch `Odśwież`.
- If that final recheck still cannot stabilize the next-page evidence in time, the flow now prefers a conservative `selection_step` promotion over another captcha refresh, because the operator has already confirmed this state means the page advanced.
- The live `mat-select` controls may expose empty text and empty parent/container text, so selector stability now depends on the fixed visual order fallback until a richer label-to-control association is discovered.
- The final reserved-state sentence can visually match while raw DOM text still differs in whitespace or Unicode form, so unavailable-message extraction now normalizes text before giving up.
- Even after that normalization, page-level extraction can still occasionally miss the final state, so business-layer inference now performs one last body-text fallback before preserving `selection_step`.
- `launchd` runs inside a more minimal environment than an interactive terminal, so the generated shell script uses absolute paths and keeps the single-run checker as the only invoked business command.
