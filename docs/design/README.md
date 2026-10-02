# Desktop mockups

Static mockups of the v1 desktop experience described in [`docs/product-plan.md`](../product-plan.md) (Desktop experience section). They are design references for the milestone 2–5 implementation tickets, not production code.

The editable source is the Claude Design canvas **Dark Mechanicus Mockups** (private to the repo owner; share it from the canvas's Share menu before linking others): https://claude.ai/artifact/AhCveCpWShoF6QcV1sJUzh

The files in [`mockups/`](mockups/) are standalone HTML exports (1440×900). Open them directly in a browser; they only load IBM Plex from Google Fonts.

| File | Screen | Plan concepts shown |
|------|--------|---------------------|
| [`01-onboarding.html`](mockups/01-onboarding.html) | Track and initialize a folder | Folder picker, explicit repository initialization, `.darkmechanicus/` layout, `local/` git-ignored, MCP connection next step |
| [`02-plan-graph.html`](mockups/02-plan-graph.html) | Plan graph during a run | Sidebar folders with In progress / Backlog / Completed buckets, pinned revision, run bar, vertical flowchart of tickets with fork and join, sprint checkpoints as dividers, epic checks, attempts strip |
| [`03-ticket-detail.html`](mockups/03-ticket-detail.html) | Ticket detail panel | Markdown body, structured acceptance criteria, capability profile, requires / unlocks, read-only while pinned to an active run |
| [`04-draft-revision.html`](mockups/04-draft-revision.html) | Editing a draft revision | Draft vs. running revision, rejected later-sprint prerequisite with reason, validation, changes since last revision, publish |
| [`05-sprint-checkpoint.html`](mockups/05-sprint-checkpoint.html) | Sprint checkpoint with a failed gate | Sprint report (accepted, failed, checks, follow-ups), gate conditions blocking advancement |
| [`06-delete-plan.html`](mockups/06-delete-plan.html) | Permanent plan deletion | Deletion preview of owned records, kept shared tickets, source and Git history untouched, typed confirmation |

## Visual direction

The app follows the **Mechanicus palette**, taken from the tech-priest in the app icon. [`palette.md`](palette.md) holds every token value, the color roles, the collision rules and the contrast table. It was approved at the sprint 1 checkpoint of the "Mechanicus UI revamp" epic and applied in DM-6 to DM-8.

- **Crimson** (the hood) is the primary accent: primary buttons, the focus ring, selection and the active sidebar row. Fills use `--primary`; lines (focus, selected node, active bar) use the lit `--ring`, which keeps 3:1 on every surface.
- **Brass** (the fittings) is the secondary accent, and the only accent used as text: links, rules, highlights and warnings (`--accent`).
- **Bone** (the cog trim) is the display ink for screen and plan titles and the brand wordmark (`--ink-display`).
- **Gunmetal** (the respirator) tints every surface and line. The app stays dark-only.
- **Lens green** is kept for the brand glow and the running state.
- Ticket and run states each have their own color and always pair it with a text label. No state sits on the crimson hue: failed and danger are a signal rose, awaiting checkpoint is orchid, accepted is jade.
- Every renderer color is a `:root` token in `src/renderer/src/styles.css`. Tests keep it that way: `styles.test.ts` rejects hex colors outside `:root`, and `theme.contrast.test.ts` holds the tokens to `palette.md` and its contrast table.
- The tech-priest is the sidebar brand mark and greets people on the welcome and onboarding screens.
- Type: IBM Plex Sans (UI), IBM Plex Mono (IDs, states), IBM Plex Serif (plan and screen titles).
- The plan graph is a top-to-bottom flow on a dotted canvas: floating ticket cards, curved dependency edges (solid = prerequisite accepted, dashed = waiting), sprint checkpoints as dashed dividers, and the epic as containment at the top (no dependency edges).

**The mockups predate the revamp.** The files in `mockups/` still show the earlier brass-on-graphite "forge console" palette (ground `#141310`, brass accent `#e0a24a`). Use them for layout and information architecture, and `palette.md` for color.

All tickets, runs, commits and counts in the mockups are sample data. The MCP command in the onboarding snippet is a placeholder until the MCP entry point exists.
