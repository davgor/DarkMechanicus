# Epic criterion s5: OMP in the pane vs the same OMP in a standalone terminal

Criterion: "OMP's TUI in the pane matches the same OMP version in a standalone terminal on true color, wide and emoji
glyphs, its key bindings and its theme colors, shown by side-by-side screenshots."

**Verdict: met**, with the differences listed under "Differences" (none is a theme-colour difference). One caveat on how the
colours were compared: the app has to be launched with Chromium's `--force-color-profile=srgb` for the pixels to be
byte-identical on this machine; without it the whole Electron window (plain DOM too) is colour-managed by the display
profile (see "Colour management").

## Setup
- omp 18.16.0 (`<omp install dir>/omp.exe`), both sides, same scratch `PI_CODING_AGENT_DIR` (mock model via
  local OpenAI-style server on 127.0.0.1:18405, `scripts/mock.mjs`, fixed reply with CJK, emoji, markdown, code; theme
  `skitarii.json` installed in `agent/themes`), same folder (a scratch git repo that the app had initialised).
- **App side**: packaged `omp-s3/release/win-unpacked/DarkMechanicus.exe` (sprint 3 code = epic head), throwaway
  `--user-data-dir`, a new Skitarii chat via the sidebar "New chat" button. Command line the app ran (captured from the
  process): `omp.exe --cwd <repo> --append-system-prompt <ud>\agents\instructions\chat_*.md --config <ud>\agents\omp\chat_*\config.yml
  -e <release>\resources\skitarii\extension\index.ts --session-dir <ud>\agents\omp\chat_*\sessions`, env per `terminalEnv.ts`
  (`TERM=xterm-256color`, `COLORTERM=truecolor`, `PI_FORCE_HYPERLINKS=1`, `PI_FORCE_SYNC_OUTPUT=1`).
- **Standalone side**: Windows Terminal 1.25.2733.0 x64 portable zip, downloaded from
  github.com/microsoft/terminal/releases/download/v1.25.2733.0/ ; sha256 `bf3ef2012f6c44d8340a4c58125acc9498d19b580f9890dc043cdf831852e796`
  equals the release asset's published digest. Extracted to a scratch folder with `.portable`, own `settings\settings.json`
  (`wt-settings.json` here; WT re-saved it in its own formatting at load). `wt-launch.cmd` starts the same omp line with the same env
  (own overlay copy of the app's `config.yml`, own session dir).
- **Theme colours used**: `window.dm.ompTerminalTheme()` read from the running app returned exactly: background #100d0c, foreground #ece6da, cursor
  #ea4134 (colors.accent), cursorAccent #100d0c, selectionBackground #b51a1f, ANSI 0-15 = #2c2520 #e0574f #84c20a #d69b4a #6aa7ff #c78bd8 #4cc7a8
  #c9c1b2 #797165 #f07068 #a5dc3a #f2d7ae #93c0ff #e0a8ee #84d6be #f5f0e6. The WT scheme "Skitarii" has these 21 values.
- **Font/size**: `--font-mono` is `"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`, 13 px (`xtermKit.ts`).
  IBM Plex Mono is neither bundled nor installed here; I measured the pane's font stack in the page (canvas measureText:
  7.147 px/char at 13 px, same as `Consolas` and the generic `monospace`; `ui-monospace` alone does not resolve). So the pane renders in
  **Consolas 13px** and the WT profile uses Consolas 9.75pt (= 13 px). Pane = 169x45 cells (ConPTY size read from the omp process), so
  the WT window is 169x45 too (`initialCols/Rows`). Display scale on this machine is 150%.

## Screens (same sequence both sides)
1. Startup banner. 2. Prompt `hello skitarii`, mock reply (wide CJK, emoji, bold, inline code, link, code block, status line).
3. **Shift+Tab** (thinking-effort binding; OMP answers "Current model does not support thinking" on both, same text, same place; sprint 1 used the same key).

Images (native pixels; terminal area cropped from `PrintWindow` captures of only the one window each):
- **`composite-reply.png`** (main one), `composite-start.png`, `composite-shifttab.png`: left app pane 1690x1035, right WT 1859x1035, labelled.
- `composite-windows.png`: both whole windows (app incl. sidebar/header; WT incl. title bar), reply screen.
- Sources: `s-app-{start,reply,shifttab}.png` (app, sRGB-forced), `a-wt-start.png`, `b-wt-reply.png`, `c-wt-shifttab.png` (WT). `glyphs-zoom.png`: 1:1 strips of the reply line, the code block and the status line, app above WT.
- `*-default-colour-managed.*` and `a/b/c-app-*.png`: the same run with the app launched without the colour switch (see below).

I looked at every composite. Left and right show the same OMP screen: identical line breaks and layout (user message band, reply, bullet list, code block with
purple `const`, status line `Mock One > ...\repo > master ?4 -0.0% ---|--- 128K`), same cell grid. CJK glyphs take two cells each and line up with the ASCII text;
the full-width `wide` is spaced two cells per letter on both; emoji show as the same coloured glyphs (skin-tone thumbs-up, flame, green check) and the
grey text-presentation hammer-and-wrench and gear. The banner shows the same red hooded mascot (pixel art, half-blocks) with the green eye, `S K I T A R I I` and the brass
subtitle. After Shift+Tab both show the dim line "Current model does not support thinking" and the status line moved down two rows. The window frames differ (the app has its
sidebar and header; WT only a title bar), as expected.

## Colour table (app launched with `--force-color-profile=srgb`), `colors.md`
| point | app pane | standalone WT | diff R,G,B (app-WT) |
|---|---|---|---|
| terminal background (cell 80,30) | #100d0c | #100d0c | 0, 0, 0 |
| message box bg, OMP userMessageBg (cell 80,1) | #28211d | #28211d | 0, 0, 0 |
| foreground text, modal glyph colour "Skitarii acceptance reply" (cols1-25,row4) | #ece6da | #ece6da | 0, 0, 0 |
| brass text, modal glyph colour "inline code" (cols109-119,row4) | #d69b4a | #d69b4a | 0, 0, 0 |
| status-line segment bg (mode, cols0-20,row13) | #1c1816 | #1c1816 | 0, 0, 0 |
| crimson: cursor block (#ea4134), cell (3,14) | #ea4134 | #ea4134 | 0, 0, 0 |
| mascot: most crimson sample, cell (9,11) upper | #f01419 | #f01419 | 0, 0, 0 |
| mascot: greenest sample (eye), cell (10,8) upper | #54cf0b | #54cf0b | 0, 0, 0 |
| mascot: brightest sample (hood highlight), cell (18,7) upper | #fef7e2 | #fef7e2 | 0, 0, 0 |
| banner brass subtitle "The Omnissiah..." modal glyph colour (cols35-60,row9) | #d69b4a | #d69b4a | 0, 0, 0 |

Text rows are "modal colour of glyph pixels" (anti-aliased edges differ by renderer, solid stems do not). **True colour:** the mascot is 24-bit pixel art;
`mascot-stats.txt`: 473 half-cell samples (every non-background half cell in the banner, cell-aligned): mean and max |difference| 0 in all channels, 473 of 473 identical.

## Differences found (honest list)
1. **Cell width: app 10 px, WT 11 px** (device px, 150% scale; same cols x rows, so the WT window is 1859 px wide vs 1690). Chromium floors the 7.147 px/char Consolas advance to 10 device px, WT rounds
   to 11. I tried `font.cellWidth` ("6.6667px", then "0.5128") in WT 1.25; it had no effect, so I removed it. Not a colour difference.
2. **The path segment's icon glyph (U+1F5D1 wastebasket) is a hatched "missing glyph" box in WT** and a real wastebasket in the app (the app falls back to an emoji font). A font-fallback
   difference in WT; the status-line colours around it match.
3. **Cursor shape/phase**: both are a solid crimson block (#ea4134) when focused. WT's `cursorShape` was `bar` when the startup capture (`a-wt-start.png`) was taken, `filledBox` afterwards;
   WT's cursor blinks, so one capture (`c-wt-shifttab.png`) caught it hidden. In the first, colour-managed app run the app cursor was hollow (window not focused); in the sRGB run it was focused and solid.
4. **True-colour gradient line not shown**: I tried `!node grad.mjs` (80 cells red-brass-teal with SGR 38/48;2) in the app; OMP's `!` output path strips colour (rendered as uniform grey blocks),
   so that was dropped from both sides. True colour is shown by the mascot instead (above).
5. Only one key binding (Shift+Tab) was compared, as in sprint 1.
6. Sub-pixel text anti-aliasing differs a little between xterm's WebGL atlas and WT's DirectWrite (visible only at 1:1 zoom; solid-stem colours are equal).
7. I did not compare against the person's own installed Windows Terminal this time (sprint 1 did); only a portable copy with the same scheme.
8. Product observation, not part of the criterion: the pane's declared font IBM Plex Mono is not shipped (no @font-face), so on a machine without it the pane falls back to Consolas.

## Colour management (why `--force-color-profile=srgb`)
My first run (default launch) gave app pixels that differed from WT: background #0f0d0c vs #100d0c, cursor #d6513d vs #ea4134, brass text #cc9e57 vs #d69b4a, mascot mean |diff| 7-12 per channel, only 52 of 473 samples within 3
(`colors-default-colour-managed.md`, `composite-*-default-colour-managed.png`). A probe div with `background:#ea4134` in the plain app DOM was captured as #d7513d, `#6aa7ff` as `#7ba6f9`, `#ece6da` as `#ebe7dc`:
Chromium colour-manages the whole window to this display's profile, and the same shift hit the terminal canvas. That is not the theme; with `--force-color-profile=srgb` the probe returned the exact values and the pane matched WT byte for byte.
So on an ICC/wide-gamut display the user sees colour-managed values while WT shows the raw ones. The theme data reaching the pane is exact (`ompTerminalTheme()` above).

## Safety / hashes
- Installed Windows Terminal `settings.json` (`%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`) sha256 before and after: `700510A92BF1C156AA49E47AA3D23A6B7FD5DD6F478502E122D7675D8821B101` (unchanged).
- `~/.omp/agent/config.yml` sha256 before and after: `86D37EC2ACDA1E86D5618526FAE57CD626D05596DBC1A673436F0FD92E4D3450` (unchanged).
- The scratch agent dir's `agent.db` was copied from the earlier sprint 3 scratch dir (needed for "Signed in"; I did not inspect it; it is not committed).
- Only processes I started were stopped by PID (app 28472 and 67864 via CDP Browser.close, WT 20196/21020/42440/49300 by PID tree, the mock server by PID).
- Scripts in `scripts/` (helpers reused from sprint 3, plus `wtkeys.ps1`, `winshot.ps1`, `analyze.py`, `launch-srgb.ps1`) point at scratch paths on this machine.
