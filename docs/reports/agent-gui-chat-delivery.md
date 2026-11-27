# Agent GUI chat epic: delivery record

One section per sprint transition. Each section records the read-only commands run on the Windows host and what they printed. The verdict is GO or NO-GO. The structured `record_delivery` command arrives in Sprint 2, so these checks are run by hand.

## S1 → S2 (2026-11-27)

- **Ticket:** DM-830. Run `rn_01m8dkxc4sq5042d6k76q2r5x3` (run 2) checked attempt `at_01m8dn07tbxtxk1yarrwqcfgm5`.
- **Host:** Windows 10.0.26200 x64, Central Standard Time (UTC-6). The checks ran in worktree `C:\Users\davgo\OneDrive\Documents\Github\dm2-830` on branch `work2/dm-830`, based on `sprint/agent-gui-s2` @ `994bec6f`.
- **S1 increment (I):** `9aaa570e5e27a9502cd0009e0761cace7fe9c502` on `epic-agent-gui-chat`. Its commit message is "Sprint 1 acceptance fix: keep shared main modules free of the Electron runtime (DM-740)". It comes from run 2's `get_run` `increments[]` with `sprintOrdinal: 1`, which carries forward run 1 `rn_01m84wdvchnbc4r4tq9vyv6t0b`'s accepted DM-740 attempt. The Magos supplied it.
- **Merge commit (M):** `cac20f958014853b7b12729e6ba820461d160ad8`. It is PR #98, squash-merged.
- **Release:** `v0.87.0`. The release commit is `55c5bef5fedbdda30d7303496d661e08ed29ab5d`.

### Checks

| # | Check | Exact command | Output excerpt | Verdict |
|---|---|---|---|---|
| 1 | Fetch | `git fetch origin --tags --prune` | `- [deleted] (none) -> origin/sprint/performance-revamp-s1`, `* [new branch] sprint/cults-s1 -> origin/sprint/cults-s1`, exit 0 | pass |
| 2a | PR into main that holds I | `gh pr list --repo davgor/DarkMechanicus --state merged --head epic-agent-gui-chat --json number,mergeCommit,mergedAt,baseRefName` | `[{"baseRefName":"main","mergeCommit":{"oid":"cac20f958014853b7b12729e6ba820461d160ad8"},"mergedAt":"2026-11-26T21:19:47Z","number":98}]` | pass |
| 2b | PR #98 head (cross-check) | `gh pr view 98 --repo davgor/DarkMechanicus --json number,title,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt,state,url` | `"headRefName":"epic-agent-gui-chat","headRefOid":"9aaa570e5e27a9502cd0009e0761cace7fe9c502","baseRefName":"main","state":"MERGED","url":"https://github.com/davgor/DarkMechanicus/pull/98"`. The PR head **is** `epic-agent-gui-chat` at exactly I; no separate landing branch was involved. | pass |
| 2c | M is on main | `git merge-base --is-ancestor cac20f95… origin/main` (`origin/main` = `55c5bef5…`) | exit 0 | pass |
| 3a | M carries I (ancestry) | `git merge-base --is-ancestor 9aaa570e… cac20f95…` | exit 1: squash merge. `cac20f95` has the single parent `e3768e92ec774263165cf1ba437c8a85a3aff533`. | squash, so 3b applies |
| 3b | Squash rule (Fix 32) | `T = M^1 = e3768e92…`; `B = git merge-base I M^1` = `e3768e92…`, exit 0. For each `p` in `git diff --name-only --no-renames I^ I`: pass if `git diff --quiet I M -- p`; otherwise pass as "merged with target changes" if `! git diff --quiet B T -- p`; otherwise fail. | `I^..I`: 9 paths, identical=9, merged-with-target=0, fail=0. Over the whole sprint (`B..I`): 361 paths, identical=361, merged-with-target=0, fail=0. `git rev-parse I^{tree} M^{tree}` gives `916ed8d2…` for both, and `git diff --quiet I M` exits 0, so the trees are identical. | pass |
| 4a | Deploy run for M | `gh run list --repo davgor/DarkMechanicus --workflow deploy.yml --branch main --limit 10 --json databaseId,headSha,status,conclusion,event,createdAt` | First run: `45898210064`, `headSha` = M, `event: workflow_run`, `status: completed`, `conclusion: success`, created 2026-11-26T21:26:56Z. Jobs (`gh run view 45898210064 --json jobs`): should_deploy, prepare, package-windows, package-mac and release, all success. `prepare` ran, so the gate decided `deploy=true`. | pass |
| 4b | CI URLs | `gh run list --commit cac20f95… --json …` and `gh pr checks 98` | Deploy https://github.com/davgor/DarkMechanicus/actions/runs/45898210064 success. CI Checks on main https://github.com/davgor/DarkMechanicus/actions/runs/45897370364 success. Dead Code Check https://github.com/davgor/DarkMechanicus/actions/runs/45897370102 success. PR #98 checks https://github.com/davgor/DarkMechanicus/actions/runs/45887484666: 37 pass, 0 fail, exit 0. | pass |
| 4c | Release published | `gh release list --repo davgor/DarkMechanicus --limit 5 --json tagName,publishedAt,isDraft,isLatest` | `{"isDraft":false,"isLatest":true,"publishedAt":"2026-11-26T21:32:52Z","tagName":"v0.87.0"}` | pass |
| 4d | Release assets | `gh release view v0.87.0 --repo davgor/DarkMechanicus --json tagName,isDraft,isPrerelease,publishedAt,assets --jq '{tagName,isDraft,isPrerelease,publishedAt,assets:[.assets[].name]}'` | `isDraft:false, isPrerelease:false`. Assets include `DarkMechanicus-Setup-0.87.0.exe`, `.blockmap` and `latest.yml`, plus `latest-mac.yml`, the dmgs and `-Portable.exe`. The package.json `build.nsis.artifactName` is `${productName}-Setup-${version}.${ext}`. URL: https://github.com/davgor/DarkMechanicus/releases/tag/v0.87.0 | pass |
| 4e | Tag contains M; version matches | `git merge-base --is-ancestor cac20f95… refs/tags/v0.87.0`, `git log -1 v0.87.0^{commit}`, `git show v0.87.0:package.json` | exit 0. The tag commit `55c5bef5…` has parent M and the message `chore: release v0.87.0 [skip ci]` (2026-11-26T21:27:27Z). `"version": "0.87.0"` | pass |
| 5a | Server version (informational only, Fix 33) | `get_capabilities` through the packaged CLI `DarkMechanicus.exe …\resources\app.asar\out\main\cli.js` with `ELECTRON_RUN_AS_NODE=1` (the `dm.sh` wrapper) | Recorded in [5(a) note](#5a-server-version-informational) below. It does not decide the verdict. | informational |
| 5b | Registry DisplayVersion | `powershell -NoProfile -Command "Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* \| Where-Object DisplayName -like 'DarkMechanicus*' \| Select-Object PSChildName,DisplayName,DisplayVersion,InstallLocation,UninstallString,Publisher \| ConvertTo-Json"` | `"PSChildName":"f8f71462-fd74-5b21-bb31-533505104320","DisplayName":"DarkMechanicus 0.87.0","DisplayVersion":"0.87.0","InstallLocation":null,"UninstallString":"\"C:\\Users\\davgo\\AppData\\Local\\Programs\\dark-mechanicus\\Uninstall DarkMechanicus.exe\" /currentuser","Publisher":"davgor"`. HKLM (incl. WOW6432Node): no match. 0.87.0 ≥ 0.87.0. | pass |
| 5c | Installed exe ProductVersion | `(Get-Item 'C:\Users\davgo\AppData\Local\Programs\dark-mechanicus\DarkMechanicus.exe').VersionInfo` | `ProductVersion 0.87.0.0`, `FileVersion 0.87.0`, `ProductName DarkMechanicus`. Exe and `resources\app.asar` LastWriteTimeUtc 2026-11-26T21:29:10Z. The asar `package.json` (read with the installed exe under `ELECTRON_RUN_AS_NODE`) gives `dark-mechanicus 0.87.0`. 0.87.0 ≥ 0.87.0. | pass |
| 5d | Install / process provenance | `Get-CimInstance Win32_Process -Filter "Name='DarkMechanicus.exe'"` | Main process PID 19940 runs `C:\Users\davgo\AppData\Local\Programs\dark-mechanicus\DarkMechanicus.exe --updated`, created 2026-11-27T01:09:16.341Z, main window title "Dark Mechanicus". Its renderer and gpu children use `--user-data-dir="C:\Users\davgo\AppData\Roaming\dark-mechanicus"`. `InstallLocation` is null, so the exe path comes from the running process path and the registry `UninstallString`, which agree. | pass |
| 5e | Installed header | Window capture of PID 19940 (`PrintWindow`), cropped to the sidebar header | The header reads `DARK MECHANICUS … v0.87.0`. Screenshot attached as attempt evidence (`dm830-header.png`). | pass |
| 5f | Update restart was person-controlled | `%APPDATA%\dark-mechanicus\logs\main.log` | `18:31:36.495 New version 0.87.0 has been downloaded`, then `19:09:07.951 Install on explicit quitAndInstall`, `Executing …DarkMechanicus-Setup-0.87.0.exe with args: --updated,/S,--force-run` (local UTC-6, so 2026-11-27T01:09:07Z). The person's Restart now came after the release was published (2026-11-26T21:32:52Z). The previous installed build was **v0.83.0**: the block-map download compared against `v0.83.0/DarkMechanicus-Setup-0.83.0.exe.blockmap`. | pass |
| 6 | Magos continuity across the restart | See [check 6](#check-6-magos-continuity-reconstruction) | The same session id was reopened after the restart, but the prior transcript and chat record no longer exist. The fixed restart message cannot be shown, and the resumed Magos aborted after 3 minutes. | **fail** |

### 5(a) server version (informational)

Fix 33 makes this check informational only. On the S1 build, the CLI reports the fallback `0.0.0`. MCP may also point at a development build, so this value never decides the verdict. The launch path is the packaged CLI: `C:\Users\davgo\AppData\Local\Programs\dark-mechanicus\DarkMechanicus.exe` with `C:\Users\davgo\AppData\Local\Programs\dark-mechanicus\resources\app.asar\out\main\cli.js --repo C:\Users\davgo\OneDrive\Documents\Github\Forge-World-davgor\DarkMechanicus`. During this check, every `dm` call on the host (`heartbeat_attempt`, `get_run`) hung past 300 s, so no `get_capabilities` value was captured here. The verdict rests on 5(b), 5(c) and 5(e).

### Check 6: Magos continuity reconstruction

**Which chat.** The Magos that lived through the S1 update restart is run 1's orchestrator, not run 2's.

- `%APPDATA%\dark-mechanicus\agents\tooling-recovery.json` incident `0d94cb1f…` (`get_ready_tickets`, `runId: rn_01m84wdvchnbc4r4tq9vyv6t0b`) names the caller `chat_23eed196-7e27-4e4f-bea8-915bdd2ecc71`, folder `C:\Users\davgo\OneDrive\Documents\Github\Forge-World-davgor\DarkMechanicus`.
- `~/.omp/agent/custom-session-files/4ee29dd` maps that chat to the session file `C:\Users\davgo\AppData\Roaming\dark-mechanicus\agents\omp\chat_23eed196-7e27-4e4f-bea8-915bdd2ecc71\sessions\2026-11-23T18-59-22-495Z_01a209c6-f0ff-7350-b241-94101c84630f.jsonl`. Its **sessionId is `01a209c6-f0ff-7350-b241-94101c84630f`**.
- `get_run rn_01m84wdvchnbc4r4tq9vyv6t0b` gives `createdAt 2026-11-23T18:59:21.618Z`, which matches the session file's 18-59-22Z start. It also gives `state: canceled`, `endedAt 2026-11-27T04:23:08.490Z`, and `increments[0] = {sprintOrdinal 1, commit 9aaa570e…, branch epic-agent-gui-chat}`. Run 1 was canceled 35 s before run 2's Magos chat was created.
- The run 2 Magos is `chat_5c20535d-0320-4e28-8410-04e775097d19` (session `01a21b3e-b51c-77d1-b89d-0b423dd491b7`). The person created it at 2026-11-27T04:23:43Z, after the restart, so it is not the continuity subject.

**Real paths (Fix 40, folder-key layout).**

- The folder key for `C:\Users\davgo\OneDrive\Documents\Github\Forge-World-davgor\DarkMechanicus` is `2533781e6011d5e1db813969`: the first 24 hex digits of sha256 of the canonical path, per `src/main/agents/chatStore.ts:146`.
- The chat folder is therefore `C:\Users\davgo\AppData\Roaming\dark-mechanicus\agents\chats\2533781e6011d5e1db813969\`.
- That folder's `index.jsonl` (10 lines, last write 2026-11-26 22:23:45 local) holds records only for `chat_827d68a0…` (planner, created 01:15:40Z) and `chat_5c20535d…` (run 2 orchestrator).
- There is **no record and no transcript for `chat_23eed196…`**. `Get-ChildItem -Recurse` and `rg` over `agents\chats` find no `chat_23eed196-*.jsonl`, and no index line carries `runId rn_01m84wdvchnbc4r4tq9vyv6t0b`.
- The OMP session directory `agents\omp\chat_23eed196…\` is also gone.
- The `chatStore` delete path (`chatStore.ts:322-325`) removes both the transcript and the index lines, which matches what is on disk. [INFERENCE] The chat was deleted after the restart.

**Pre-restart record (Fix 73).** No `pre-restart: chatId=… sessionId=… lastItemId=…` line was written before the person pressed Restart now. Fix 73 came after the restart and cannot apply retroactively, so continuity is reconstructed from logs below.

**Reconstruction from the logs.** All times are UTC.

- **Before the restart:** `~/.omp/logs/omp.2026-11-26.9976.log` (pid 9976) carries session `01a209c6…` activity through 2026-11-27T00:12:12Z, on model `claude-opus-5-5` with a 1,000,000-token context window. Earlier on 2026-11-26 it records subagent exits for AcolyteDM740 and others under that session file.
- **01:09:07Z:** quitAndInstall ran. **01:09:16Z:** the app started with `--updated` (PID 19940).
- **01:10:18Z:** the instructions file `agents\instructions\chat_23eed196-7e27-4e4f-bea8-915bdd2ecc71.md` was rewritten. It now carries v0.87.0 guidance ("Update restarts: `orchestrator.restart-resume`").
- **After the restart:** `~/.omp/logs/omp.2026-11-26.8396.log` (pid 8396, started 01:10:20Z) shows the **same sessionId `01a209c6-f0ff-7350-b241-94101c84630f`**:
  - 01:12:01Z: `Pre-prompt context maintenance triggered by pending prompt size`, contextTokens 387949, contextWindow 272000, model `openai-codex/gpt-6-astra`.
  - 01:12:01Z: remote compaction failed (`estimated 285171 tokens > 272000`).
  - 01:15:22Z: `Session exit recorded … reason: dispose, pendingToolCalls: 1`; `stopReason: aborted`; `agent.continue skipped … session-unavailable`.

**Was the restart message delivered?** Probably not by the restart-resume path. `git grep restart-resume|restartResume v0.83.0 -- src` finds nothing, while v0.87.0 has `src/main/agentChat/restartResume.ts`. The marker is written by the outgoing build when the person presses Restart now, and the outgoing build was v0.83.0. [INFERENCE] So no `restart-resume.json` marker could have been written for this restart. `main.log` has no restart-resume entry between 01:09Z and 01:16Z. The prompt pending at 01:12:01Z therefore cannot be shown to be the fixed `[App restarted after an update …]` text.

**Result.**

| Item | Finding |
|---|---|
| Same sessionId before and after | Yes, per the OMP logs |
| Items before the restart | Yes, in the logs, but the transcript no longer exists |
| User message after the restart | A pending prompt existed (01:12:01Z); its text cannot be recovered |
| Chat record keeps the same sessionId | Cannot be checked: the record was deleted |
| Prior transcript survives | No |
| The Magos continued its run | No: it aborted at 01:15:22Z on context overflow after the model changed |

### Verdict: **NO-GO** (check 6)

Checks 1 to 5 pass:

- I is on `origin/main` through squash PR #98, whose tree is identical to I.
- Deploy run 45898210064 succeeded.
- v0.87.0 is published, not a draft and not a prerelease, with the Setup exe and `latest.yml`.
- The installed header, the registry `DisplayVersion` and the exe `ProductVersion` all read 0.87.0 after the person's update restart at 01:09Z.

Check 6 fails:

- Run 1's Magos (`chat_23eed196…`, session `01a209c6…`) has no surviving transcript or chat record.
- The fixed restart message cannot be shown, and no pre-restart record exists.
- The resumed session aborted after 3 minutes.
- The S1 resume path (s1-resume, shipped in v0.87.0) could not run for this restart, because the outgoing build was v0.83.0.

**Blocker for the Magos, and the person's action.** Continuity for the S1→S2 restart cannot be proven retroactively. The person should do one of the following:

- Waive check 6 for S1 → S2 on the record, because the restart came from v0.83.0, which predates s1-resume. Re-verify continuity at the S2 → S3 restart (s3-delivery), where the outgoing build will contain s1-resume.
- Or, for a direct proof now, press Restart now on a later update (≥ v0.87.x), after the Magos has appended its `pre-restart:` line.

Nothing was restarted, installed, rerun or dispatched by this check.
