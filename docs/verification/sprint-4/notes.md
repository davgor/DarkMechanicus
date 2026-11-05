# Sprint 4 acceptance, c1: packaged app, no colour flag, vs standalone Windows Terminal

Criterion: "In the packaged app launched with no extra flags, a Skitarii chat beside a standalone Windows Terminal with the Skitarii scheme (as in docs/verification/s5) shows identical sampled theme colours (background, foreground, brass, crimson cursor, status segment, mascot true-colour samples), in a labelled side-by-side screenshot and a colour table."

**Verdict: met.** Every sampled colour is identical (per-channel difference 0,0,0), and all 473 mascot half-cell samples are identical (max difference 0 in every channel).

## What ran
- Build: `npx electron-builder --win --dir` in the `omp-s4` worktree at `f2fb8e8` (Merge DM-447 into sprint 4, includes the sRGB change) -> `release/win-unpacked/DarkMechanicus.exe`.
- **Exact app command line** (checked from the running process): `DarkMechanicus.exe --user-data-dir="<scratch>\s4acc\ud" --remote-debugging-port=9444`. Only the user-data dir and the CDP port; no `--force-color-profile`, no other colour flag. Env: `DISABLE_AUTO_UPDATE=1`, `DARKMECHANICUS_HOME` and `PI_CODING_AGENT_DIR` pointing at scratch. Note: since sprint 4 the app itself appends `force-color-profile=srgb` in `src/main/windowPolicy.ts`; that is the product fix under test, not a launch flag.
- The scratch `ud` is a copy of the s5 throwaway profile minus `agents/` and caches (it holds the scratch repo folder). A new Skitarii chat was made with the sidebar "New chat" button.
- Standalone side: Windows Terminal 1.25.2733.0 portable (same copy and Skitarii scheme/profile as s5; only the profile's commandline now points at `scripts/wt-launch.cmd`, which is the s5 launcher with the omp-s4 extension path). Same scratch agent dir (`PI_CODING_AGENT_DIR`), same mock model server (127.0.0.1:18405, s5's `mock.mjs`), same scratch repo folder, same overlay config, same env (`TERM`, `COLORTERM=truecolor`, `PI_FORCE_*`). 169x45 cells on both (pane measured 1127x690 CSS px at DPR 1.5 = 1690x1035 device px at 10x23 px cells; WT 11x23 px cells).
- Screens, same sequence both sides: 1 startup banner; 2 prompt `hello skitarii` and the mock reply (CJK, emoji, brass inline code, status line); 3 Shift+Tab. Windows captured with PrintWindow, each window activated first so the cursor is in its focused state; the WT frames used are ones where its blinking cursor was visible.
- Sampling: `scripts/analyze.py` (the s5 script unchanged apart from the composite label), same cell grid origins (app 437,293 with 10x23 cells; WT 11,45 with 11x23 cells).

## Colour table (`colors.md`)
| point | app pane | standalone WT | diff R,G,B |
|---|---|---|---|
| terminal background (cell 80,30) | #100d0c | #100d0c | 0, 0, 0 |
| message box bg (cell 80,1) | #28211d | #28211d | 0, 0, 0 |
| foreground text, modal glyph colour (cols1-25,row4) | #ece6da | #ece6da | 0, 0, 0 |
| brass text, "inline code" modal glyph colour (cols109-119,row4) | #d69b4a | #d69b4a | 0, 0, 0 |
| status-line segment bg (cols0-20,row13) | #1c1816 | #1c1816 | 0, 0, 0 |
| crimson cursor block (cell 3,14) | #ea4134 | #ea4134 | 0, 0, 0 |
| mascot most crimson, cell (9,11) upper | #f01419 | #f01419 | 0, 0, 0 |
| mascot greenest (eye), cell (10,8) upper | #54cf0b | #54cf0b | 0, 0, 0 |
| mascot brightest (hood), cell (18,7) upper | #fef7e2 | #fef7e2 | 0, 0, 0 |
| banner brass subtitle modal glyph colour (cols35-60,row9) | #d69b4a | #d69b4a | 0, 0, 0 |

Mascot (`mascot-stats.txt`): 473 half-cell samples, mean and max |difference| 0 in R, G and B, 473 of 473 identical. For comparison, s5's default launch before the fix had mean differences of 7-12 per channel.

## Images (all looked at)
- `composite-reply.png` (main), `composite-start.png`, `composite-shifttab.png`: left app pane 1690x1035, right WT 1859x1035, labelled in the header ("NO colour flags"). In each I saw the same OMP screen on both sides: same cell grid and line breaks. Reply: user band `hello skitarii`, reply line with CJK two cells per glyph, spaced full-width `w i d e`, emoji (hammer-and-wrench, gear, thumbs-up, flexed arm, flame, green check box), brass `inline code`, underlined link, bullet list, code block with purple `const` and brass `42`, then status line `Mock One > ...5c-9c1e-531c9afb4fd7\scratchpad\s5\repo > master ?4 -0.0% ---|--- 128K` and a solid crimson cursor block. Start: the red hooded pixel-art mascot with green eye, `S K I T A R I I` and the brass subtitle `The Omnissiah guides this forge`, status line with `11%`. Shift+Tab: dim `Current model does not support thinking` and the status line two rows lower, both sides.
- `composite-windows.png`: both whole windows (app with sidebar/header, WT with title bar), reply screen. Frames differ as expected.
- Sources: `s-app-{start,reply,shifttab}.png`, `a-wt-start.png`, `b-wt-reply.png`, `c-wt-shifttab.png`.

## Differences (none is a colour difference)
1. Cell width 10 px (app) vs 11 px (WT), so the WT image is wider; same 169x45 grid (as in s5).
2. The path segment's icon (U+1F5D1) is a real wastebasket in the app and a hatched missing-glyph box in WT (WT font fallback), as in s5. Surrounding status colours match.
3. WT's cursor blinks; frames with it visible were chosen. Both cursors are solid #ea4134 when focused.
4. Sub-pixel anti-aliasing of glyph edges differs between xterm's renderer and DirectWrite; solid stems and all sampled points are equal. Text rows are sampled as the modal colour of glyph pixels.

## Safety / hashes (before and after, unchanged)
- `~/.omp/agent/config.yml` sha256 `86D37EC2ACDA1E86D5618526FAE57CD626D05596DBC1A673436F0FD92E4D3450`.
- Installed Windows Terminal `settings.json` sha256 `700510A92BF1C156AA49E47AA3D23A6B7FD5DD6F478502E122D7675D8821B101`.
- Only scratch paths and a throwaway user-data dir used. Processes stopped by PID: app 46164 via CDP Browser.close, WT 9848 (tree), mock server 37832. No other DarkMechanicus/omp/WindowsTerminal processes were touched (the person's own app processes were still running).
- Scripts in `scripts/` have the user name redacted as `<user>`; they target scratch paths.
