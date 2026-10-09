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
| A new prompt at `low` thinking of at most 400 characters | the build model |
| Any other new prompt | the standard model |
| Tool follow-ups in a turn | the turn's model, until the first successful `edit` or `write`, which hands the rest of the work to the build model; the session stays there for ordinary follow-ups |
| A retry after a provider error | one tier up for the rest of the turn (build to standard, standard to plan); on the plan model it stays |
| Two failed `edit` or `write` calls in a turn on one tier | one tier up for the rest of the turn; the next prompt starts afresh |
| Compaction summaries and extension calls | the build model at `low` thinking |

Tiers resolve to the first model of a list that the signed-in account can use
(`plan`: `gpt-5.6-sol`, `gpt-6-sol`, `gpt-5.5`; `standard`: `gpt-5.6-terra`, then the
same; `build`: `gpt-5.6-luna`, `gpt-6-luna`, `gpt-5.6-terra`). `COOP_ROUTER_MODELS`
(`plan=a,b;standard=c;build=d`) overrides a tier for a measurement run. With no
Codex sign-in the route fails with a message naming `/login openai-codex`; it never
falls back to another provider.

The phase is router state: Pi stores it on the session branch, so it follows forks
and survives compaction. The footer (`coop-powerline`) shows the routed model beside
the selection (`auto → gpt-5.6-luna`); `/router` lists the model per tier and the
session's phase.

## Files

- `index.ts` — extension entry point; the rules are exported pure functions
  (`routeRequest`, `classifyRequest`, `resolveTier`) tested by `tests/coop-router.test.mjs`.
- `package.json` — extension manifest.
