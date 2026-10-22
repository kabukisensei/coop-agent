# coop-router

coop's router (master plan R1): the `coop/auto` virtual model over the OpenAI
Codex models coop already signs in to. Loaded only on Pi 1.x (`bin/coop.ps1`);
opt in with `/model coop/auto`. No new vendor: every request lands on the
`openai-codex` provider with the session's own sign-in, and nothing new leaves
the machine.

A large model plans and a smaller one implements and summarizes, by rules, never
a classifier:

| Request | Goes to |
| --- | --- |
| A new prompt at `high` or `xhigh` thinking, or a long prompt (4000+ characters) | the plan model |
| A new prompt at `low` or `medium` thinking of at most 400 characters | the build model |
| Any other new prompt | the standard model |
| Tool follow-ups in a turn | the turn's model, until the first successful `edit` or `write` (the agent log under `docs/agent/logs/` does not count), which hands the rest of the work to the build model; the session stays there for ordinary follow-ups |
| A retry after a provider error | one tier up for the rest of the turn (build to standard, standard to plan); on the plan model it stays |
| Two failed `edit` or `write` calls in a turn on one tier | one tier up for the rest of the turn; the next prompt starts afresh |
| Compaction summaries and extension calls | the build model at `low` thinking |

Tiers map to model families, and each resolves to the newest version of its
family that the signed-in account can use (`plan`: `sol`; `standard`: `terra`, else
`sol`; `build`: `luna`, else `terra`), read from the catalog the first time a session
routes and kept for the rest of the session. A new release in a family (the catalog
names them `gpt-<version>-<family>`: `gpt-5.6-sol`, `gpt-6-luna`, `gpt-6.1-sol`) is
picked up at the next start with no code change; `/router` shows the version each
tier resolved to. `COOP_ROUTER_MODELS` (`plan=a,b;standard=c;build=d`) pins exact
ids instead, first usable wins, for a measurement run or to hold a version. With no
Codex sign-in the route fails with a message naming `/login openai-codex`; it never
falls back to another provider.

The new-prompt rule (the first three rows) is `lib/router-rules.mjs`, tested
against two synthetic prompt sets in `tests/fixtures/router-trial/`
(`tests/router-rules.test.mjs`). The J0 trial that scored third-party
classifiers against it found no token saving over the rule and was removed
(2026-10-19); the rule routes alone.

The phase is router state: Pi stores it on the session branch, so it follows forks
and survives compaction. The footer (`coop-powerline`) shows the routed model beside
the selection (`auto → gpt-5.6-luna`); `/router` lists the model per tier and the
session's phase.

## The session default

A new session (terminal, window or phone) starts on the newest `sol` the
signed-in account can use, found as the plan tier finds it, so a new sol release
becomes the default at the next start with no code change. Your own pick wins:
every model you choose with `/model`, the window's Ctrl+L or Ctrl+P, or the
phone's picker is written to `coop-model.json` in the agent dir, and new sessions
start on it (`coop/auto` included). Choosing the newest sol again removes the
file, so sessions follow the next release again. Pi's own saved default is kept
when it is not a sol; a sol there is the one Pi's `/login` saved, so it moves to
the newest. Launch flags (`--model`, `--models`, `--provider`) and a scoped
`enabledModels` list win over all of it, a resumed or forked session keeps its
own model, and `COOP_NO_ISOLATE` leaves the model to your personal Pi. Routing
is unchanged: `coop/auto` stays opt-in.

## Files

- `index.ts` — extension entry point; the rules are exported pure functions
  (`routeRequest`, `classifyRequest`, `resolveTier`) tested by `tests/coop-router.test.mjs`.
- `package.json` — extension manifest.
