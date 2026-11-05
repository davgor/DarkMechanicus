@echo off
rem Same per-launch setup the app gives a Skitarii chat (terminalLaunchSpec.ompLaunch, terminalEnv): TERM, COLORTERM, PI_FORCE_*, scratch agent dir, overlay config, -e extension.
set "S=C:\Users\davgo\AppData\Local\Temp\claude\5b2748231b82b70c\46f2df57-16a2-475c-9c1e-531c9afb4fd7\scratchpad\s5"
set TERM=xterm-256color
set COLORTERM=truecolor
set PI_FORCE_HYPERLINKS=1
set PI_FORCE_SYNC_OUTPUT=1
set "PI_CODING_AGENT_DIR=%S%\agent"
"<omp install dir>/omp.exe" --cwd "%S%\repo" --append-system-prompt "%S%\ud\agents\instructions\chat_160e9dcc-3cc2-45b8-8576-6563d142ed0f.md" --config "%S%\omp-overlay.yml" -e "<build>\release\win-unpacked\resources\skitarii\extension\index.ts" --session-dir "%S%\sessions-wt"
