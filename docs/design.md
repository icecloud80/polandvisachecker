# Design Document

## 1. Architecture

- `src/chrome-cli.js`: the primary v1 entrypoint for `doctor`, `check`, `debug`, and `collect-captcha`
- `src/chrome-cli.js`: the primary v1 entrypoint for `doctor`, `check`, `debug`, `collect-captcha`, and `diagnose-refresh`
- `src/captcha-labeler.js`: lightweight local web server that turns `labels.json` into a one-image-at-a-time labeling UI
- `src/captcha-suggest.js`: batch OCR suggester that fills `ocrText` for unlabeled captcha entries
- `src/captcha-training.js`: training export tool that validates confirmed labels and writes a stable train/val/test dataset
- `src/chrome-bridge.js`: AppleScript bridge that opens Chrome tabs and executes page JavaScript
- `src/chrome-page.js`: in-page DOM runtime for captcha detection, dropdown selection, and availability reading
- `src/chrome-utils.js`: shared captcha heuristics, bridge helpers, and snapshot normalization
- `src/status.js`: pure availability inference from page signals
- `src/notifier.js`: desktop notification fan-out for positive hits
- `test/*.test.js`: unit tests for inference, bridge helpers, and page-runtime source generation

## 2. Execution Flow

1. `check` loads config and ensures `artifacts/` exists.
2. The CLI opens real Chrome to the fixed Los Angeles Schengen captcha URL.
3. The CLI verifies that Apple Events JavaScript is available in Chrome.
4. The page runtime snapshots the current state.
5. If the page is at captcha:
   - capture captcha image
   - capture an alternate processed captcha image in the page runtime
   - save image to `artifacts/`
   - OCR the image in Node with Tesseract
   - first retry OCR against the raw capture until a 4-character candidate is found or exhausted
   - if needed, switch to the processed capture and OCR again
   - only if OCR resolves to 4 allowed characters, auto-submit the guess without waiting for terminal input
   - otherwise click captcha refresh and move on to the next automated attempt
   - if the captcha is rejected, capture the refreshed image and retry automatically
   - fill the captcha input and click `Dalej`
6. If captcha success returns to the registration home, reopen the fixed Schengen URL.
7. If the page is at the selection step, the runtime selects:
   - `Rodzaj usługi = Wiza Schengen`
   - `Lokalizacja = Los Angeles`
   - `Chcę zarezerwować termin dla = 1 osob`
8. The runtime reads the `Termin` control and the reserved-message area.
9. `src/status.js` converts those signals into the final status object.
10. The CLI prints compact JSON and sends a desktop notification only if dates are available.
11. If the command is `collect-captcha`, the CLI saves captcha samples and a blank labeling manifest instead of submitting the form.
12. If the command is `diagnose-refresh`, the CLI runs refresh-only attempts, records before/after evidence, and writes a structured summary for Phase A analysis.
13. If the command is `captcha:label`, the local labeler selects the latest dataset, opens a tiny browser UI, and saves each `expectedText` update back into `labels.json`.
14. If the command is `captcha:suggest`, the OCR suggester scans unlabeled entries, writes `ocrText` and confidence metadata into the manifest, and leaves human confirmation to the labeler.
15. If the command is `captcha:prepare-train`, the training exporter validates the manifest, copies images into a training directory, assigns deterministic splits, and writes summary plus JSONL files.

## 3. Rule Mapping

- Rule: the tool should only support the Los Angeles Schengen flow.
  Design: the bridge always navigates to the fixed `wiza-schengen/wizyty/weryfikacja-obrazkowa` path.

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
  Design: a shared page activation helper now triggers both the matched node and its nearest actionable ancestor so Material-style wrappers can still react to `Odśwież` and `Dalej`.

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

- Rule: captcha dataset collection should support later manual labeling.
  Design: `collect-captcha` writes a per-run dataset directory with image files and a `labels.json` template.

- Rule: Phase A datasets must stay traceable after collection.
  Design: each `labels.json` entry now stores a compact captcha signature hash plus refresh provenance fields, and the run directory also includes a `summary.json` with batch-level uniqueness and refresh-method counts.

- Rule: manual labeling must be fast enough for hundreds of samples.
  Design: `src/captcha-labeler.js` exposes a one-image-at-a-time browser UI with `Save` and `Save & Next`, backed directly by the existing `labels.json` manifest.

- Rule: OCR defaults should accelerate labeling without pretending to be ground truth.
  Design: `src/captcha-suggest.js` writes machine guesses into separate `ocrText` and confidence fields, while the labeler pre-fills the input from `ocrText` only when `expectedText` is still empty.

- Rule: completed labels should be convertible into a model-ready dataset without custom ad hoc scripts.
  Design: `src/captcha-training.js` exports copied images and stable JSONL manifests under `artifacts/captcha-training-current/`, with deterministic 80/10/10 splits and an OCR baseline summary.

## 4. Captcha Design

- Capture source:
  use the live image or canvas from the current page, plus a thresholded enlarged variant generated in-page
- OCR engine:
  `tesseract.js` in Node
- OCR cleaning:
  keep only the known captcha alphabet: letters, digits, `@`, `#`, `+`, and `=`
- Default submit policy:
  auto-submit only 4-character OCR candidates in `check`; otherwise refresh captcha and retry
- Retry behavior:
  allow up to three captcha attempts before returning the last observed state, and inside each attempt retry OCR on both raw and processed captures
- Collection behavior:
  stay on the captcha page, save the preferred labeling image plus available variants, click refresh, wait for the captcha signature to change, and only then count the next sample
  if the signature is still unchanged after the refresh wait window, skip saving and retry the loop instead of persisting a duplicate sample
  each saved sample also records the refresh path that produced it, so later labeling and model evaluation can correlate OCR outcomes with `initial_page_load`, `dom_refresh`, `real_pointer_click`, or reopen flows
- Labeling behavior:
  prefer `artifacts/captcha-images-current-labels.json` when it exists, otherwise fall back to the latest `captcha-dataset-*` directory and then the latest `captcha-collection-*` directory; render one image at a time, and save `expectedText` plus `notes` back into `labels.json` after each submission
- Suggestion behavior:
  run a strict-whitelist OCR pass and a fallback no-whitelist OCR pass on each unlabeled local image, pick the best candidate as `ocrText`, and keep the final confirmation in the browser UI
- Training-export behavior:
  use the confirmed `expectedText` labels only, reject incomplete data, copy images into a dedicated export directory, and write `all.jsonl`, `train.jsonl`, `val.jsonl`, `test.jsonl`, and `summary.json`
- Diagnostic behavior:
  stay on the captcha page, execute refresh attempts, store the pre/post captcha signatures and images, and persist the chosen refresh target, the broader refresh candidate list, and the raw visible-actionable-control dump for each attempt

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
- If the runtime still cannot point at a usable refresh control, the diagnostic record should preserve all matched refresh candidates so selector misses can be analyzed offline.
- If the runtime still cannot match any refresh candidate, the diagnostic record should preserve the visible actionable controls so Phase A can inspect search texts and hidden-character issues directly from artifacts.

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
  - fixed Schengen URL generation
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
  - snapshot normalization

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
- The current training export prepares a stable dataset directory, but it does not yet include a local supervised model trainer; that is the next layer after the export contract is confirmed.
