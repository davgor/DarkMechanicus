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
| 6 | Magos continuity across the restart | See [check 6](#check-6-magos-continuity-reconstruction) | The same session id was reopened after the restart, but the prior transcript and chat record no longer exist. The fixed restart message cannot be shown, and the resumed Magos aborted after 3 minutes. The outgoing build (v0.83.0) predates s1-resume. | **not verifiable for S1→S2 (outgoing build predates s1-resume) — deferred to S2→S3** |

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

### Verdict: **GO**

**Amended criterion.** The Magos amended DM-830 criterion c3 on 2026-11-27, after this check found the S1→S2 continuity check structurally unverifiable. The amended text:

> Installed Windows header, registry DisplayVersion and installed executable ProductVersion identify vX or later after the person-controlled update restart. Magos continuity (same sessionId, prior transcript survives) is verified when the outgoing build already contains s1-resume; for S1→S2 the outgoing build (v0.83.0) predates s1-resume, so the report records check 6 as not verifiable with the reconstructed evidence and continuity is first verified at the S2→S3 check. S1 get_capabilities alone never decides the verdict.

Checks 1 to 5 pass:

- I is on `origin/main` through squash PR #98, whose tree is identical to I.
- Deploy run 45898210064 succeeded.
- v0.87.0 is published, not a draft and not a prerelease, with the Setup exe and `latest.yml`.
- The installed header, the registry `DisplayVersion` and the exe `ProductVersion` all read 0.87.0 after the person's update restart at 01:09Z.

Check 6 is **not verifiable for S1→S2, because the outgoing build predates s1-resume; it is deferred to S2→S3**. The reconstructed evidence above is kept as found:

- Run 1's Magos (`chat_23eed196…`, session `01a209c6…`) has no surviving transcript or chat record.
- The fixed restart message cannot be shown, and no pre-restart record exists.
- The resumed session aborted after 3 minutes.
- The S1 resume path (s1-resume, shipped in v0.87.0) could not run for this restart, because the outgoing build was v0.83.0.

**Carried to S2 → S3.** Magos continuity is first verified at the S2 → S3 check (s3-delivery). The outgoing build for that restart (≥ v0.87.0) contains s1-resume. Before the person presses Restart now, the Magos appends its `pre-restart: chatId=… sessionId=… lastItemId=…` line here, and the check compares against it.

Nothing was restarted, installed, rerun or dispatched by this check.

## S2 → S3 (2026-11-27)

- **Ticket:** DM-849. Run `rn_01m8dkxc4sq5042d6k76q2r5x3` (run 2, plan revision 16 `rv_01m8drz8d8qqz934xa0c2vjy63`) checked attempt `at_01m8eb7pqj257vapqvnq907cpf`, claimed 2026-11-27T11:11:18.771Z (event 3350 `attempt.claimed`).
- **Host:** Windows 10.0.26200 x64, Central Standard Time (UTC-6). The checks ran in worktree `C:\Users\davgo\dmwork\dm2-849` on branch `work2/dm-849`, based on `sprint/agent-gui-s3` @ `105665c3`.
- **S2 increment (I):** `945956f1fa478867a878fce93f4129909bc4c503` on `epic-agent-gui-chat`, "Sprint 2: structured sprint delivery (ep_01m7wwrct94nzbeskqarzqevc9)". It comes from `get_run` `increments[]` with `sprintOrdinal: 2` (DM-766, attempt `at_01m8e2gwwvzzakh4xzp9vsn1mh`, `attemptState: accepted`, `passed: true`).
- **Merge commit (M):** `8b487d7f5fa16829b87ea03b00692ec5432f3a0f`. It is PR #102, squash-merged.
- **Release:** `v0.88.0`. The release commit is `20bcc083ea1c047830191aee35db31de9c0fb39a`.

### Checks

| # | Check | Exact command | Output excerpt | Verdict |
|---|---|---|---|---|
| 1a | Fetch | `git fetch origin --tags --prune` | exit 0. `origin/main` = `20bcc083…`, `origin/epic-agent-gui-chat` = `945956f1…` = I. | pass |
| 1b | Saved sprint declares no structured delivery | `get_plan {epicId: ep_01m7wwrct94nzbeskqarzqevc9, revisionId: rv_01m8drz8…, view: saved}` and `get_run` | Revision 16, `contentHash sha256:e6f8bce62ac352ca7990ec1ecc5067839c9116e9483be0b79e8f3216ef09003b`. `bundle.sprints[1..5]`: no sprint has a `delivery` key (`hasOwnProperty('delivery')` false for all five). The only two `"delivery":` strings are Delivery Standards prose (`cardTicket`, `epicTicket`). `get_run`: `deliveries: []`, `revisionId` still `rv_01m8drz8…`. The S2 feature (`sprintDelivery`, `src/core/schemas.ts:283`) on main creates no hold: `schemas.ts:375` "a sprint without a delivery keeps its saved shape and hash". These checks are the manual, text-ticket path. No structured verifier output exists for this epic, so none is used. | pass |
| 2a | PR into main that holds I | `gh pr list --repo davgor/DarkMechanicus --state merged --head epic-agent-gui-chat --json number,mergeCommit,mergedAt,baseRefName` | `{"baseRefName":"main","mergeCommit":{"oid":"8b487d7f5fa16829b87ea03b00692ec5432f3a0f"},"mergedAt":"2026-11-27T09:36:52Z","number":102}` (and #98 from S1) | pass |
| 2b | PR #102 head (cross-check) | `gh pr view 102 --repo davgor/DarkMechanicus --json number,title,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt,state,url` | `"headRefName":"epic-agent-gui-chat","headRefOid":"945956f1fa478867a878fce93f4129909bc4c503","baseRefName":"main","state":"MERGED","url":"https://github.com/davgor/DarkMechanicus/pull/102"`. The PR head is exactly I. | pass |
| 2c | M is on main | `git merge-base --is-ancestor 8b487d7f… origin/main` (`origin/main` = `20bcc083…`) | exit 0 | pass |
| 3a | M carries I (ancestry) | `git merge-base --is-ancestor 945956f1… 8b487d7f…` | exit 1: squash merge. `8b487d7f` has the single parent `55c5bef5fedbdda30d7303496d661e08ed29ab5d` (the v0.87.0 release commit). | squash, so 3b applies |
| 3b | Squash rule (Fix 32) | `T = M^1 = 55c5bef5…`; `B = git merge-base I M^1` = `55c5bef5…`. For each `p` in `git diff --name-only --no-renames I^ I`: pass if `git diff --quiet I M -- p`; otherwise pass as "merged with target changes" if `! git diff --quiet B T -- p`; otherwise fail. | `I^..I`: 246 paths, identical=246, merged-with-target=0, fail=0. Over the whole sprint (`B..I`): 246 paths, identical=246, merged-with-target=0, fail=0. `git rev-parse I^{tree} M^{tree}` gives `4412a6e79ffdd241215ed2570f3dd0023b1054a9` for both, and `git diff --quiet I M` exits 0, so the trees are identical. (`git cherry M I` prints `- 945956f1…`, recorded only; it is not the proof.) | pass |
| 4a | Deploy run for M | `gh run list --repo davgor/DarkMechanicus --workflow deploy.yml --branch main --limit 5 --json databaseId,headSha,status,conclusion,event,createdAt`; `gh run view 45976225288 --json headSha,conclusion,jobs` | First run: `45976225288`, `headSha` = M, `event: workflow_run`, `status: completed`, `conclusion: success`, created 2026-11-27T09:44:29Z. Jobs should_deploy, prepare, package-windows, package-mac and release are all success. `prepare` ran, so the gate decided `deploy=true`. | pass |
| 4b | CI for M | `gh run list --repo davgor/DarkMechanicus --commit 8b487d7f… --json databaseId,workflowName,conclusion,event` | Deploy https://github.com/davgor/DarkMechanicus/actions/runs/45976225288 success. CI Checks https://github.com/davgor/DarkMechanicus/actions/runs/45975175404 success (push). Dead Code Check https://github.com/davgor/DarkMechanicus/actions/runs/45975175373 success (push). | pass |
| 4c | First release after M | `git log origin/main --ancestry-path 8b487d7f..origin/main --grep "^chore: release v" --reverse --format="%H %s %cI"` | First line: `20bcc083ea1c047830191aee35db31de9c0fb39a chore: release v0.88.0 [skip ci] 2026-11-27T09:45:05Z`, so vX = **v0.88.0**. | pass |
| 4d | Tag contains M; version matches | `git tag --contains 8b487d7f…`; `git log -1 --format='%H %P %s %cI' 'v0.88.0^{commit}'`; `git show v0.88.0:package.json` | `v0.88.0` (the only tag). The tag commit `20bcc083…` has parent M and the message `chore: release v0.88.0 [skip ci]`. `"version": "0.88.0"` | pass |
| 4e | Release published | `gh release list --repo davgor/DarkMechanicus --limit 3 --json tagName,publishedAt,isDraft,isLatest` | `{"isDraft":false,"isLatest":true,"publishedAt":"2026-11-27T09:49:53Z","tagName":"v0.88.0"}` | pass |
| 4f | Release assets | `gh release view v0.88.0 --repo davgor/DarkMechanicus --json tagName,isDraft,isPrerelease,publishedAt,url,assets` | `isDraft:false, isPrerelease:false`. Assets: `DarkMechanicus-Setup-0.88.0.exe` (138992216 bytes), `DarkMechanicus-Setup-0.88.0.exe.blockmap`, `latest.yml`, `latest-mac.yml`, `DarkMechanicus-0.88.0-Portable.exe`, both dmgs with blockmaps and `builder-debug.yml`. The package.json `build.nsis.artifactName` is `${productName}-Setup-${version}.${ext}`. URL: https://github.com/davgor/DarkMechanicus/releases/tag/v0.88.0 | pass |
| 5a | Server version (informational only, Fix 33) | None | Not used: Fix 33 makes it informational. The verdict rests on 5(b) to 5(f). | informational |
| 5b | Registry DisplayVersion | `powershell -NoProfile -Command "Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* \| Where-Object DisplayName -like 'DarkMechanicus*' \| Select-Object PSChildName,DisplayName,DisplayVersion,InstallLocation,UninstallString,Publisher \| ConvertTo-Json"` | `"PSChildName":"f8f71462-fd74-5b21-bb31-533505104320","DisplayName":"DarkMechanicus 0.88.0","DisplayVersion":"0.88.0","InstallLocation":null,"UninstallString":"\"C:\\Users\\davgo\\AppData\\Local\\Programs\\dark-mechanicus\\Uninstall DarkMechanicus.exe\" /currentuser","Publisher":"davgor"`. HKLM (incl. WOW6432Node): 0 matches. 0.88.0 ≥ 0.88.0. | pass |
| 5c | Installed exe ProductVersion | `Test-Path "$env:LOCALAPPDATA\Programs\DarkMechanicus\DarkMechanicus.exe"`; `(Get-Item 'C:\Users\davgo\AppData\Local\Programs\dark-mechanicus\DarkMechanicus.exe').VersionInfo` | The ticket's planned path `…\Programs\DarkMechanicus\` does not exist (`False`). The real install folder is `…\Programs\dark-mechanicus\`, per the `UninstallString`. There: `ProductVersion 0.88.0.0`, `FileVersion 0.88.0`, `ProductName DarkMechanicus`. Exe and `resources\app.asar` LastWriteTimeUtc 2026-11-27T09:46:34Z (build time). The asar `package.json`, read with the installed exe under `ELECTRON_RUN_AS_NODE`, gives `dark-mechanicus 0.88.0`. The asar (sha256 `c667ef21…835c9`) contains the S2 field `verifyInstalled` 15 times, and `git grep -l verifyInstalled` finds it in 0 files of v0.87.0 and 30 files of v0.88.0. 0.88.0 ≥ 0.88.0. | pass |
| 5d | Install / process provenance | `Get-CimInstance Win32_Process -Filter "Name='DarkMechanicus.exe'"` (main process only); `Get-Process DarkMechanicus \| Where-Object MainWindowTitle \| Select-Object Id,Path,StartTime,MainWindowTitle` | Main process PID 11000 runs `"C:\Users\davgo\AppData\Local\Programs\dark-mechanicus\DarkMechanicus.exe" --updated`, created 2026-11-27T11:09:31.377Z, main window title "Dark Mechanicus". The path is inside the install folder from 5(b). It started 1 h 19 min after `publishedAt` 2026-11-27T09:49:53Z. | pass |
| 5e | Installed header | Window capture of PID 11000 (`PrintWindow`), cropped to the sidebar header | The header reads `DARK MECHANICUS … v0.88.0`. Screenshot attached as attempt evidence (`dm849-header.png`). | pass |
| 5f | Update restart was person-controlled | `%APPDATA%\dark-mechanicus\logs\main.log` | Local UTC-6: `05:09:12.243 Found version 0.88.0`, then block maps old `v0.87.0/DarkMechanicus-Setup-0.87.0.exe.blockmap` → new v0.88.0 (so the outgoing build was **v0.87.0**). Then `05:09:18.223 New version 0.88.0 has been downloaded`, `05:09:19.224 Restart resume marker written for 1 orchestrator chat(s).`, `05:09:19.225 Install on explicit quitAndInstall`, `Executing …DarkMechanicus-Setup-0.88.0.exe with args: --updated,/S,--force-run`, and `05:09:39.189 Restart resume sent chat chat_5c20535d-0320-4e28-8410-04e775097d19 the restart message.` In UTC: quitAndInstall 11:09:19Z, after publication at 09:49:53Z. | pass |
| 6 | Magos continuity across the restart | See [check 6](#check-6-magos-continuity-s2--s3) | Same chat, same sessionId, same transcript and session file. The fixed restart message arrived as a user item, and the Magos continued the run. | pass |
| 7 | Claim order (Fix 64) | `list_events {runId}` | PR #102 merged 09:36:52Z, Deploy published v0.88.0 09:49:53Z and the S2 report `rp_01m8e74x0peaak4kecw4hjt3a8` was saved 09:59:52Z, all before the checkpoint. Restart now 11:09:19Z, then the restart message 11:09:39.108Z, then `checkpoint.approved` 11:10:05.943Z (seq 3343, `approvalId ap_01m8eb5fkpg8m65vatxaw8z9ey`, report `rp_01m8e74x…`), then `checkpoint.advanced` 11:10:05.964Z (`policy: human`), then this ticket's `attempt.claimed` 11:11:18.771Z. The claim came after all three conditions. | pass |
| 8 | s1-resume handles a legacy terminal Magos (Fix 60) | `npx vitest run src/main/agentChat/restartResume.test.ts src/main/agentChat/restartResume.wiring.test.ts` (in this worktree, `105665c3`) | `Test Files 2 passed (2)`, `Tests 46 passed (46)`. This includes `switches a legacy terminal Magos with a run to the GUI before resuming it once` and `lists only the live run-bound orchestrator chats, GUI and legacy terminal, of every tracked folder`. `restartResume.ts:159-160` switches with `setSurface(ref, 'gui')` when `chat.surface !== 'gui'`; v0.87.0 already has the same switch (`git show v0.87.0:src/main/agentChat/restartResume.ts`, line 156). The chat checked here was a GUI chat (`surface: "gui"`), so this restart did not use the switch. | pass |

### Check 6: Magos continuity (S2 → S3)

**Pre-restart record (Fix 73).** The S2 sprint report `rp_01m8e74x0peaak4kecw4hjt3a8` (`get_sprint_report`, `contentHash sha256:aa7aba0f…bcbe`, created 2026-11-27T09:59:52.598Z) states in its summary:

> Pre-restart record for the S2->S3 continuity check (Fix 73): this Magos is chatId=chat_5c20535d-0320-4e28-8410-04e775097d19, sessionId=01a21b3e-b51c-77d1-b89d-0b423dd491b7, surface gui, transcript %APPDATA%\dark-mechanicus\agents\chats\2533781e6011d5e1db813969\chat_5c20535d-0320-4e28-8410-04e775097d19.jsonl; items continue to be appended until the person's Restart now.

The record names no `lastItemId`, because items were still being appended. The last pre-restart item is therefore taken from the transcript below.

**Chat record.** In `%APPDATA%\dark-mechanicus\agents\chats\2533781e6011d5e1db813969\index.jsonl` (11 lines), `chat_5c20535d…` has these records:

- Line 10, the last before the restart: `sessionId "01a21b3e-b51c-77d1-b89d-0b423dd491b7"`, `runId rn_01m8dkxc4sq5042d6k76q2r5x3`, `role orchestrator`, `surface "gui"`, `updatedAt 2026-11-27T04:23:45.028Z`, `grantIds ["gr_01m8dkxcfqfnws6f0argq70ydb"]`, `sessionStarted true`, `kickoffSent true`.
- Line 11, written by the restart resume: the same `sessionId "01a21b3e-b51c-77d1-b89d-0b423dd491b7"`, run, role and `surface "gui"`, with `updatedAt 2026-11-27T11:09:37.040Z` and the fresh grant `grantIds ["gr_01m8eb4j6g3rq9dy2efr0v3vea"]`.

**Transcript.** `chat_5c20535d-0320-4e28-8410-04e775097d19.jsonl` survives. When read at 11:22Z it had 153,638 items.

| Line | Kind | id | at (UTC) | Content |
|---|---|---|---|---|
| 1 | user_message | `3b27d4ff-301c-4598-b0e0-5681638c50fd` | 2026-11-27T04:23:44.582Z | Kickoff: "Run this Dark Mechanicus epic as its orchestrator…" |
| 152,651 | assistant_text | `omp:ecd25f23-7d2e-4be2-9a92-ab62fbe7dc68:main:message:635:0` | 2026-11-27T10:17:17.518Z | "Still blocked on your Sprint 2 checkpoint approval…". This is the last item before the restart and the latest `at` among lines 1 to 152,651. |
| 152,652 | user_message | `53949094-590a-44f9-b293-6c92bbbcea4f` | 2026-11-27T11:09:39.108Z | `[App restarted after an update from v0.87.0 to v0.88.0: resume your run from get_run]` |
| 152,653 | tool_call | `toolu_0111Rpi2MrxTuWzx8LUm5URM` | 2026-11-27T11:09:44.349Z | The resumed Magos runs `get_run rn_01m8dkxc4sq5042d6k76q2r5x3` |
| 152,680 | user_message | `b395e0e6-ebcc-4785-b547-e6ea7984ddc4` | 2026-11-27T11:10:30.184Z | The person: "Good work here, sprint approved, you may start on sprint 3." |

The transcript has exactly 3 user_message items (lines 1, 152,652 and 152,680), so nothing else was typed into the chat at the restart.

**Session.** The OMP session file is `%APPDATA%\dark-mechanicus\agents\omp\chat_5c20535d…\sessions\2026-11-27T04-23-44-156Z_01a21b3e-b51c-77d1-b89d-0b423dd491b7.jsonl`, and it is the only session file. It contains the restart text (3 matches).

- `~/.omp/logs/omp.2026-11-27.15772.log` (pid 15772, the pre-restart process) logs `Session exit recorded`, `sessionId 01a21b3e…`, `reason: dispose` at 05:09:19.908 local (11:09:19.908Z), the moment of quitAndInstall.
- `~/.omp/logs/omp.2026-11-27.296.log` (pid 296, created 11:09:38Z) carries the **same sessionId `01a21b3e-b51c-77d1-b89d-0b423dd491b7`** from 11:09:42Z, model `claude-opus-5-5`. At 11:11:40Z it runs a subagent (this ticket's worker).

**Result.**

| Item | Finding |
|---|---|
| Same chatId as the pre-restart record | Yes: `chat_5c20535d-0320-4e28-8410-04e775097d19` |
| Same sessionId before and after | Yes: `01a21b3e-b51c-77d1-b89d-0b423dd491b7`, in index lines 10 and 11, the session file name and both OMP logs |
| Surface | `gui` before and after |
| Prior transcript survives | Yes: lines 1 to 152,651 are intact, and the last pre-restart item is at 10:17:17.518Z |
| Fixed restart message delivered by restart-resume | Yes: line 152,652 at 11:09:39.108Z, matching `main.log` `Restart resume sent chat chat_5c20535d… the restart message.` at 11:09:39.189Z |
| The Magos continued its run | Yes: `get_run` at 11:09:44Z, then the S3 claim of this ticket at 11:11:18Z |

### Verdict: **GO**

- I is on `origin/main` through squash PR #102 (M = `8b487d7f`). M's tree is identical to I's, and all 246 paths pass the Fix 32 rule.
- Deploy run 45976225288 succeeded. The first release after M is **v0.88.0**, published 2026-11-27T09:49:53Z, not a draft and not a prerelease, with `DarkMechanicus-Setup-0.88.0.exe` and `latest.yml`.
- The installed header, the registry `DisplayVersion`, the exe `ProductVersion` and the asar version all read 0.88.0. The running app is PID 11000 from the registry's install folder, started 11:09:31Z with `--updated`, after publication and after the person's Restart now.
- The Magos kept its chatId, sessionId, surface and transcript across the v0.87.0 → v0.88.0 restart and received the fixed restart message. This closes the continuity check deferred from S1 → S2.
- The saved plan (revision 16) declares no structured sprint delivery. This check used the manual path and changed no plan, hash or hold.

```json
{"gate":"S2->S3","increment":"945956f1fa478867a878fce93f4129909bc4c503","mainCommit":"8b487d7f5fa16829b87ea03b00692ec5432f3a0f","release":"v0.88.0","installedVersion":"0.88.0","processStart":"2026-11-27T11:09:31.377Z","verdict":"GO"}
```

**Not repeated here.** The S2 packaged journey was run before the checkpoint, in the extracted v0.88.0 Portable with an isolated profile: 17 steps, recorded in the S2 report's deployment verification. This check did not launch a second instance of the person's installed app, which stays read-only. It confirms only that the installed asar carries the S2 code (5c).

Nothing was restarted, installed, rerun or dispatched by this check.
