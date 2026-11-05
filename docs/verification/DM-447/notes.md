# DM-447: render in sRGB

Setup: `npm run build`, then `node_modules/electron/dist/electron.exe .` (the built output) with a throwaway `--user-data-dir`,
scratch `DARKMECHANICUS_HOME`, `DISABLE_AUTO_UPDATE=1`, `--remote-debugging-port`. **No Chromium colour flags.** `cap.mjs` injects a
fixed 300x200 CSS-px div with `background:#ea4134` over CDP, `Page.captureScreenshot` (app page only), `px.py` samples the pixel at
(250, 200) in the 2139x1296 capture (display scale 1.5; the div spans 60-510 x 60-360 px). Only processes started here were closed (Browser.close, then kill by PID).

## c1: unit test
`src/main/windowPolicy.test.ts` > `applyColorProfile`. With the `appendSwitch` call removed from the helper it fails on the assertion:
`AssertionError: expected [] to deeply equal [ [ 'force-color-profile', 'srgb' ] ]` (6 other tests pass); restored, 7 of 7 pass.

## c2: pixel sample
| Build | Sampled pixel for #ea4134 | Screenshot |
|---|---|---|
| Without the change (call to `applyColorProfile` commented out, rebuilt) | **#d6513d** | `c2-before-no-change.png` |
| With the change | **#ea4134** (exact) | `c2-after-srgb.png` |

(The ticket quotes #d7513d for the before; on this run the display profile gave #d6513d, the same shift.)
The "before" build was rebuilt from the restored source afterwards.

The before-state of the full app (terminal pane, mascot samples, Windows Terminal side by side) is in `docs/verification/s5/` (see below).

## c3: s5 evidence
`docs/verification/s5/` came in by cherry-picking 8e8037c. Reviewed for personal data; the only finding was the Windows user name inside
the omp.exe install path and the build path (`wt-launch.cmd`, `notes.md`, `scripts/stub.mjs`), redacted in follow-up commits. Everything else is
scratch paths under the session temp folder, mock-model data, and two SHA-256 digests (of the untouched real Windows Terminal settings and
`~/.omp/agent/config.yml`, kept as "unchanged" proof; no content). Images show only the scratch repo, "Sign in to GitHub" (not signed in), no emails or accounts.

## Image-by-image review (every PNG opened and looked at)
Common to all s5 images: the folder is the scratch `repo` under the session scratchpad (the sidebar shows only `~\AppData\Local\Temp\clau...`, no user name),
the model is "Mock One", GitHub is "Sign in to GitHub" (not signed in), and no email, account name, other window or desktop is visible.

DM-447:
- `c2-before-no-change.png`: app start page, injected div sampled #d6513d; no folders tracked, no personal data.
- `c2-after-srgb.png`: same page with the change, div sampled #ea4134; no personal data.

s5:
- `a-app-start.png`: app window, scratch `repo` folder, Skitarii banner and status line; no personal data.
- `a-wt-start.png`: standalone portable Windows Terminal, banner and status line, scratch path only; no personal data.
- `b-app-reply.png`: app window after the mock reply; no personal data.
- `b-wt-reply.png`: Windows Terminal after the mock reply; no personal data.
- `c-app-shifttab.png`: app window after Shift+Tab ("Current model does not support thinking"); no personal data.
- `c-wt-shifttab.png`: Windows Terminal after Shift+Tab; no personal data.
- `s-app-start.png`: app window start screen with 2 scratch chats; no personal data.
- `s-app-reply.png`: app window reply screen with 3 scratch chats; no personal data.
- `s-app-shifttab.png`: app window Shift+Tab screen; no personal data.
- `composite-start.png` / `composite-start-default-colour-managed.png`: labelled app-pane vs Windows Terminal banner, sRGB-forced and colour-managed; no personal data.
- `composite-reply.png` / `composite-reply-default-colour-managed.png`: labelled reply comparison; no personal data.
- `composite-shifttab.png` / `composite-shifttab-default-colour-managed.png`: labelled Shift+Tab comparison; no personal data.
- `composite-windows.png` / `composite-windows-default-colour-managed.png`: the two windows side by side (app left, Windows Terminal right) on a plain grey backdrop; no desktop, taskbar or other windows; no personal data.
- `glyphs-zoom.png`: zoomed crop of reply text and status lines; no personal data.
