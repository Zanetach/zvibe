# Zvibe 2.1.0 Release Notes

## Features

- Reworked zellij pane framing behavior:
  - Restored visible panel borders for `project`, `commit`, and bottom state areas.
  - Improved layout profile generation with viewport-aware sizing.
- Upgraded status bar rendering for better small-screen usability:
  - Full metric set is preserved with responsive packing.
  - Added page-based metric display when one row is insufficient.
  - Added interactive page switching and overflow scrolling support.
- Restored animated utilization bars for CPU/GPU/MEM in agent mode.

## UX Improvements

- Removed unwanted side frame glyphs on the state bar line.
- Standardized right-side date/time display to include:
  - date
  - weekday
  - time
- Improved status bar resilience under narrow terminal widths while keeping visual balance.

## Validation

- `npm run verify:all`
