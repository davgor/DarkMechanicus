# Mechanicus palette

**Status:** proposal for the sprint 1 checkpoint (DM-4). The app does not change until "Apply the Mechanicus palette" (DM-6) copies these values into `:root` of `src/renderer/src/styles.css`. The two restyle tickets (DM-7 shell, DM-8 epic workspace) then apply the roles below.

**Source:** the chibi tech-priest in [`build/icon.png`](../../build/icon.png). The master [`build/mechanicus-cute-master.png`](../../build/mechanicus-cute-master.png) is the same artwork at 1254 px; its region means match the icon's within 1/255 per channel.

**Unchanged:** the dark-only theme, IBM Plex Sans / Mono / Serif, and the current layout. This doc only sets token values and roles.

## At a glance

- **Crimson** (the hood) becomes the **primary accent**: primary buttons, focus ring, selection, active sidebar row.
- **Brass** (the fittings) stays the **secondary accent**: rules, highlights, links, warnings. It keeps the token name `--accent`.
- **Bone** (the cog trim) is the **display ink** for headings, and the text color on crimson.
- **Gunmetal** (the respirator) sets the hue of every surface and line. Lightness stays as it is today.
- **Lens green** is the brand glow and the running state. It appears nowhere else.
- No state sits on the crimson hue any more: failed and danger move to a signal rose, awaiting checkpoint moves to orchid, blocked to a stronger orange, and accepted to jade so it stays clear of the lens green.
- Today's contrast failures are fixed: `--muted` on `--panel-2` (4.45:1), `--faint` on `--panel` and `--panel-2` (2.90:1 and 2.70:1), `--danger-ink` on `--danger` (4.27:1).

## 1. Colors sampled from the icon

**Method.** Each sample comes from the opaque pixels of `build/icon.png` (1024 × 1024 px) inside a box around one part of the figure. The pixels are filtered by hue and lightness (for example, "red-hued, saturation above 60%" for the hood), sorted by luminance, and summarised by their mean and percentiles. Coordinates are pixels in `icon.png` (x, y from the top left).

| Icon part | Box (x0,y0)–(x1,y1), pixels | Sample used | Statistic, sample point | Goes to |
|---|---|---|---|---|
| Hood, crown | (380,40)–(640,130), 19,231 px | `#b51a1f` | 25th percentile, at (412,104) | `--primary` |
| Hood, crown | same | `#c51e21` | mean (median `#c91f22` at (484,99)) | `--primary-hover` |
| Hood rim, lit edge | 5 × 5 around (672,128) | `#ea4134` | mean (centre pixel `#ef4235`) | `--ring` |
| Hood, inner shadow | (790,420)–(930,580), 13,153 px | `#350000` | median, at (884,490) | `--danger-ink` |
| Bone cog trim, hood | (200,110)–(900,470), 32,906 px | `#f2d7ae` | mean (median `#f5d8b2` at (840,361)) | `--ink-display` |
| Bone cog trim, lit | same | `#fbe9c8` | 90th percentile, at (570,190) | `--primary-ink` |
| Brass forehead plate | (470,220)–(560,380), 2,344 px | `#d69b4a` | median, at (536,333) | `--accent` |
| Brass forehead plate | same | `#dfbb72` | 90th percentile, at (556,324) | `--accent-hover` |
| Brass goggle rings and fittings | (280,320)–(800,640), 21,186 px | `#e2aa55` | 90th percentile, at (446,362) (mean `#ab793c`) | `--accent-fill-hover` |
| Gunmetal mask | (280,240)–(760,640), 19,996 px | `#28211d` | median, at (697,556) | `--panel-2`, and the hue of all surfaces and lines |
| Green lens, glowing iris | pixel (400,420) | `#84c20a` | single pixel (region median `#2b7a02` is the dark iris) | `--lens`, `--st-running` |

The ticket's starting estimates hold up. Crimson `#b3201c`–`#c62a22` matches `#b51a1f`–`#c51e21`. Shadow `#480101` is about the 90th percentile (`#470102`–`#4e0203`); the median is darker. Bone `#deba94`–`#e9dcc0` matches the shaded trim (10th percentile `#e5c39b`, robe median `#e8c8a1`); the lit hood trim is a little lighter and warmer (mean `#f2d7ae`). Brass `#b5893a` is the shaded rings (mean `#ab793c`); the lit plate is brighter. Gunmetal `#2a2624` is `#28211d`. The lens `#84c20a` is exact.

## 2. Roles

### Primary accent: crimson (`--primary`, `--ring`)

- **Use for:** primary buttons (fill `--primary`, text `--primary-ink`, hover `--primary-hover`); the keyboard focus ring; selection (`::selection` and selected rows, filled with `--primary-soft`); the active sidebar row (`--primary-soft` fill plus a 2 px `--ring` bar); the selected node ring and selected edge in the plan graph; the active tab underline; the active onboarding step dot.
- **Never:** as a text color (crimson text reaches at most 3.2:1 on these surfaces), as a state color, or as a fill larger than a button.
- **Why two crimsons:** the deep hood crimson carries bone text at 5.62:1, but it shows at only 2.2–2.8:1 against the surfaces. That is below the 3:1 that WCAG 1.4.11 requires for a focus indicator. The lit hood rim `#ea4134` reaches 3.65–4.71:1. So every crimson **fill** uses `--primary`, and every crimson **line** (ring, bar, underline, edge) uses `--ring`.

### Secondary accent: brass (`--accent`)

- **Use for:** links; rules (hairlines under the brand bar and section headings, the active sprint heading); highlights (search hits, the draft badge, inline code, the "new" change tone); warnings ("Save pending", inline warnings).
- Brass is the only accent used as **text**. It keeps today's token name, so the ~20 places that use `--accent` as text stay readable the moment DM-6 lands.

### Display ink: bone (`--ink-display`)

- **Use for:** screen and plan titles (IBM Plex Serif), the brand wordmark, and large numerals.
- Body text stays `--ink`, because bone is too saturated for paragraphs. The lit bone `#fbe9c8` is also `--primary-ink`, the same bone-on-crimson pairing the icon uses for its trim.

### Lens green (`--lens`, `--st-running`)

- **Allowed:**
  - The brand glow: a halo on the mascot and on the sidebar brand mark.
  - The running indicator: the running pill and dot, and the running card's glow ring (today's 16% ring on `.pg-card.ew-tone-running`).
- **Not allowed:** buttons, links, success messages, accepted or completed states, large fills, or decoration. Any further use is a palette change, not a component choice.

### Surfaces and lines: gunmetal

- Each surface and line keeps today's OKLCH lightness and chroma, and takes the hue of the gunmetal mask (52°). `--panel-2` lands exactly on the sampled `#28211d`.
- The shift is subtle, from olive-grey to a warm grey-brown that sits better under crimson. Contrast moves by 0.1 or less.
- Text greys already sit near the bone hue (78°), so `--ink` and `--ink-2` stay as they are. `--muted` and `--faint` only get lighter.

## 3. Token table

The DM-3 tokens (`--edge`, `--edge-waiting`, `--node-bg`, `--tone-edited`, `--accent-hover`) are named as that ticket suggests; the orchestrator reconciles the names at merge. "New" tokens do not exist yet; DM-6 adds them, and DM-7 and DM-8 put them to use.

### Surfaces

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--bg` | `#141310` | `#151211` | App background, graph canvas |
| `--bg-canvas` | `#171511` | `#181412` | Canvas tint (currently unused) |
| `--panel` | `#1f1c17` | `#211b18` | Cards, panels, dialogs |
| `--panel-2` | `#26221c` | `#28211d` | Raised rows, hover fills, Markdown blocks (gunmetal sample) |
| `--panel-3` | `#2e2922` | `#302823` | Focused menu item, graph handles |
| `--sidebar` | `#1b1915` | `#1c1816` | Sidebar |
| `--code-bg` | `#0f0e0b` | `#100d0c` | Code blocks, inputs |
| `--overlay` | `rgba(8, 7, 5, 0.72)` | `rgba(9, 7, 6, 0.72)` | Dialog backdrop |
| `--node-bg` (DM-3) | `#1d1a16` | `#1e1917` | Plan graph node cards |

### Lines

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--line` | `#3a342b` | `#3d332d` | Borders, canvas dots |
| `--line-soft` | `#2a261f` | `#2c2520` | Dividers |
| `--line-strong` | `#4a4439` | `#4e423b` | Button and input borders |
| `--edge` (DM-3) | `#8a8070` | `#8f7d73` | Graph edges, accepted (solid) edge, sprint divider |
| `--edge-waiting` (DM-3) | `#6a6254` | `#6f6057` | Waiting (dashed) edge and divider |

### Text

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--ink` | `#ece6da` | `#ece6da` (unchanged) | Body text |
| `--ink-display` (new) | — | `#f2d7ae` | Display and heading ink (bone trim) |
| `--ink-2` | `#c9c1b2` | `#c9c1b2` (unchanged) | Secondary text |
| `--muted` | `#8f8778` | `#9c9284` | Labels and metadata; lighter to pass 4.5:1 on `--panel-2` |
| `--faint` | `#6b6458` | `#797165` | Decorative only (dots, hints); lighter to pass 3:1 |

### Primary accent: crimson (new)

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--primary` (new) | — (role held by `--accent`) | `#b51a1f` | Primary button fill, active step dot, update-banner restart button |
| `--primary-hover` (new) | — | `#c51e21` | Primary button hover (brightens) |
| `--primary-ink` (new) | — | `#fbe9c8` | Text and icons on crimson |
| `--primary-soft` (new) | — | `rgba(181, 26, 31, 0.24)` | Selection, active sidebar row fill |
| `--ring` (new) | — (role held by `--accent`) | `#ea4134` | Focus ring, selected-node ring, selected edge, active tab underline, active-row bar |

### Secondary accent: brass

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--accent` | `#e0a24a` | `#d69b4a` | Links, rules, highlights, warnings, inline code, draft badge, "new" tone |
| `--accent-ink` | `#1a1408` | `#1a1408` (unchanged) | Text on a brass fill |
| `--accent-soft` | `rgba(224, 162, 74, 0.14)` | `rgba(214, 155, 74, 0.14)` | Search-hit and warning backgrounds |
| `--accent-hover` (DM-3) | `#f0c27a` | `#dfbb72` | Link hover |
| `--tone-edited` (DM-3) | `#e8b86a` | `#e8b86a` (unchanged) | "Edited" tone in draft changes |

### Lens (new)

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--lens` (new) | — | `#84c20a` | Brand glow only (mascot, brand mark) |

### States, attention and danger

| Token | Today | Proposed | Role |
|---|---|---|---|
| `--st-accepted` | `#5fbf8a` | `#4cc7a8` | Accepted, completed (jade, away from the lens) |
| `--st-review` | `#a78bfa` | `#a78bfa` (unchanged) | Submitted, in review |
| `--st-running` | `#e0a24a` | `#84c20a` | Running, claimed, in progress (the lens) |
| `--st-ready` | `#6aa7ff` | `#6aa7ff` (unchanged) | Ready, queued |
| `--st-waiting` | `#8f8778` | `#9c9284` | Waiting, backlog, paused, canceled (follows `--muted`) |
| `--st-failed` | `#e06a5a` | `#ef6b8f` | Failed, rejected (signal rose) |
| `--st-blocked` | `#d4855a` | `#e5793f` | Blocked, needs reconciliation, lease expired, paused run |
| `--attention` | `#f08e78` | `#e889d0` | Awaiting checkpoint (orchid); also form and snippet errors today |
| `--danger` | `#c4503c` | `#e5547c` | Destructive button fill (light rose) |
| `--danger-ink` | `#fff4f0` | `#350000` | Text on the danger fill (hood shadow) |

### Other literals DM-3 has to move

DM-3's acceptance criteria forbid any hex outside `:root`, but its list leaves out these four literals. The names are suggestions; the values are the proposal.

| Literal today | Where | Suggested token | Proposed |
|---|---|---|---|
| `#a8a092` | 13 rules: `.lede`, `.note`, `.btn-ghost`, `.empty-state-text`, `.dialog-description`, sidebar icons, bucket headers, footer keys, … | `--ink-3` | `#a8a092` (unchanged) |
| `#86cfab` | `.tone-ok` | `--tone-ok` | `#84d6be` (lighter tint of the new accepted) |
| `#eab265` | `.btn-primary:hover` | `--accent-fill-hover` | `#e2aa55` (brass ring highlight) |
| `#d4604c` | `.btn-danger:hover` | `--danger-hover` | `#f07894` |

`rgba(236, 230, 218, 0.04)` (sidebar row hover) is not a hex literal and can stay as it is.

## 4. Collision rules

Hue (h) and lightness (L) are OKLCH. ΔE is the OKLab distance: about 0.02 is just noticeable, and above 0.1 is clearly different. Every state is always shown with its text label (the existing rule in `epic/tones.css`), so color is never the only cue.

### Crimson must not read as failed or danger

Today failed (h 30), danger (h 32) and attention (h 34) all sit on the hood crimson's hue (h 26–29). Four things now separate them:

1. **Hue:** failed and danger move to a signal rose (h 5–7), 20–24° from every crimson.
2. **Lightness:** crimson is deep (L 0.50–0.53); failed is light (L 0.70).
3. **Form:** crimson is a solid fill (buttons) or a 2 px line (focus, selection). Failed is text, a dot, a thin border or a faint tint (10–18%) behind its label (FAILED, REJECTED, "Run failed"); it is never a solid fill.
4. **Polarity:** the primary button is bone text on deep crimson; the danger button is dark text on light rose. Side by side, they never look alike.

| Pair | ΔE | Hue distance |
|---|---|---|
| `--primary` / `--st-failed` | 0.211 | 21° |
| `--primary` / `--danger` | 0.164 | 20° |
| `--primary-hover` / `--danger` | 0.138 | 20° |
| `--ring` / `--st-failed` | 0.113 | 24° |
| `--primary` / `--attention` | 0.294 | 49° |

Rule: no state tone uses crimson, and no brand element uses rose.

### Lens green must not read as accepted

Today accepted is mint (h 157), only 28° from the lens (h 129). Accepted moves to jade `#4cc7a8` (h 173): 44° away, ΔE 0.138, and still 0.138 under simulated deuteranopia. Running also carries the glow ring, and accepted edges are solid. Labels read RUNNING and ACCEPTED.

### Every state stays distinct

| State | Proposed | Hue | Nearest state, ΔE today → proposed | Label |
|---|---|---|---|---|
| accepted | `#4cc7a8` | 173 | waiting 0.157 → running 0.138 | ACCEPTED, COMPLETED |
| review | `#a78bfa` | 294 | ready 0.096 → ready 0.096 | IN REVIEW |
| running | `#84c20a` | 129 | blocked 0.084 → accepted 0.138 | RUNNING, IN PROGRESS |
| ready | `#6aa7ff` | 258 | review 0.096 → review 0.096 | READY, QUEUED |
| waiting | `#9c9284` | grey | blocked 0.114 → blocked 0.134 | WAITING, BACKLOG, PAUSED |
| failed | `#ef6b8f` | 5 | blocked 0.064 → attention 0.096 | FAILED, REJECTED |
| blocked | `#e5793f` | 47 | failed 0.064 → failed 0.113 | BLOCKED, NEEDS RECONCILIATION |
| attention | `#e889d0` | 337 | blocked 0.064 → failed 0.096 | AWAITING CHECKPOINT |

The closest pair improves from 0.064 (failed/blocked) to 0.096 (review/ready, which are unchanged). Review and ready already converge under deuteranopia (ΔE 0.014). They are left alone here because they don't collide with the brand; their labels carry the difference.

## 5. Contrast

**Method.** Ratios use the WCAG 2.x formula and were computed by a script, not estimated:

- Each sRGB channel is linearised: c ≤ 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055)^2.4.
- Luminance L = 0.2126 R + 0.7152 G + 0.0722 B.
- Ratio = (L_light + 0.05) / (L_dark + 0.05).
- Translucent colors are composited over the named surface first.

Values are rounded to two decimals, and bold marks a failing value. The smallest margins in 5.1–5.5 are `--st-waiting` inside its pill (4.66 against 4.5) and `--faint` on `--panel-2` (3.29 against 3).

**Thresholds:** 4.5:1 for body text and state labels; 3:1 for `--faint` (decorative) and for non-text indicators (`--ring`, edges).

DM-6's guard test should enforce every pair in 5.1–5.5. The pairs in 5.6 are recommended checks.

### 5.1 Text on surfaces (min 4.5; `--faint` min 3)

Each cell reads today → proposed.

| | `--bg` | `--panel` | `--panel-2` | `--sidebar` |
|---|---|---|---|---|
| `--ink` | 14.95 → 15.00 | 13.66 → 13.69 | 12.72 → 12.75 | 14.12 → 14.18 |
| `--ink-2` | 10.40 → 10.43 | 9.50 → 9.52 | 8.85 → 8.87 | 9.82 → 9.86 |
| `--muted` | 5.22 → 6.09 | 4.77 → 5.55 | **4.45** → 5.17 | 4.94 → 5.76 |
| `--faint` (min 3) | 3.18 → 3.87 | **2.90** → 3.53 | **2.70** → 3.29 | 3.00 → 3.66 |
| `--ink-3` (`#a8a092`) | 7.17 → 7.20 | 6.56 → 6.57 | 6.11 → 6.12 | 6.78 → 6.80 |
| `--ink-display` | — → 13.41 | — → 12.24 | — → 11.40 | — → 12.68 |
| `--accent` (as text) | 8.35 → 7.68 | 7.63 → 7.00 | 7.11 → 6.52 | 7.89 → 7.26 |


### 5.2 State labels (min 4.5)

The ticket's pair is "on `--panel`". The other two columns are where the labels actually render: on node cards and on the 12% tint inside a pill. Graph cards tint their background 10% with the state color, which is easier than the pill's 12%.

| Token | On `--panel` today → proposed | On `--node-bg` | In its pill (12% tint over `--panel`) |
|---|---|---|---|
| `--st-accepted` | 7.52 → 8.13 | 8.32 | 6.55 |
| `--st-review` | 6.24 → 6.25 | 6.40 | 5.18 |
| `--st-running` | 7.63 → 7.86 | 8.04 | 6.34 |
| `--st-ready` | 6.94 → 6.95 | 7.11 | 5.71 |
| `--st-waiting` | 4.77 → 5.55 | 5.68 | 4.66 (today **4.08**) |
| `--st-failed` | 5.16 → 5.81 | 5.94 | 4.89 (today **4.41**) |
| `--st-blocked` | 5.90 → 5.78 | 5.92 | 4.86 |
| `--attention` | 7.15 → 7.23 | 7.39 | 5.87 |

### 5.3 Text on fills (min 4.5)

| Pair | Today | Proposed |
|---|---|---|
| `--accent-ink` on `--accent` | 8.22 | 7.54 |
| `--danger-ink` on `--danger` | **4.27** | 5.12 |
| `--primary-ink` on `--primary` | — | 5.62 |
| `--primary-ink` on `--primary-hover` | — | 4.91 |
| `--accent-ink` on `--accent-fill-hover` | 9.63 | 8.81 |
| `--danger-ink` on `--danger-hover` | **3.49** | 6.79 |
| `--ink` on `--primary-soft` over `--sidebar` (active row) | — | 12.33 |
| `--ink` on `--primary-soft` over `--panel` (selection) | — | 11.91 |

### 5.4 Crimson ring, non-text (min 3)

| | `--bg` | `--panel` | `--panel-2` | `--panel-3` | `--sidebar` | `--node-bg` |
|---|---|---|---|---|---|---|
| `--ring` | 4.71 | 4.30 | 4.00 | 3.65 | 4.45 | 4.40 |

### 5.5 Other tones on `--panel` (min 4.5)

| Pair | Proposed |
|---|---|
| `--tone-edited` on `--panel` | 9.31 |
| `--tone-ok` on `--panel` | 10.00 |
| `--accent` on `--accent-soft` over `--panel` (search hit) | 5.49 |
| `--lens` on `--sidebar` | 8.14 |

### 5.6 Recommended checks

| Pair | Min | Proposed | Note |
|---|---|---|---|
| `--edge` on `--bg` | 3 | 4.75 | Solid accepted edge |
| `--edge-waiting` on `--bg` | 3 | 3.10 | Dashed; the dash carries the meaning too |
| `--ink` on `--code-bg` | 4.5 | 15.58 | |
| `--muted` on `--panel-3` | 4.5 | 4.72 | |
| `--faint` on `--code-bg` | 4.5 | **4.02** (fails) | Input placeholder: `--faint` used as text (see section 6) |
| `--faint` in its pill | 4.5 | **3.13** (fails) | `.pill-later_sprint` label: `--faint` used as text (see section 6) |

## 6. Notes for DM-6, DM-7 and DM-8

- **DM-6:** change values and add the new tokens: `--primary`, `--primary-hover`, `--primary-ink`, `--primary-soft`, `--ring`, `--ink-display` and `--lens`, plus the DM-3 tokens. With the names above, nothing turns crimson yet: every existing rule keeps its role, and brass text stays readable.
- **Move to `--primary` / `--primary-hover` / `--primary-ink`:** `.btn-primary` and its hover, `.update-banner-restart`, `.step.is-active .step-dot`.
- **Move to `--ring`:** `:focus-visible`, `.input:focus-visible`, `.pg .react-flow__node:focus-visible`, `.pg-card.is-active`, the selected edge and `--xy-edge-stroke-selected` / `--xy-connectionline-stroke` in `graph/graph.css`, and the selected tab underline in `ticket/ticket.css`.
- **Move to `--primary-soft`:** `::selection`; DM-7 adds the active sidebar row (fill plus a `--ring` bar).
- **Stay on `--accent` (brass):** every text use (links, `.tone-warn`, `.badge-draft`, `.inline-warning`, `.footer-warning`, `.result-snippet mark`, `.pg-sprint-heading`, `.ew-link`, `.ew-tone-new`, Markdown links and inline code, and the others).
- **`--faint` used as text:** `.input::placeholder` and `.pill-later_sprint` should use `--muted`. The later-sprint pill keeps its dashed border to stay distinct from waiting.
- **Errors:** `.form-error`, `.tone-error` and `.snippet-error` use `--attention` today. They should use `--st-failed`, as `.is-error`, `.tp-error` and `.ew-notice-error` already do, which leaves orchid for "needs a person".
- **Optional:** `RUN_STATE_TONES.awaiting_checkpoint` in `graph/ticketStates.ts` maps to the failed tone in the run bar, while the sidebar uses attention for the same state. An `attention` tone would make the two match.
- `--bg-canvas` is defined but unused.

## 7. Decisions to confirm

1. **Token names.** Crimson gets a new `--primary` family, and `--accent` stays brass, so nothing regresses between DM-6 and DM-7. *Alternative:* make `--accent` crimson and add `--brass`. That means re-pointing about 20 text uses, which render crimson at about 3:1 until DM-7 and DM-8 land.
2. **Running is lens green**, and accepted moves from mint to jade to make room. *Alternative:* running stays brass and the lens is only the brand glow.
3. **Failed and danger become a signal rose** (`#ef6b8f`, `#e5547c`), pinker than today's coral, 20–24° from crimson. *Alternative:* the redder `#f0647a` (13° from crimson).
4. **The danger button is a light rose fill with dark text**, the opposite polarity of the crimson primary button. *Alternative:* an outlined danger button (rose border and text on a faint rose tint), the style `.ew .btn-danger` already uses in the epic workspace; that change belongs to DM-7.
5. **Awaiting checkpoint (`--attention`) becomes orchid** `#e889d0`, so "needs a person" stands apart from failed. *Alternative:* keep salmon, which sits on the crimson hue.
6. **Two crimsons:** the deep hood tone `#b51a1f` for fills (hover brightens to `#c51e21`), and the lit rim `#ea4134` for the focus ring and other lines, so they meet 3:1.
7. **Surfaces take the gunmetal hue** (a subtle warm shift, contrast unchanged). *Alternative:* keep today's surfaces exactly.
