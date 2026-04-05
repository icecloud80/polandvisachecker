# Poland Visa Checker V1

Single-run macOS CLI for checking whether the Poland Schengen visa page for Los Angeles exposes any selectable appointment dates.

## What This Version Does

- Opens real Google Chrome on macOS
- Navigates directly to:
  `https://secure.e-konsulat.gov.pl/placowki/126/wiza-schengen/wizyty/weryfikacja-obrazkowa`
- Uses the local captcha prototype model directly in `check`
- Tries both raw and processed captcha captures and submits the best 4-character model candidate automatically
- Preserves visible captcha symbols such as `@`, `+`, and `=` instead of stripping them out
- Generates a ready-to-install macOS `launchd` bundle for running the checker every 2 hours
- Clicks `Dalej`
- Selects:
  - `Rodzaj usługi = Wiza Schengen`
  - `Lokalizacja = Los Angeles`
  - `Chcę zarezerwować termin dla = 1 osob`
- Detects whether `Termin` has real options or whether the page shows the Polish “all reserved” message
- Saves post-captcha status artifacts so we can inspect exactly which dropdowns were found and what options were visible
- After each captcha submit, treats visible post-captcha dropdowns as stronger evidence than the old captcha URL, so the terminal stops waiting once the next page is reached
- After each captcha submit, performs a dedicated post-submit snapshot poll for the next page instead of only waiting on captcha-specific signals
- After each captcha submit, also treats the visible next-step field labels themselves as strong post-captcha evidence, even before the dropdown controls finish hydrating
- If a post-submit snapshot no longer shows any captcha input or captcha image, re-checks page state before trying to refresh captcha again
- If that re-check still sees no captcha UI, the run now force-promotes the flow to the post-captcha selection step instead of refreshing captcha again

## What This Version Does Not Do

- No polling
- No Tampermonkey path
- No Playwright-first flow
- No support for other consulates or other visa flows

## Requirements

- macOS
- Google Chrome installed
- Node.js 22+
- Chrome setting enabled:
  `View > Developer > Allow JavaScript from Apple Events`

## Install

```bash
npm install
```

## Commands

Check that Chrome can be controlled:

```bash
npm run doctor
```

Run one end-to-end vacancy check:

```bash
npm run check
```

Open the target page and print a full debug snapshot:

```bash
npm run debug
```

Collect a batch of captcha images for manual labeling:

```bash
npm run captcha:collect
```

Open the latest captcha dataset in a local labeling UI:

```bash
npm run captcha:label
```

Generate OCR suggestions for unlabeled captcha entries:

```bash
npm run captcha:suggest
```

Generate a macOS `launchd` bundle that runs `check` every 2 hours:

```bash
npm run schedule:launchd
```

Export the fully labeled captcha set into a training-ready directory:

```bash
npm run captcha:prepare-train
```

Train the first local prototype model on the labeled captcha set:

```bash
npm run captcha:train-local
```

Open a specific dataset or manifest:

```bash
npm run captcha:label -- --dataset artifacts/captcha-dataset-1775371792919
```

Run a dedicated Phase A refresh diagnostic pass:

```bash
npm run captcha:diagnose-refresh
```

Optionally choose how many samples to save:

```bash
CAPTCHA_COLLECT_COUNT=50 npm run captcha:collect
```

Run tests:

```bash
npm test
```

## How `check` Works

1. Opens or reuses a Chrome tab on the e-Konsulat site
2. Navigates directly to the Schengen captcha page
3. Extracts the captcha image from the page
4. Saves the captcha image into `artifacts/`
5. Runs the local captcha model against raw and processed captures
6. Submits the best 4-character model candidate automatically and retries captcha when needed
7. If captcha UI disappears after submit, treats that as a post-captcha transition instead of re-entering captcha logic
8. Selects the three post-captcha dropdowns
9. Detects either real `Termin` options or the final Polish “all reserved” state
10. Saves `post-captcha-before-selection` and `post-captcha-after-selection` artifacts
11. Prints compact JSON like:

```json
{
  "checkedAt": "2026-04-03T12:34:56.000Z",
  "isAvailable": false,
  "reason": "all_dates_reserved",
  "availableDateCount": 0,
  "optionTexts": [],
  "pageUrl": "https://secure.e-konsulat.gov.pl/..."
}
```

12. Prints one final Chinese summary line:
    `有预约时间` or `没有预约时间`

## Result Reasons

- `date_options_present`: `Termin` contains real selectable entries
- `all_dates_reserved`: the page shows the exact Polish “all reserved” message
- `captcha_step`: the page is still waiting for captcha input
- `selection_step`: the post-captcha dropdown page is visible but no final date evidence exists yet
- `imperva_challenge`: the site appears blocked by anti-bot middleware
- `unknown_or_waiting`: the page loaded, but neither date options nor the reserved message could be confirmed

## Notes

- `check` is now fully automated around the local captcha model. The terminal no longer blocks waiting for manual captcha correction.
- `check` now loads `artifacts/captcha-model-current/model.json` by default and submits the best local-model guess on each attempt.
- The captcha alphabet remains restricted to known 4-character symbols, including `@`, `+`, `=`, and `#`.
- The page runtime exposes both raw and processed captcha captures so the local model can score multiple variants before the next retry.
- Post-captcha snapshots now include field diagnostics for `Rodzaj usługi`, `Lokalizacja`, `Chcę zarezerwować termin dla`, and `Termin`, including control type, current text, and visible option texts.
- Post-captcha snapshots now also include `selectionLabelEvidence`, so the CLI can stop captcha retries as soon as the next-step labels are visible.
- The post-captcha selector runtime now falls back to the visible vertical order of the four `mat-select` controls when the live page does not expose usable label text around each dropdown.
- Final “all reserved” detection now also falls back to normalized `bodyTextSample/bodyTextTailSample`, so the Polish result is still recognized even when runtime-level `unavailabilityText` is temporarily empty.
- Positive hits still use desktop notification support when enabled.
- Debug mode is intentionally verbose; normal `check` output is intentionally compact.
- `npm run schedule:launchd` writes a shell script, a `.plist`, and an `INSTALL.md` guide into `artifacts/launchd/`.
- The generated `launchd` bundle does not install itself automatically; you still copy the `.plist` into `~/Library/LaunchAgents/` when you are ready.

## macOS Scheduling

Run:

```bash
npm run schedule:launchd
```

It generates:

- `artifacts/launchd/run-check-every-2-hours.sh`
- `artifacts/launchd/<label>.plist`
- `artifacts/launchd/INSTALL.md`

The shell script runs one `check` per launchd trigger, and the plist uses `StartInterval=7200` so macOS runs it every 2 hours.

## Post-Captcha Artifacts

- When `check` gets past captcha, it now writes JSON artifacts like:
  - `artifacts/chrome-status-...-post-captcha-before-selection.json`
  - `artifacts/chrome-status-...-post-captcha-after-selection.json`
- These files include:
  - the normalized page snapshot
  - field diagnostics for the four key dropdowns
  - selection action results for service / location / people count
  - page text samples and final availability signals

## Captcha Collection

- `npm run captcha:collect` saves a labeling dataset under a fresh directory like `artifacts/captcha-collection-.../`.
- Each sample keeps the preferred labeling image plus any extra captcha capture variants that were available.
- Each sample entry in `labels.json` now also stores `signatureHash`, `refreshMethod`, `refreshContext`, and `refreshRecordPath`, so later labeling and training can trace how that captcha image was obtained.
- Collection now waits for the captcha image to actually change after refresh, so one run does not silently save the same image 20 times.
- If `Odśwież` still fails to produce a new captcha, collection now skips saving that loop instead of writing a duplicate sample anyway.
- The refresh step now activates the visible `Odśwież` control with the same full mouse-event sequence used for custom controls, because a plain `click()` was not always enough on the live page.
- Page actions now try both the matched control and its nearest actionable ancestor, which helps when the visible label is nested inside a Material-style button wrapper.
- If DOM refresh still fails, the CLI now asks the page for the `Odśwież` button center point and falls back to a real macOS mouse click at that screen coordinate.
- A `labels.json` file is written into the same directory with blank `expectedText` fields for you to annotate.
- The same run directory now also includes a `summary.json` file with batch metrics such as `savedCount`, `uniqueSignatureCount`, `duplicateSkipCount`, `reopenCount`, and `refreshMethodCounts`.

## Captcha Labeling UI

- `npm run captcha:label` starts a local web UI for the latest available dataset and attempts to open it in your browser automatically.
- `npm run captcha:label` now defaults to [captcha-images-current-labels.json](/Users/mo.li/Workspace/poland/artifacts/captcha-images-current-labels.json) when that consolidated current-label file exists.
- `npm run captcha:suggest` runs batch OCR for entries whose `expectedText` is still empty and stores the machine suggestion in `ocrText` without marking the entry as confirmed.
- `npm run captcha:prepare-train` validates the finished labels, copies the current captcha images into `artifacts/captcha-training-current/`, writes `train.jsonl` / `val.jsonl` / `test.jsonl`, and emits a training summary with OCR baseline stats.
- `npm run captcha:train-local` rebuilds `artifacts/captcha-training-current/`, trains a pure-Node prototype classifier, and writes the model plus prediction reports into `artifacts/captcha-model-current/`.
- The UI shows one image at a time, lets you type the correct captcha text, and supports `Save` plus `Save & Next`.
- When an entry has no confirmed `expectedText` yet, the labeler now pre-fills the input with `ocrText` so you only need to confirm or correct it.
- Press `Enter` inside the captcha text field to save the current label and jump to the next image.
- If the consolidated current-label file does not exist, the labeler falls back to the newest `captcha-dataset-*` directory, then to the newest `captcha-collection-*` directory.
- To target a specific run, pass `--dataset` with either a dataset directory or a direct `labels.json` path.

## Training Export

- `npm run captcha:prepare-train` uses the current consolidated label manifest by default.
- The export directory is `artifacts/captcha-training-current/`.
- It writes:
  - `images/` with copied captcha files
  - `all.jsonl`
  - `train.jsonl`
  - `val.jsonl`
  - `test.jsonl`
  - `summary.json`
- The current split policy is deterministic and stable:
  - `train`: 80%
  - `val`: 10%
  - `test`: 10%

## Local Training

- `npm run captcha:train-local` uses the current consolidated labels by default and automatically refreshes `artifacts/captcha-training-current/` before training.
- The model output directory is `artifacts/captcha-model-current/`.
- The first local trainer is a pure-Node character prototype model:
  - decode PNG captcha images locally
  - grayscale + Otsu threshold
  - light denoise
  - split the text region into 4 glyph boxes
  - vectorize each glyph into a fixed-size occupancy grid
  - average train-split glyph vectors per character into prototypes
  - evaluate train / val / test with nearest-prototype classification
- It writes:
  - `model.json`
  - `summary.json`
  - `train-predictions.json`
  - `val-predictions.json`
  - `test-predictions.json`
- The current first-run metrics on the 206 labeled samples are:
  - `train` exact match: `0.538`
  - `val` exact match: `0.3333`
  - `test` exact match: `0.3529`
  - `train` character accuracy: `0.7544`
  - `val` character accuracy: `0.6389`
  - `test` character accuracy: `0.5735`
- This already beats the earlier OCR baseline, whose exact-match rate on suggested samples was only `0.1282`.
- Checker integration currently uses a conservative local-model gate:
  - environment flag: `USE_LOCAL_CAPTCHA_MODEL=true`
  - default model path: `artifacts/captcha-model-current/model.json`
  - default max average distance: `50`
  - default captcha retries in `check`: `5`

## Refresh Diagnostics

- `npm run captcha:diagnose-refresh` creates a directory like `artifacts/captcha-refresh-diagnostic-.../`.
- Each attempt writes:
  - a JSON record with pre/post captcha signatures, chosen refresh method, matched refresh candidates, button metadata, and fallback errors
  - before/after captcha images for raw and processed variants
- The run also writes a `summary.json` file with batch-level counts so we can judge whether Phase A is actually improving refresh reliability.
- The refresh diagnostic JSON now includes a broader candidate list for visible `Odśwież` text matches, including each node's actionable ancestor descriptions and screen click point.
- If no refresh candidate matches at all, the same JSON now also includes the page's visible actionable controls with their search texts and click points, so we can inspect raw button text without opening DevTools live.
- Refresh-target matching is now more tolerant of Unicode/diacritic variants and duplicated button text such as `Odśwież Odśwież`, which showed up in the live Material button markup.

## Accessibility Note

- The real-click captcha refresh fallback may require macOS Accessibility permission for your terminal or Codex app:
  `System Settings > Privacy & Security > Accessibility`
