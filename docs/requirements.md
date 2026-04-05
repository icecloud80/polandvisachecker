# Requirement Document

## 1. Goal

Build a single-run local tool that checks whether the Polish e-Konsulat Schengen visa flow for Los Angeles exposes any selectable appointment dates.

## 2. User Story

- As a visa applicant, I want one command to drive the real Chrome flow so I do not need to click through the same steps manually.
- As a visa applicant, I want OCR to keep pushing captcha attempts automatically so the CLI does not stop for manual intervention.
- As a visa applicant, I want a clear machine-readable result that tells me whether dates exist, all dates are reserved, or the page is blocked.
- As a visa applicant, I want the project to generate a ready-to-install macOS `launchd` bundle so I can run the checker every 2 hours without keeping a terminal open.

## 3. Functional Requirements

- Open real Google Chrome on macOS.
- Navigate directly to `https://secure.e-konsulat.gov.pl/placowki/126/wiza-schengen/wizyty/weryfikacja-obrazkowa`.
- Detect whether the current page is:
  - captcha step
  - post-captcha selection step
  - anti-bot challenge
  - date-available state
  - all-dates-reserved state
- Extract the captcha image from the page.
- Extract both the raw captcha image and at least one alternate processed captcha capture from the page.
- Save the captcha image into `artifacts/`.
- Run the local captcha model directly in `check`, and submit its best current guess without invoking Tesseract.
- Constrain OCR cleanup to the known captcha alphabet: letters, digits, `@`, `#`, `+`, and `=`.
- Prefer OCR candidates that resolve to exactly 4 characters.
- Re-run OCR on the same captcha before switching to the alternate processed capture.
- Automatically submit the OCR guess only when OCR resolves to exactly 4 allowed captcha characters.
- If OCR still cannot produce 4 characters after raw and processed retries, refresh the captcha and retry automatically.
- Fill the `Characters from image` field and submit `Dalej`.
- Select `Rodzaj usługi = Wiza Schengen`.
- Select `Lokalizacja = Los Angeles`.
- Select `Chcę zarezerwować termin dla = 1 osob`.
- Read the `Termin` field after the selections settle.
- Persist a post-captcha status artifact before the dropdown selections run.
- Persist a post-captcha status artifact after the dropdown selections run, including per-field diagnostics and selection action results.
- Mark the result as available when `Termin` contains at least one real selectable date.
- Mark the result as unavailable when the page shows:
  `Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym`
- Print compact JSON with `checkedAt`, `isAvailable`, `reason`, `availableDateCount`, `optionTexts`, and `pageUrl`.
- After the JSON block, print one final Chinese summary line: `有预约时间` or `没有预约时间`.
- Support `doctor`, `check`, `debug`, and `collect-captcha` commands.
- Support a `schedule:launchd` command that writes a 2-hour macOS `launchd` bundle into the workspace.
- Support a `captcha:label` command that opens a local one-image-at-a-time labeling UI on top of `labels.json`.
- Support a `captcha:suggest` command that batch-runs the current local captcha model for unlabeled captcha entries and writes machine suggestions back into the manifest.
- Support a `captcha:prepare-train` command that validates the finished labels and exports a training-ready dataset directory.
- Support a `captcha:train-local` command that prepares the current labeled dataset, trains a first local classifier, and writes model plus prediction artifacts.
- Support a `captcha:analyze` command that reads the latest model artifacts and prints position metrics, confusion summaries, serif hard-case summaries, symbol error rates, and the estimated success rate within 5 fresh captcha attempts.
- Support a `diagnose-refresh` command dedicated to Phase A refresh investigation.
- Keep desktop notification support for positive hits.
- Positive-hit macOS notifications must use Chinese copy so the operator can react immediately without reading English system alerts.
- `collect-captcha` must save a batch of captcha images for later manual labeling.
- `collect-captcha` must write a `labels.json` manifest with blank `expectedText` fields.
- `collect-captcha` must record per-sample provenance fields such as `signatureHash`, `refreshMethod`, `refreshContext`, and `refreshRecordPath`.
- `collect-captcha` must write a batch `summary.json` file with saved-count, unique-signature, duplicate-skip, and refresh-method statistics.
- `captcha:label` must default to `artifacts/captcha-images-current-labels.json` when that consolidated current-label file exists, and only then fall back to the newest available dataset or raw collection manifest.
- `captcha:label` must display one captcha image at a time, allow updating `expectedText`, and support a save-and-next interaction without manually editing JSON.
- `captcha:suggest` must only populate suggestion fields such as `ocrText`, `ocrConfidence`, and model-attempt metadata; it must not overwrite confirmed `expectedText`.
- `captcha:prepare-train` must fail fast if any image is missing or any label is empty / non-4-character.
- `captcha:prepare-train` must export copied images plus `all.jsonl`, `train.jsonl`, `val.jsonl`, `test.jsonl`, and `summary.json`.
- `captcha:train-local` must rebuild `artifacts/captcha-training-current/`, train on the deterministic `train` split only, and emit `model.json`, `summary.json`, and per-split prediction reports.
- `captcha:train-local` must stay local-only and must not require extra Python or ML package installation.
- `captcha:train-local` must emit hybrid-model metadata, including position-aware exemplar / prototype data, serif-sensitive feature metadata, and a 5-attempt success estimate.
- `collect-captcha` must confirm the captcha image has changed after refresh before counting the next sample.
- `diagnose-refresh` must write a per-attempt JSON record plus before/after captcha images for each refresh attempt.
- `diagnose-refresh` must write a batch `summary.json` file with changed-image counts and record paths.
- `diagnose-refresh` must also persist the broader list of visible refresh-text candidates, their actionable ancestors, and click points so selector misses can be diagnosed from artifacts.
- When refresh-text candidates are empty, `diagnose-refresh` must still persist the visible actionable controls and their search texts so regex and hidden-character issues can be diagnosed offline.
- `schedule:launchd` must generate:
  - one shell script that runs a single `check`
  - one `.plist` file configured for every 2 hours
  - one install guide with `launchctl` commands
- `schedule:launchd` must keep generated files inside the workspace and must not silently write into `~/Library/LaunchAgents`.
- `schedule:launchd` must default to the tracked `scheduler/` directory, because `artifacts/` is reserved for ignored runtime outputs.

## 4. Rules

- This version must use real Google Chrome, not Playwright-first automation.
- This version must keep the checker itself single-run; the every-2-hours schedule is an outer `launchd` wrapper, not an internal watch loop.
- OCR is assistive only and must auto-submit valid 4-character results without blocking on manual help.
- The first local captcha model is now the only captcha solver in live `check`.
- The current local captcha model must preserve the earlier global-prototype path as the fallback scoring anchor even after adding position-aware exemplars and multi-prototype clusters.
- OCR cleaning must preserve visible captcha symbols such as `@`, `+`, and `=` instead of stripping them.
- OCR should aggressively target a 4-character result, because the live captcha length is fixed at 4.
- Captcha dataset collection must not submit forms or leave the captcha page intentionally.
- Captcha labeling must preserve symbol characters such as `@`, `#`, `+`, and `=` in manual input.
- Captcha suggestion generation must preserve symbol characters such as `@`, `#`, `+`, and `=` in OCR outputs.
- The tool must prioritize the fixed Los Angeles Schengen path only.
- The tool must support both native `select` controls and custom combobox/listbox widgets.
- Post-captcha diagnostics must preserve per-field evidence for service, location, people count, and date.
- Post-captcha diagnostics must also preserve whether the next-step field labels are already visible, even if the dropdown controls are not yet selectable.
- Post-captcha selector logic must fall back to the fixed visual order of the four visible dropdowns when the live `mat-select` controls do not expose usable label context.
- Final unavailable-state detection must survive line breaks, non-breaking spaces, and Unicode normalization differences in the Polish reserved message.
- Final unavailable-state detection must still work when the reserved sentence appears only in `bodyTextSample` / `bodyTextTailSample` and `unavailabilityText` is temporarily empty.
- Post-captcha selection controls and date evidence must outrank captcha-path evidence, because the live site can keep the old captcha URL even after the next page is visible.
- Date-option evidence is stronger than message-text evidence.
- When no strong evidence exists, the tool must return a conservative non-available result.
- The tool must preserve explicit page-stage reasons such as `captcha_step`, `selection_step`, and `imperva_challenge`.
- The first local captcha trainer must preserve symbol-bearing labels such as `@`, `#`, `+`, and `=` as first-class classes.
- The local captcha trainer must treat the captcha alphabet as a serif-style character family and expose dedicated hard-case summaries for uppercase/lowercase/symbol confusions.

## 5. Logic

- Start on the fixed Schengen captcha URL.
- If the page is still at captcha, run OCR against the raw captcha capture first.
- If the local captcha model has multiple variant predictions for the current captcha image, score them with distance, segmentation quality, and overall confidence before deciding whether to submit or refresh.
- If the captcha is rejected, capture the refreshed image and retry automatically for up to 5 attempts.
- If the best current model guess fails the segmentation-quality or confidence gate, refresh the captcha without submitting that guess.
- If captcha success returns to the registration home, reopen the fixed Schengen URL.
- If the command is `collect-captcha`, stay on the captcha page, save the current captcha image set, refresh, and repeat until the requested sample count is reached.
- During `collect-captcha`, if refresh does not change the captcha image yet, keep waiting or retry refreshing instead of saving a duplicate sample.
- During `collect-captcha`, each saved sample must inherit the provenance of the refresh step that produced it, so later labeling can distinguish initial-load images from DOM-refresh or real-click images.
- If the command is `captcha:label`, start a local browser UI over the selected `labels.json`, show the current image, save the current label, and move to the next image on demand.
- If the command is `captcha:suggest`, batch-run the current local captcha model only for entries whose `expectedText` is empty, persist the suggestion under `ocrText`, and leave final confirmation to the labeler UI.
- If the command is `captcha:prepare-train`, validate the selected manifest, copy the images into a dedicated training directory, assign stable train/val/test splits, and emit an OCR baseline summary.
- If the command is `captcha:train-local`, rebuild the current training directory, decode the copied PNG images locally, train a hybrid character model from the `train` split, and emit train/val/test evaluation summaries plus hard-case analysis fields.
- If the command is `captcha:analyze`, read the latest model artifacts and reprint holdout-oriented analysis fields instead of retraining the model.
- If the command is `diagnose-refresh`, stay on the captcha page, run refresh attempts repeatedly, and persist structured evidence about each attempt instead of collecting labels.
- If the command is `schedule:launchd`, generate a shell script, a `.plist`, and an install guide under `scheduler/`.
- Captcha refresh must activate the visible `Odśwież` button with a full mouse-event sequence instead of relying on a plain DOM `click()` only.
- The page runtime must also try the matched element's nearest actionable ancestor when triggering `Odśwież` or `Dalej`, because the live site may wrap visible text inside nested Material-style button markup.
- Refresh target discovery must not rely only on native button selectors; it must also inspect visible text matches and their nearest actionable ancestors.
- Refresh target discovery must tolerate Unicode/diacritic variants and duplicated button text emitted by the live Angular/Material markup.
- If DOM-triggered refresh still fails, the tool must read the refresh control's screen position and fall back to a real macOS mouse click.
- Even after a refresh attempt, `collect-captcha` must refuse to count or save a sample if the captcha signature is still unchanged.
- The real-click fallback may require macOS Accessibility permission for the terminal or Codex app, and the tool should surface that setup hint when the fallback cannot run.
- If the page is on the post-captcha selection step, fill the three dropdowns in order:
  - service
  - location
  - people count
- After the selections settle:
  - if `Termin` has real options, return available
  - else if the exact Polish reserved message is present, return unavailable
  - else return the current page-stage reason or `unknown_or_waiting`
- After captcha success but before final inference, write JSON evidence so later debugging can tell whether the page was reached but the selectors failed.
- After each captcha submit, immediately re-evaluate whether the next page is already visible before continuing any captcha retry logic.
- After each captcha submit, use a dedicated post-submit polling window that looks for selection controls and `Termin` evidence, not just captcha-specific signals.
- During that post-submit polling window, treat the visible labels for `Rodzaj usługi`, `Lokalizacja`, and `Chcę zarezerwować termin dla` as sufficient next-page evidence even if the custom dropdown controls are still hydrating.
- If a post-submit snapshot no longer contains either a captcha input or any captcha image source, re-check next-page evidence before allowing any captcha refresh logic to run.
- If that re-check still does not stabilize the next page in time, treat the run as already past captcha and continue with post-captcha selection instead of refreshing captcha again.
- During post-captcha selection, keep text-based field matching first, but if the live custom selects have empty context text then map the four visible controls by top-to-bottom order to service, location, people count, and date.
- During final result reading, match the Polish “all reserved” sentence on raw text first, then on normalized-space text, and finally on diacritic-stripped normalized text.
- If page-level extraction still misses the final Polish sentence, run the same normalized match again in the business-layer inference using `bodyTextSample` and `bodyTextTailSample` before keeping `selection_step`.

## 6. AI Strategy

- Use OCR only as a convenience layer for captcha entry.
- Prefer deterministic DOM evidence over OCR or heuristic guesses.
- Prefer direct navigation to the known path over menu clicking.
- Prefer a real Chrome session over automation-only browsers because anti-bot risk is lower.
- Treat symbol-bearing captcha strings as first-class valid OCR outputs when they match the expected length.
- Use collected captcha datasets as the foundation for any future supervised OCR training.
- Treat dataset provenance as first-class evidence, because OCR training quality depends on knowing whether a sample came from a true refresh, a reopen, or an unchanged-image retry.
- Treat the one-image-at-a-time labeling UI as the default annotation path, because manual JSON editing is too slow for hundreds of captcha samples.
- Treat OCR suggestions as accelerators for manual labeling, not as confirmed labels.
- Treat the post-label export as the start of model work, because a stable train/val/test directory is more important than training code coupled to the labeler format.
- Treat the first local trainer as a baseline-plus-analysis stack, because the immediate goal is now both “can the dataset be learned?” and “which serif-style hard cases are still blocking 5-attempt success?”
- Treat global prototypes as the generalization anchor, and treat position-aware exemplars / multi-prototypes as supporting signals rather than the sole scoring source.
- Treat checker-side model integration as retry-driven, because live `check` now relies entirely on the local model instead of OCR fallback.
- Treat post-captcha evidence as first-class debug output, because once captcha is solved the main uncertainty moves to dropdown detection and `Termin` inference.
- Treat next-step field labels as the earliest reliable post-captcha evidence, because the live Angular page can render labels before the dropdown widgets become detectable.
- Treat “captcha reason but no captcha UI left” as a transient post-submit state, because refreshing in that window can interrupt a page that has already moved forward.
- After that transient-state recheck, prefer a conservative `selection_step` promotion over any further captcha retry, because the live operator has confirmed this state means captcha already passed.
- Treat the fixed visual order of the four live dropdowns as a valid selector heuristic, because the current `mat-select` markup can expose no usable label text on the trigger or its immediate wrappers.
- Treat normalized reserved-message matching as a required heuristic, because the live page can visually show the final state while raw DOM text still differs in whitespace or Unicode composition.
- Treat `bodyTextSample/bodyTextTailSample` as the final no-slot fallback, because the live final page can visually show the result even when the explicit unavailable field was not captured in that exact snapshot.
- Treat macOS `launchd` as the simplest recurring wrapper for this project, because the checker already depends on a local Chrome session and Apple Events permissions.
- Treat positive-hit notifications as high-priority operator alerts, so the default desktop copy should be short, direct, and localized in Chinese.
- Treat refresh diagnostics as the prerequisite evidence layer before changing OCR or model strategy again.
- Treat refresh-candidate enumeration as the first Phase A debugging surface, because a visible `Odśwież` label does not guarantee the current selector points at the real interactive node.
- When refresh-candidate enumeration returns nothing, treat the actionable-control dump as the next debugging surface before changing click strategy again.

## 7. AI Heuristic

- Treat OCR output length and symbols as observability signals, and require 4 allowed characters before submission.
- Treat segmentation quality and overall model confidence as checker-side gates, because the model will often emit a 4-character string even for obviously bad splits.
- Prefer exact 4-character OCR candidates over longer noisy strings.
- Auto-submit OCR output for every attempt, including weak guesses and symbol-bearing guesses.
- Refresh the captcha instead of submitting when the hybrid model says the current split is too unstable.
- Detect unavailable state using the exact Polish sentence, with English fallback kept only as compatibility.
- For the first local trainer, prefer a deterministic character prototype model over heavier dependencies, because the immediate goal is to validate dataset learnability on the current machine.
- For recurring runs on macOS, prefer generating a `launchd` bundle over embedding a sleep loop, because the project already needs GUI-friendly local scheduling.

## 8. Roadmap

- Add a one-command installer/uninstaller wrapper around the generated `launchd` bundle after the current manual-copy flow is proven stable.
- Add polling after the single-run flow is stable enough that an outer scheduler is no longer sufficient.
- Add structured notification templates for Telegram, Discord, Slack, and ntfy.
- Improve captcha preprocessing before OCR.
- Add OCR confidence scoring so the symbol-preserving 4-character rule is not the only submit heuristic.
- Add more processed capture variants if the current raw-plus-threshold pair is still unstable.
- Add richer debug artifact capture for selector failures and anti-bot states.
- Add a lightweight local labeling UI on top of `labels.json`.
- Add keyboard shortcuts and filtering to the labeling UI after the basic sequential flow is stable.
- Add a “skip to next unlabeled with no OCR suggestion” mode if OCR coverage becomes uneven.
- Compare the first prototype model against improved preprocessing variants.
- Recalibrate the checker-side local-model distance threshold using real live runs and the saved captcha artifacts.
- Improve the local model until the 5-attempt live checker clears captcha consistently without any OCR fallback.
- Expand the labeled dataset from 206 images to 400-500 images, prioritizing serif hard cases such as `C/c`, `P/p`, `K/k`, `S/s`, `#`, `=`, `+`, `@`, and difficult first/last-character splits.
- Rebalance hybrid-model weights until holdout performance at least matches, then beats, the earlier global-prototype baseline.
- Use `captcha:analyze` after every training round so new data collection targets the worst current confusion pairs instead of growing the dataset blindly.
- Add top-k prediction output so the labeler can optionally use model suggestions in future rechecks.
- Add a dataset browser that reads both `labels.json` and `summary.json`, so labeling can prioritize the cleanest runs first.
- Turn the refresh diagnostic JSON into a small analysis report that clusters failures by method, target element, and tab-loss behavior.
- If refresh target discovery remains unstable, add a selector-analysis report that clusters failures by matched node type, actionable ancestor type, and click-point availability.

## 9. UI Improvements

### Mobile

- Not applicable in v1 because this deliverable is a macOS CLI.

### PC

- Keep normal `check` output compact and machine-readable.
- Keep `debug` output verbose for troubleshooting.
- Save captcha images into `artifacts/` so the user can inspect them outside the terminal.
- Save collected captcha samples into per-run directories so the operator can label them batch by batch.
- Save per-run captcha summaries so the operator can quickly judge dataset quality before opening the full manifest.
- Make the labeling UI favor uninterrupted sequential entry: image on the left, answer field on the right, save-and-next as the primary action.
- Save refresh diagnostics into per-run directories so the operator can compare JSON evidence with before/after captcha images.
- Keep refresh candidate metadata readable in JSON so the operator can compare “visible label node” and “real clickable ancestor” without inspecting the DOM live.
- Keep local training output machine-readable so later model iterations can diff metrics and per-split failures.
- Keep post-captcha status artifacts machine-readable so live selector failures can be compared across runs.
- Keep generated scheduling files machine-readable and self-contained so the operator can inspect them before installing them into `~/Library/LaunchAgents`.

## 10. Bug Fix List

- 2026-04-03: removed watch-mode-first positioning from the main CLI contract.
- 2026-04-03: simplified the runtime to real Chrome single-run flow for Los Angeles only.
- 2026-04-03: removed old country and office selection from the post-captcha flow.
- 2026-04-03: added explicit support for Polish field labels used by the live flow.
- 2026-04-03: added exact Polish reserved-message detection for vacancy inference.
- 2026-04-03: changed normal `check` output to compact JSON instead of debug-heavy dumps.
- 2026-04-03: preserved detailed page-stage reasons such as `selection_step` and `imperva_challenge`.
- 2026-04-04: changed captcha handling to OCR-first auto-submit instead of prompting for confirmation on every attempt.
- 2026-04-04: fixed OCR captcha cleaning so real symbol characters like `@`, `+`, and `=` are preserved instead of stripped.
- 2026-04-04: removed terminal-based captcha fallback from `check`, so captcha handling now stays fully automated.
- 2026-04-04: added a two-stage OCR flow that retries the raw capture and then switches to a processed captcha capture before submission.
- 2026-04-04: stopped submitting blank or non-4-character OCR results; the CLI now refreshes captcha automatically when OCR still cannot resolve 4 characters.
- 2026-04-04: added `collect-captcha` mode to batch-save captcha images plus a blank labeling manifest for later annotation.
- 2026-04-04: fixed `collect-captcha` to wait for an actual captcha image change after refresh, preventing duplicate sample batches.
- 2026-04-05: changed captcha refresh to trigger the live `Odśwież` button with the same stronger mouse-event sequence used for custom controls, because plain `click()` did not reliably refresh the image.
- 2026-04-05: fixed `collect-captcha` to skip saving when the captcha signature is still unchanged after refresh, so duplicate images no longer leak into the dataset.
- 2026-04-05: added a shared page activation path that triggers both the visible control and its nearest actionable ancestor, improving `Odśwież` and `Dalej` clicks on nested button markup.
- 2026-04-05: added a real-pointer captcha refresh fallback that reads the `Odśwież` screen coordinates from the page and uses a macOS mouse click when DOM refresh is ignored.
- 2026-04-05: added a dedicated `diagnose-refresh` Phase A mode that records refresh method, target element metadata, and before/after captcha evidence for each attempt.
- 2026-04-05: widened refresh target discovery so diagnostics now enumerate visible refresh-text matches, their actionable ancestors, and click points instead of only checking native button selectors.
- 2026-04-05: added a raw actionable-control dump to refresh diagnostics so Phase A can inspect live button search texts even when no refresh candidate matches the current pattern.
- 2026-04-05: hardened refresh-text matching against Unicode/diacritic variants and duplicated button text after diagnostics showed live controls like `Odśwież` exposing repeated search strings.
- 2026-04-05: added per-sample provenance metadata and per-run collection summaries so Phase A datasets can be filtered by unique signatures and refresh source before labeling.
- 2026-04-05: added a local `captcha:label` UI so captcha annotation now happens as a sequential image-input-next workflow instead of manual JSON editing.
- 2026-04-05: changed `captcha:label` to prioritize the consolidated current label manifest, so the default labeling target now matches the cleaned image folder the user actually works from.
- 2026-04-05: changed `captcha:suggest` to use the current local captcha model instead of Tesseract, while keeping the existing `ocrText` manifest fields for labeler compatibility.
- 2026-04-05: hardened training export directory cleanup with retry logic for transient macOS `ENOTEMPTY` / `EBUSY` failures, so `captcha:train-local` can rebuild `captcha-training-current` reliably after fresh exports.
- 2026-04-05: added `captcha:prepare-train` so the fully labeled captcha set can now be exported into a deterministic train/val/test directory with OCR baseline metrics.
- 2026-04-05: added `captcha:train-local`, a pure-Node first local trainer that decodes PNG captcha images, builds per-character prototypes, and emits train/val/test evaluation reports without extra ML dependencies.
- 2026-04-05: switched live `check` to local-model-only captcha solving, raised the default distance gate to 50, and increased automated captcha retries to 5 attempts.
- 2026-04-05: added post-captcha status artifacts and per-field dropdown diagnostics so runs that clear captcha now preserve exact evidence about selection-step detection and `Termin` options.
- 2026-04-05: added `selectionLabelEvidence` so the checker now stops captcha retries as soon as the next-step field labels become visible, even if the dropdown controls have not fully hydrated yet.
- 2026-04-05: added a post-submit guard that re-checks page state when captcha input and captcha image have both disappeared, preventing the checker from refreshing captcha during an in-flight transition to the next step.
- 2026-04-05: hardened that post-submit guard so if captcha UI is still gone after the recheck, the checker force-promotes the flow to `selection_step` and stops all remaining captcha retry logic.
- 2026-04-05: added a post-captcha selector fallback that maps the four visible `mat-select` controls by vertical order when live context-text matching returns `not_found` for every dropdown.
- 2026-04-05: hardened final no-slot detection so the Polish reserved sentence is recognized even when the live page wraps it across lines or emits different Unicode spacing/diacritic forms.
- 2026-04-05: added a business-layer no-slot fallback that scans normalized `bodyTextSample/bodyTextTailSample`, so final runs no longer stay at `selection_step` when the Polish reserved sentence is already visible in the captured page text.
- 2026-04-05: added `schedule:launchd`, which generates a macOS shell script, `LaunchAgent` plist, and install guide so the single-run checker can be scheduled every 2 hours without adding an internal polling loop.
- 2026-04-05: changed macOS desktop notification copy to Chinese, so positive hits now alert the operator with a direct “波兰签证有预约时间” message.
- 2026-04-05: moved launchd bundle generation into the tracked `scheduler/` directory and removed legacy Playwright, Tampermonkey, camera-OCR, and stray debug-file remnants from the repository.
- 2026-04-05: upgraded the local trainer from a single-prototype baseline to a hybrid classifier that now emits position metrics, confusion summaries, serif hard-case summaries, symbol error rates, and a 5-attempt success estimate.
- 2026-04-05: added checker-side segmentation-quality and model-confidence gates so low-quality captcha splits are refreshed instead of being submitted blindly.
- 2026-04-05: added `captcha:analyze` so every training round can now be reviewed through holdout confusion pairs, per-position accuracy, and 5-attempt budget estimates without retraining.
- 2026-04-05: simplified the Chrome AppleScript tab-preparation fallback to `tell application "Google Chrome" to activate` plus a single-line `tell application "Google Chrome" to Get URL ...`, so captcha collection no longer depends on brittle window/tab traversal when the current page cannot be reused.
