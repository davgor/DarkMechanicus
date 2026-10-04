# DM-161 graph mascot integration — worker evidence

Commit: `f813fadf6d8060ed637cbafe47013193bc25f4ad` on `codex/mascot-drill-ui`.

## Focused checks

- Vitest: 7 focused graph/mascot files, 127 tests passed. This includes running versus selected or toned ticket semantics, lifecycle and stale-shake behavior, sprite falling frames, geometry, graph interaction, and reachable motion.
- Targeted oxlint on the 12 touched TypeScript/TSX files: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Full test sweep, Fireguard, deadcode, and build: left to sprint acceptance.

## Live PlanGraph preview

The preview at `http://127.0.0.1:5179/preview/mascot/graph.html` uses four real dependency-linked ticket cards with the upper and lower cards running. The observations below came from the live browser with its normal controls; no motion state was injected. Browser screenshots were emitted during these checks but were not saved as repository files.

- The mascot ascended via intermediate cards and drilled on the upper running card. After completing that card, its label changed to `ACCEPTED`; the mascot moved to the lower running card and drilled there. The drill clip includes its contact sparks.
- A rapid three-leg canvas pan incremented shake ID `0 → 1` exactly once and produced a visible tumble. At about 450 ms, the sprite was caught on DM-2: its rendered bottom was 334 px and DM-2's top was 318 px, accounting for the atlas's roughly 16 px transparent foot margin. A screenshot showed the mascot perched on DM-2.
- From DM-4, a second rapid pan incremented shake ID `1 → 2`. At about 700 ms, the sprite was in `stumble` with rendered bottom 894 px against the board floor at 878 px, again including the transparent foot margin. This is the observed floor landing.
- A separate ascent trace showed `stumble` without a change to shake ID `2`, indicating a seeded slip. On another floor recovery, `climb` frame 1 held the exact position x=727, y=625 for four consecutive 100 ms samples, with shake ID `4` unchanged; the climb then continued. This is the observed grip break.
- A browser click selected `tk_3`. Dragging that card recorded `tk_3 at 399` in the preview's drop callback, and the card reset to its model position at y=572. The mascot did not intercept either action.
- Independent browser review observed that gentle panning and Zoom In did not increment shake ID; a deliberate back-and-forth pan did. Pausing during drill frame 2 kept the sprite's entire rendered element unchanged across observations, including sparks, and resuming restarted animation.

Fit View's final transform and browser resizing were not independently verified in this worker pass. Existing focused graph and motion tests cover resize and viewport bounds. The coordinating review will check the remaining browser controls before accepting the ticket.
