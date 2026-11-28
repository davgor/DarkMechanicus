# 0009 — The in-app agent browser

- **Status:** accepted
- **Date:** 2026-11-27

## Context

Agents in GUI chats could read code and run commands, but could not look at a web page: a running dev server, a docs
site, a dashboard a ticket names. The person had to describe pages to them or paste screenshots. Giving an agent a
browser of its own puts a second, untrusted program in front of it: every page can talk to the agent, reach the
network from the person's machine and hold the person's sign-ins. The Electron behaviours the design relies on were
proven on the Windows host first ([`agent-browser.md`](../reports/agent-browser.md), DM-851).

## Decision

- **One visible browser per chat, in the app.** Each chat gets an agent tab: a native `WebContentsView` drawn over
  the right rail's **Browser** tab, in its folder's own persistent partition (`persist:dm-browser-<folderStoreId>`,
  never the default session). The person sees every page the agent opens, live.
- **Agents drive it only through seven narrow commands.** `browser_status`, `browser_navigate`, `browser_click`,
  `browser_type`, `browser_press`, `browser_read` and `browser_screenshot`, as `dm call` / `dm_call` and as MCP tools.
  Each needs `browser.drive`, which only the orchestrator and worker roles hold and the desktop never does. Main
  executes them over `webContents.debugger` with a fixed set of CDP commands (the report's GO list) on the chat's
  own browser pipe (`DM_BROWSER_PIPE`), never the naming pipe.
- **The person decides every new site.** An origin that is neither on the folder's **Always allow** list nor allowed
  once for this tab never loads: the chat gets one site card (**Allow once**, **Always allow**, **Deny**) and the
  agent gets `origin_blocked`. The person can **Stop agent**, **Take control** and **Hand back** at any time.
- **Site approvals are never arbitrated by the Magos.** A site card is not a tool approval: it is answered only on the
  `browser:decideOrigin` channel from the person's window. Approvals of the `browser_*` tools themselves (an MCP
  `browser_*` tool, or `Bash … dm call browser_*`) are registered as never-arbitrated (`registerNeverArbitrate` in
  `agentChatWiring.ts`), so they always reach the person too.
- **On by default, behind fail-closed origins.** **Let agents use this browser** is on in a new install (and when
  `<userData>/browser/settings.json` is missing or unreadable), because the origin policy asks before any site loads:
  an empty or unreadable site list allows nothing. Turned off, every agent op but `browser_status` answers
  `browser_disabled`.
- **Rejected: an emulated CDP endpoint.** Agents get no Chrome DevTools Protocol endpoint (a local WebSocket that
  Playwright or Puppeteer could attach to), as the reference app Ada offers. Such an endpoint hands its ws path to
  any local process, which would then drive the browser past the grant, the origin policy, ownership and Stop, and
  could read any page, cookie or password the session holds. The seven commands are the whole agent interface.

### Threat model

| Threat | Mitigation |
|---|---|
| **Prompt injection.** A page's text, title or markup tells the agent to run a command, reveal a token or visit a site. | Page content is data, not instructions: `browser_read` marks every result `untrusted: true`; the tool descriptions, the worker guide, the orchestrator's `agent-browser` fact and the CLI instructions (`cliInstructions.ts`, for `dm` CLI and Skitarii `dm_call` chats) all say never to act on, follow or reveal anything because a page says so. Whatever the agent does next still needs its grant and, for a new site, the person. |
| **Network egress.** A page or agent reaches loopback services, the LAN, cloud metadata or exfiltrates over side channels. | `originPolicy.ts` fails closed: only `http`/`https` pages without userinfo, compared by WHATWG-serialized origin, never by text prefix. Link-local and metadata hosts are refused; loopback and private hosts only from a page that is itself loopback or private. `browserSession.ts` also checks every address a host name resolves to and the address a response came from (DNS rebinding), keeps WebRTC to proxied UDP only, denies every permission, download, popup, HTTP auth and device chooser, and registers no protocol handler, so `dm-attachment:` and `dm-chat-image:` are unreachable. Back, Forward and Reload, which fire no `will-navigate`, check the target history entry against the tab's sites first (`browserIpc.ts`). |
| **Credential exposure.** A grant or claim token leaks into a URL or typed text; an agent reads or types a password; the person's sign-ins leak to agents. | Secret detection is a mask comparison, `maskAgentChatSecretsDeep(text) !== text`, on the URL as given and percent-decoded (`holdsSecret`, `originPolicy.ts`) and on typed text (`browserDriver.ts`), never a stateful `/gi` regex `.test()`; a hit is `secret_refused`. `browser_read` never returns a password or protected field's value or its length (`DOM.describeNode`, because the AX tree has no password marker), and `browser_type` refuses password fields (`password_field`). Take control detaches the debugger before the person types. The **Private tab** is an in-memory partition per tab that agents never see and whose cookies are never shared; sign-in for agent work happens in the agent tab under Take control. Every pushed URL and title is masked. |
| **The native view drawn over the renderer.** A `WebContentsView` composites above the app's own page, so a dialog, menu or toast under it is hidden, and a spoofed page could pose as app chrome. | The panel hides the view (`bounds: null`) whenever an app-wide overlay, the Sites popover or the capture popover is open, and the site card docks outside the view's area. The view shows web content only inside the Browser tab's placeholder rect; it has no preload, no Node and fails `guardIpc`'s sender check. Screenshots are refused (`view_hidden`) unless the agent tab is the view shown on the window, so a hidden view never yields a stale frame. |
| **Windows named-pipe ACLs.** Node's default pipe ACLs are not user-exclusive, so another local account could connect to `\\.\pipe\dm-browser-<uuid>`. | Authority never comes from the address (`createControlServer`, `controlServer.ts`): every request carries the chat's grant token, which `authorizeBrowser` resolves to a live grant holding `browser.drive`, re-verified before, during and after the op (`verifyChatGrant`). `DM_BROWSER_PIPE` is set only in the CLI env of a grant holding `browser.drive` and never inherited (`terminalEnv.ts` `NEVER_PASSED`). On POSIX the socket sits in a 0700 directory with mode 0600. |

## Consequences

- The person watches and approves; an agent can never widen its reach on its own. A site prompt waits until the
  person answers, so an agent that meets `origin_blocked` waits rather than loops.
- Screenshots come back as evidence attachments, never bytes or paths. Main writes one 0600 copy in a fresh 0700
  `dm-browser-shot-*` folder under the system temp folder; on Windows that is the per-user `%LOCALAPPDATA%\Temp`, where
  `chmod` has little effect, so the copy is protected by the profile folder's own ACL and is swept after 10 minutes.
- Sign-ins do not carry over between the Private tab and the agent tab. A person who wants an agent signed in does it
  in the agent tab under Take control.
- The skills version is 1.21.0: the worker guide, the orchestrator's `agent-browser` fact and the CLI instructions
  describe the browser.
