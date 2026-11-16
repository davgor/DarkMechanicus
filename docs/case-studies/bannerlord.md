# From an unfamiliar C++ generator to a playable Bannerlord campaign

DarkMechanicus grew out of a practical coordination problem: following agent-written changes in a language its creator did not know well. Structured planning made that work easier to direct and inspect. The subsequent Bannerlord integration provides a concrete example with saved plans, implementation contracts, and recorded acceptance evidence.

**Result:** the receiving repository records a local test package that generates campaign worlds inside Bannerlord, including terrain, settlements, factions, heroes, and land and sea routes. Its October 19, 2026 acceptance report records two worlds played and saved/loaded across a cold restart. It explicitly does not certify a general public release.

## The human account and the repository evidence

David Gorden describes spending one day planning, followed by ten days of headless execution without additional human input. Before adopting structured planning, he found it difficult to track the agent's work in the unfamiliar FWGC++ codebase. He reports that the switch significantly improved his ability to produce and direct C++ work.

Those duration, intervention, and personal-effectiveness statements are the creator's account. The repositories establish the plan, implementation, and recorded test results; they do not independently prove an uninterrupted ten-day execution window or the absence of human intervention. No productivity multiplier or controlled comparison is claimed.

The evidence below is pinned to the receiving repository's [October 19 integration merge](https://github.com/davgor/MNBL-modding-repo/commit/d08aadb4742cdd30dce47e42908b25a6586ef62b), rather than combining later development with that acceptance result. The exact start and end dates of the reported ten-day run are not established here.

## Three repositories, three responsibilities

| Repository | Responsibility in this case |
| --- | --- |
| [FWGC++](https://github.com/davgor/FWGC-/tree/ec5d1c10f5ae4c32fdcef092d23ad7d51e2a30de) | C++ world generator, consumed as a pinned producer executable and a versioned world-data contract |
| [DarkMechanicus](../../README.md) | Planning and execution coordination: saved revisions, dependencies, acceptance criteria, and recorded work |
| [MNBL modding repository](https://github.com/davgor/MNBL-modding-repo/tree/d08aadb4742cdd30dce47e42908b25a6586ef62b) | World conversion and Bannerlord integration, runtime capability probes, campaign activation, persistence, and acceptance tooling |

The [producer lock](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/worldgen/producer.lock.json) identifies the FWGC++ source commit, binary hash, schema, and command contract. This was an integration of an existing generator, not a claim that the generator and game integration were both created from scratch in ten days.

## Turning the goal into an executable plan

The [saved DarkMechanicus plan](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/.darkmechanicus/epics/ep_01m4fpnf646t254mnh69jhz107/snapshots/rv_01m4xazdg471p8ggry5yynj8ye.json) required generation from inside the running game, complete generated campaign content, naval travel, and saves bound to the correct immutable world. An external generator followed by an editor/build/relaunch cycle would not meet the goal.

The plan made unknown engine capabilities executable prerequisites. It instructed the implementation to record unsupported operations as blocked gates rather than silently substitute a static map. It also specified one final human handoff without intermediate product, architecture, or budget approvals. That documents the intended execution model; it is not a substitute for a complete intervention audit.

## Decisions that made the integration tractable

- **Pin the producer boundary.** The source commit, executable, and data contract were identified explicitly, so a stale local binary could not stand in for the intended generator. [Producer lock](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/worldgen/producer.lock.json).
- **Use one projection contract.** The generated globe became a flat campaign map with connected east/west edges. A versioned projection and its hash bound exported positions and terrain samples to the same mapping. [Projection design](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/docs/world-projection.md).
- **Prove the runtime backend before depending on it.** The selected native scene-bundle backend preserved the engine's terrain, navigation, picking, and map consumers. A procedural-mesh alternative was rejected because it did not supply the native heightfield or navigation mesh. The selected approach incurred private-field integration and first-load navigation preparation. [Decision and alternatives](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/docs/runtime-backend-decision.md).
- **Make acceptance broader than a successful build.** The final scenario exercised generation, campaign play, world switching, persistence, cancellation, and rejection of damaged or incompatible data. [Acceptance scenario](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/docs/one-shot-acceptance.md).

These are documented implementation decisions. The records do not attribute every decision to a particular human or agent.

## What was demonstrated—and what was not

The [acceptance report](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/docs/one-shot-acceptance.md) records a passing final scenario on package `51abd1cc…`, with worlds A (seed 42) and B (seed 73), mutable campaign state saved and restored across a cold restart, and recovery checks for cancellation and invalid world/save data. It also records earlier failures and the fixes before the final run; this was not a first-attempt success.

The [acceptance index](https://github.com/davgor/MNBL-modding-repo/blob/d08aadb4742cdd30dce47e42908b25a6586ef62b/evidence/one-shot/acceptance-index.json) separates the scoped result from deferred certification:

- An offline sweep accepted 19 of 32 seeds on the first quality attempt. Offline activation is not equivalent to in-game play of every accepted seed.
- First-start navigation preparation blocked the game for roughly seven minutes.
- Broad seed certification, long simulation soaks, endurance, all-season play, and performance certification remained unproven.

This case study reads the committed evidence; it does not claim a fresh reproduction of those game runs. It includes no gameplay image because a public capture for this specific accepted package has not been established.

## What this says about agent-platform engineering

The useful result is a traceable path from an unfamiliar producer to a working consumer: explicit contracts, dependency-ordered work, capability probes, and acceptance tied to observable behavior. It shows how structured coordination can make a complex agent-driven project inspectable. It does not establish fleet-scale reliability, general autonomous coding success rates, or an independently measured productivity gain.
