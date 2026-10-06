# Design note

## Architecture

```
            ┌────────────── harness/core (CORE: never edited to extend) ──────────────┐
task.json ─▶│ loop.ts                                                                 │
            │   build request (context.ts: small prompt | compaction)                 │
            │   driver.complete() ─────────────▶ harness/drivers/<name>.ts            │
            │   for each tool call:                                                   │
            │     zod-validate args ─▶ PRE hooks (block|record|pass) ─▶ tool ─▶ POST  │
            │   no tool calls = "done?" ─▶ gates.ts (standards, tests, contract,      │
            │                                observed-red) ─▶ green: stop / red: feed │
            │                                back failures and continue               │
            │ ship.ts: re-run gates ─▶ temp-index commit ─▶ feature branch ─▶ push ─▶ PR│
            └─────────────────────────────────────────────────────────────────────────┘
plugins/tools/*  plugins/hooks/*  plugins/rules/*  plugins/validators/*   (discovered by folder)
```

**Deterministic (code):** scaffolding the greenfield plumbing, path resolution, scope,
the observed-red ledger, running tests (`node --test`, one process per file, credentials
stripped from the env), the standards rules, `tsc`, the contract surface, git, and the
decision that a run is finished.
**The model decides:** task breakdown, which files to fetch, the tests it writes, and the
code. It has no shell tool, so it cannot run git, install packages or push.

The four gates, all re-run by `ship` before any commit:

1. **standards**: every rule at 100%, none UNPROVEN.
2. **tests**: every test file passes under the harness runner. No tests is UNPROVEN.
3. **contract**: no route or exported-schema field that existed before the run is gone.
4. **observed-red**: every changed source file has a mapped test that the harness saw fail.

## Driver abstraction

```ts
interface Driver { name: string; complete(req: DriverRequest): Promise<DriverResponse> }
DriverRequest  = { system, messages: Message[], tools: ToolSpec[], maxOutputTokens }
DriverResponse = { text, toolCalls: {id,name,args}[], usage: {inputTokens, outputTokens} }
```

`Message` is neutral (`user` / `assistant` with toolCalls / `tool` with results).
`ToolSpec.parameters` is plain JSON Schema generated from each tool's Zod input.
Each adapter (`claude.ts`, `openai.ts`, about 100 lines each, raw `fetch` with no SDK) owns all
vendor specifics: the wire message shapes, the tool schema envelope (`input_schema` vs
`{type:'function', function}`), turn merging, argument JSON parsing, and usage accounting.
Cached input tokens are counted as input, because footprint is the metric.

These never cross the interface: model names (env `HARNESS_CLAUDE_MODEL` /
`HARNESS_OPENAI_MODEL`), keys (env only), prompt formats and tool-schema formats.
`test/agnostic.test.ts` fails the build if a provider name appears in `tasks/`, `plugins/`,
`harness/core/` or the templates. The task loader rejects `model`/`provider`/`driver` keys.

## Token budget

| Mechanism | Effect |
|---|---|
| Small fixed system prompt (about 1.4 KB) plus the task JSON | nothing about the repo is preloaded |
| JIT fetchers: `list_files`, `read_file` (ranges, 300-line cap), `search` (40 hits), `map_tests`, `standards <rule>` | the model pulls only the file, range or rule it needs next |
| Compact returns: tests and checks return one line per file plus failures; raw TAP and full reports go to `runs/<id>/artifacts/` and are referenced by path | the largest outputs never enter context |
| Compaction: all but the last 2 tool exchanges shrink to their first line; old `write_file` contents become `[N chars elided]` | history stays roughly flat instead of growing linearly |
| Deterministic scaffold | the model never spends tokens writing problem/pagination/idempotency plumbing |

Measurement is done by the harness on every run, in `tokens/<runId>.json`:

- `inputTokens` per turn as reported by the provider.
- `estimatedShadowBaseline` per turn. The harness keeps a counterfactual transcript of the same
  conversation with fetchers and compaction off (whole workspace and standards front-loaded,
  raw tool output kept) and sizes both requests with the same estimator.
- `harness bench <task> --driver X` runs the task twice on the same driver: `--mode baseline`
  on a throwaway copy, then `--mode jit` on the real target. It writes
  `tokens/bench-*.json` with measured per-turn input for both, plus total and peak reduction.
  This is the assignment's definition of the baseline.

Measured (gpt-5.5, greenfield `users-api`, `tokens/bench-users-api-openai-2026-10-06T12-09-07-847Z.json`):

| | turns | total input | peak per turn |
|---|---|---|---|
| baseline (front-loaded, no compaction) | 17 | 187,805 | 17,429 |
| JIT (fetchers + compaction) | 13 | 75,063 | 7,905 |
| reduction | | **60.0%** | **54.6%** |

The JIT context levels off at about 7.7k tokens: 1.3k of fixed cost (tool definitions and prompt) plus
the files being written, which the model must see. The baseline grows every turn. On a sample this small
(about 4k tokens of code) that caps the reduction well below the 90% target. The gap grows with repo size,
because the baseline front-loads the whole repo on every turn.

An earlier version compacted everything but the last two tool results. The model lost its working
set and re-read files in a loop for 40 turns. Compaction now drops only *superseded* content (each tool
declares a context key such as `file:src/app.ts`), under a size budget.

## Extension points

Core = **`harness/core/`**. Adding any of the following touches only the new file:

| Add | Drop a file in | Default export |
|---|---|---|
| tool | `plugins/tools/` | `defineTool({ name, description, input: zodSchema, run })` |
| hook | `plugins/hooks/` (runs in filename order) | `defineHook({ name, event: 'pre'\|'post', tools?, run })` |
| lint rule | `plugins/rules/` | `defineRule({ id, description, hint, check(api) })` |
| ORM validator | `plugins/validators/` | same as a rule; `optional: true` reports n/a when there is no ORM |
| driver | `harness/drivers/<name>.ts` | `(env) => Driver`; selected by `--driver <name>` |

Plugins import only `#harness/plugin-api.ts` (a package `imports` alias), so a file works
wherever it is dropped. Working examples are in `examples/plugins/`
(`route_diff` tool, `orm-explicit-select` validator, `no-console` rule).
`test/extensibility.test.ts` loads all three into a copied plugin root and checks they register
and report.

## Own addition: contract lock

sf-harness gates *when* a source edit may happen (observed red). The contract lock gates
*what* an edit may do to an existing API. At run start the harness snapshots the API surface:
every `METHOD /path` and the field list of every exported `z.object` schema. The
`contract-lock` pre-hook builds the API as it would look after the proposed write (an
in-memory overlay, nothing on disk) and blocks any write that removes a route or a schema
field. `gates.ts` checks the same thing again at the end, and `ship` checks it once more.
Additions are always allowed. This is what "lands without breaking contracts" means for
brownfield, enforced before the bytes hit disk.

## Honesty boundary

**Proven by the harness:** each rule's verdict per file. `tsc` with the strict flags forced.
Every test file passing under the harness's own runner. Each changed source file having a
mapped test the harness saw fail. No pre-existing route or schema field removed. The commit
containing exactly the re-gated workspace, on a fresh `harness/*` branch, never forced.

**Not proven / skipped:**

- The rules are syntactic and tuned to the Hono style of the scaffold (literal paths, a `c`
  context). Handlers they cannot resolve fail rather than pass, but an Express codebase would
  need its own rule plugins.
- Observed red proves that a mapped test *failed*, not *why*. A test failing for an unrelated
  reason unlocks the mapped files. The mapping (imports plus file/dir-name stem) unlocks every
  file in `src/<stem>/`.
- Pagination and idempotency are checked by presence (the helpers or `nextCursor` referenced,
  the header read). Their behaviour is only as proven as the tests the model wrote.
- Contract lock does not detect type narrowing of a field (string to enum) or changed status codes.
- Model-written tests run unsandboxed on the host, with provider credentials stripped from the
  env. They could still touch the filesystem.
- Pushing needs a remote and the PR needs an authenticated `gh`. Otherwise these steps are
  reported `skipped: UNPROVEN`, never done.

**A human still verifies:** that the tests assert the behaviours the task asks for, the
domain logic, and the PR itself.
