# ts-api-harness

A harness (not an agent) that governs TypeScript REST API work. It drives a model through a
provider-neutral driver and wraps every tool call in hooks. The run ends only when
deterministic gates are green, and the harness alone ships the result.

- **Design note:** [docs/design.md](docs/design.md) covers architecture, drivers, token budget, extension points and the honesty boundary.
- **Standards enforced:** [docs/standards.md](docs/standards.md).
- **Core engine directory: `harness/core/`.** Extensions never touch it.
- **Own addition:** the *contract lock* gate (see the design note).

## Setup

Requires Node ≥ 22.18 (TypeScript runs natively; no build step) and git.

```sh
npm install        # one command; then `npm test` runs the harness's own 42 tests offline
cp .env.example .env   # then fill in ONE of the options below
```

Keys are read from `.env` automatically. Anything already exported in your shell wins.

- **Option A, OpenRouter (one key for both drivers):** set `OPENROUTER_API_KEY`. `--driver claude` goes to
  OpenRouter's Anthropic-compatible `/messages` endpoint and `--driver openai` to its
  `/chat/completions` endpoint, so each adapter still speaks its own wire format. Defaults are
  `anthropic/claude-sonnet-5.5` and `openai/gpt-5.5`, overridable with `HARNESS_CLAUDE_MODEL` /
  `HARNESS_OPENAI_MODEL` (vendor/model ids).
- **Zero-credit testing:** with an OpenRouter key and no credits, point the drivers at free
  models (see `.env.example`). Each driver still uses its own wire format, but the models are
  not Claude or GPT, so these runs test the harness, not the target providers. The free tier
  allows roughly 50 requests a day, so use `--max-turns 25`.
- **Gemini (openai driver only):** `HARNESS_OPENAI_VIA=gemini` with `GEMINI_API_KEY` sends
  `--driver openai` to Google's OpenAI-compatible endpoint (default model `gemini-3.8-flash`). Google
  has no Anthropic-compatible endpoint, so `--driver claude` can't use it.
  `HARNESS_CLAUDE_VIA` / `HARNESS_OPENAI_VIA` (`direct` | `openrouter` | `gemini`) pin a route explicitly.
- **Option B, direct:** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, used only when `OPENROUTER_API_KEY` is empty.

The resolved model and route ("… via openrouter") are recorded in each run's `summary.json` and
`events.jsonl`. Nothing secret lives in the repo: `.env` is git-ignored.

## Commands

```sh
# Greenfield: scaffold generated/users-api, then drive the model until the gates are green
node bin/harness.ts run tasks/users-api.task.json --driver claude
node bin/harness.ts run tasks/users-api.task.json --driver openai     # same task file, zero edits

# Brownfield: add PATCH to the sample existing API, then ship (branch + commit + push + PR)
node bin/harness.ts run tasks/notes-patch.task.json --driver claude --ship

# Token report with a measured baseline (baseline run on a copy, then a JIT run)
node bin/harness.ts bench tasks/users-api.task.json --driver claude

node bin/harness.ts check --api generated/users-api     # standards report, exit 0 only at 100%
node bin/harness.ts ship --run <runId> [--no-pr]        # re-runs every gate first
node bin/harness.ts map --api samples/notes-api src/notes/routes.ts
node bin/harness.ts plugins                             # what is registered
```

Each run writes these files:

- `runs/<runId>/`: `events.jsonl` (every model turn, tool call and hook decision), `summary.json`, `standards.txt`, `tests.log`, `ledger.json`, raw artifacts, `ship.json`.
- `tokens/<runId>.json`: per-turn provider input tokens plus the per-turn shadow baseline.
- `tokens/bench-*.json`: from `bench`, measured baseline vs actual per turn.

Exit codes: 0 green, 1 red, 2 UNPROVEN or usage error.

## Layout

```
harness/core/        CORE: loop, driver interface, registry, context/compaction, gates, ledger,
                     standards runner, test runner, contract, ship, CLI
harness/drivers/     claude.ts, openai.ts (one file per provider)
harness/templates/   deterministic greenfield scaffold
plugins/tools/       list_files read_file search write_file edit_file run_tests run_checks standards map_tests
plugins/hooks/       10-path-guard 20-observed-red 30-contract-lock 90-write-journal
plugins/rules/       zod-boundary zod-infer problem-json tsc-strict type-escapes rest-conventions
plugins/validators/  ORM validators (empty; see examples/)
examples/plugins/    drop-in examples: route_diff tool, orm-explicit-select validator, no-console rule
tasks/               users-api (greenfield), notes-patch (brownfield)
samples/notes-api/   stand-in for the provided existing API
test/                harness tests, driven by a scripted, provider-free driver
```

## Extending (what the grader does)

```sh
cp examples/plugins/tools/route_diff.ts             plugins/tools/        # new tool
cp examples/plugins/validators/orm-explicit-select.ts plugins/validators/ # ORM validator
cp examples/plugins/rules/no-console.ts             plugins/rules/        # linter rule
git diff --stat   # only the new file; nothing under harness/core/
```

The registry discovers files by folder, so there is no manifest to edit. A plugin imports only
`#harness/plugin-api.ts`.

## Status: what is and is not evidenced yet

- **Greenfield, `--driver openai` (gpt-5.5, direct):** both bench runs green, with standards at 100% and
  7/7 tests. Evidence: `tokens/bench-users-api-openai-2026-10-06T12-09-07-847Z.json`, and in `runs/`
  `users-api-openai-baseline-2026-10-06T12-06-59-663Z` and `users-api-openai-jit-2026-10-06T12-08-14-674Z`.
  The generated API is in `generated/users-api`.
- **Token report (measured, same task and driver):** total input 187,805 (baseline) vs 75,063 (JIT),
  a **60% reduction**. Peak per-turn input 17,429 vs 7,905, a 54.6% reduction. This is below the 90% target:
  the whole sample is about 4k tokens, and the JIT context levels off at the working set of files being
  written (about 7.7k tokens).
- **Not yet produced:** a `--driver claude` run (no Anthropic credit at the time) and the brownfield
  run with the harness-opened PR.
- Offline (`npm test`, 50 tests): every rule passing and failing with file:line, each hook blocking,
  the full loop red→green on a scripted driver, compaction without re-read thrash, ship to a bare
  remote without touching the working tree, ship refusing on red, both adapters' wire mapping, and drop-in plugins.
- `tasks/` and `samples/notes-api` are stand-ins until the official task file and sample repo are dropped in.

## Team

Individual submission.
