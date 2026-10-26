# @vellumai/evals

The **Vellum Personal-Intelligence Benchmark** — a decision instrument for plugin-shipping decisions and competitive benchmarking against other personal-intelligence agents.

Runs profiles (species + setup commands + initial workspace) against tests (memory, judgment, initiative, follow-through, communication, cross-context coherence, trust handling, life navigation), generates a report card, drives product decisions.

**Not a CI gate. Not a regression suite.** Runs in a developer's sandbox on demand.

## Quick start

```bash
cd evals
bun install
cp .env.example .env
# configure the simulator and judge provider in .env (see below)

bun run src/cli.ts run \
  --profiles p1,p2 \
  --benchmark personal-intelligence \
  --filter timeline-recall \
  --label "baseline-after-cache-fix"

bun run src/cli.ts server
```

`--benchmark` defaults to `personal-intelligence`; omit `--filter` to run
every unit in the benchmark. `--label` tags every (profile, unit) execution
in the invocation with the same `sessionId`, so the report server can show
them as a single grouped run.

The legacy `--tests <ids>` flag is accepted as a deprecated alias for
`--filter <ids>` against the personal-intelligence benchmark.

## Simulator and judge provider

The simulator and LLM judges share one harness provider. This does not change
the assistant models selected by benchmark profiles.

For GPT-6 Astra through Azure, configure:

```sh
export EVALS_LLM_PROVIDER=azure
export EVALS_LLM_MODEL=gpt-6-astra
export AZURE_OPENAI_ENDPOINT=https://RESOURCE.openai.azure.com/openai/v1
# AZURE_OPENAI_API_KEY must be available in the process environment.
```

Set `EVALS_LLM_MODEL` to the deployed name when the Azure deployment has a custom
name. `AZURE_OPENAI_DEPLOYMENT` is also supported when `EVALS_LLM_MODEL` is unset.
Alternatively, set both `EVALS_AZURE_RESOURCE_NAME` and
`EVALS_AZURE_RESOURCE_GROUP` after signing in with Azure CLI. Local `evals run`
loads that resource's `key1` into its process environment before starting.
The endpoint hostname must belong to the same Azure resource. This explicit
resource selection overrides a stale shell key without changing shell or Codex
settings, storing a key on disk, or rotating any credentials. Remote launcher
runs need credentials configured separately in their execution environment.

The Azure transport uses Responses, low reasoning effort, disabled response
storage and a two-minute request timeout. It does not send sampling parameters
or automatically retry failed calls. The simulator allows 8,192 output tokens;
the judge allows 4,096, including reasoning.

For Anthropic, set `EVALS_LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.
The existing Haiku default and request tuning are retained unless
`EVALS_LLM_MODEL` is explicitly set. There is no cross-provider fallback.

Personal-intelligence runs save harness request identity, timing and reported
token usage in each run's `harness-usage.jsonl`. It contains no prompts or keys.
Harness usage is separate from intercepted assistant usage and is not included
in assistant-cost metrics. Monetary harness cost is explicitly unpriced, not
zero. Use the same harness provider/model across a comparison and do not mix
scores from different judges as though they came from one measurement.

The harness unit tests use deterministic provider defaults and mocked calls.
Run the relevant transport tests with:

```sh
bun test src/lib/__tests__/harness-llm.test.ts \
  src/lib/__tests__/user-simulator.test.ts \
  src/lib/__tests__/llm-judge.test.ts
```

## Nuvi model comparison

The `nuvi-glm-flash`, `nuvi-kimi-code` and `nuvi-deepseek-flash` profiles run
fresh Nuvi containers through direct Cloudflare inference. Set
`EVALS_ASSISTANT_SOURCE` to the Nuvi checkout,
`EVALS_CLOUDFLARE_ACCOUNT_ID` to the account that serves the models, and sign
in with Wrangler. `EVALS_NUVI_CLI` and `EVALS_WRANGLER_CLI` can select explicit
executables.

To reuse a completed source build, set `EVALS_NUVI_LOCAL_IMAGE_TAG` to its
shared image tag and keep `bun scripts/serve-local-nuvi-images.ts` running
in a separate terminal. The loopback-only loader verifies the three pinned
image identities and rejects other references. Each test still gets fresh
containers and workspace state. Unset the variable to build from source.

Each test has an isolated CLI lockfile and workspace. The adapter reuses the
CLI conversation protocol, not a connection to a personal assistant. The
Cloudflare credential is retrieved through `wrangler auth token --json`,
passed through stdin into the recording sidecar's tmpfs, and never supplied
to the assistant. It is refreshed after image startup before configuring the
assistant, so a cold build cannot leave an expired login in the sidecar.
The sidecar only authenticates POST requests to the selected
account's chat-completion endpoint for that run's explicitly allowed models.
Other Cloudflare routes and models fail closed. Response token usage is
recorded through the existing egress recorder. The runtime allowlist also
permits embedding assets and GitHub Release assets for Nuvi's managed Qdrant
process; these downloads receive no Cloudflare credential.

These profiles bypass Nuvi's managed platform transport and use
`openai-compatible` inference with medium effort and a 16,384-token profile
output budget, subject to the assistant's call-site tuning. Non-main call
sites are configured to the same DeepSeek V4 Flash auxiliary profile across
the comparison. This is not a comparison of shipped managed-profile tuning.
Keep the simulator and judge on the same Azure Astra configuration.
Cloudflare models are unpriced in the local pricing table, so cost metrics
remain unavailable rather than counting as free.

After an isolated smoke test succeeds, run the small pilot with:

```sh
bun run src/cli.ts run \
  --profiles nuvi-glm-flash,nuvi-kimi-code,nuvi-deepseek-flash \
  --filter timeline-recall,surgical-bugfix-ledger,lab-freezer-inventory-totals \
  --workers 1 --label nuvi-cloudflare-pilot
```

Full source-image construction, isolated startup and scored timeline recall
have been verified. Fresh instances start with cold embedding caches.
Memory-tool startup timeouts must be reported separately from model quality.

## Commands

| Command                                                          | Description                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `evals run --profiles <ids> [--benchmark <id>] [--filter <ids>]` | Cartesian profile × benchmark-unit runner. `--label <text>` tags the run. |
| `evals benchmarks list`                                          | List available benchmarks with their unit noun and unit count.            |
| `evals export --session <id> --out <path>`                       | Export a report session as JSONL for diffing and notebooks.               |
| `evals server`                                                   | Local report-card server for `.runs` at `localhost:3005`.                 |

The report server is organized as a hierarchy:

- `/` – list of runs (sessions). One card per `evals run` invocation.
- `/sessions/<id>` – per-profile score aggregates and the list of tests.
- `/sessions/<id>/tests/<testId>` – per-profile summaries on that test.
- `/sessions/<id>/tests/<testId>/profiles/<profileId>` – execution detail
  with the metric card, transcript, container event log, and test-runner
  progress log for that specific run.

Use `evals export --session <id> --out runs/<label>.jsonl` when you want a
portable artifact for comparing eval runs outside the report server. The JSONL
contains the session summary, per-test aggregate rows, and per-profile execution
metric summaries without embedding full transcripts or raw event logs.

For the end-to-end coding-cost baseline procedure (pre-fix assistant vs
post-fix HEAD vs Hermes, with `evals compare` recipes), see
[docs/runbooks/coding-cost-baseline.md](docs/runbooks/coding-cost-baseline.md).

## Layout

```
evals/
├── src/
│   ├── cli.ts               # CLI entry — `evals <command>`
│   ├── index.ts             # Module entry — public TS API
│   ├── commands/run.ts      # `evals run` subcommand
│   └── lib/                 # Harness library modules
├── profiles/                # Committed profile definitions
│   ├── p1/
│   │   └── manifest.json
│   └── p2/
│       └── manifest.json
├── benchmarks/              # One subdirectory per benchmark
│   ├── personal-intelligence/
│   │   ├── manifest.json    # displayName + unitDirName + unitNoun
│   │   └── tests/           # Unit definitions (`unitDirName` per manifest)
│   │       └── timeline-recall/
│   │           ├── SPEC.md  # simulator briefing
│   │           └── metrics/ # (optional) per-metric `.ts` scorers
│   └── longmemeval-v2/
│       ├── manifest.json    # displayName + unitDirName + unitNoun
│       ├── data/            # gitignored; populate via `data/download.sh`
│       ├── items/           # virtual unit dir — items materialized by `src/loader.ts`
│       └── src/             # benchmark-local code (loader, fixtures, tests)
├── .env.example             # API key contract
├── package.json
└── AGENTS.md                # Conventions
```

## Profile

A profile lives at `profiles/<id>/`. The directory name is the profile id.

`manifest.json` declares species, optional version, and optional setup commands run after the agent is hatched and before the test starts.

```json
{
  "species": "vellum",
  "setup": ["assistant plugins install simple-memory"]
}
```

Run `evals profiles list` to see all committed profiles and their setup.

`workspace/` (optional) holds files dropped into the agent's workspace before the run starts.

## Benchmark

A benchmark lives at `benchmarks/<id>/`. The directory name is the benchmark id.

`manifest.json` declares display metadata and where its units live:

```json
{
  "displayName": "Personal Intelligence",
  "unitDirName": "tests",
  "unitNoun": "test"
}
```

- `displayName` — human-readable name shown in `evals benchmarks list` and help text.
- `unitDirName` — directory under the benchmark root holding individual units (e.g. `tests`, `items`, `questions`).
- `unitNoun` — singular noun for one unit (`test`, `item`, `question`); used in CLI output so each benchmark speaks its own vocabulary.

Run `evals benchmarks list` to see all committed benchmarks.

## Test

A test lives at `benchmarks/personal-intelligence/tests/<id>/`. The directory name is the test id. (Other benchmarks live as peers under `benchmarks/` and may use different unit names.)

`SPEC.md` briefs the simulator agent on the role it plays and how it should interact with the assistant. It does not describe assertion behavior.

`setup.ts` optionally exports deterministic setup commands. `metrics/` is a directory of `.ts` files. Each metric file exports a default scorer. Metrics receive a run id and call metric-library helpers such as readTranscript(runId), readAssistantEvents(runId), and readUsage(runId). Run artifacts are stored under .runs/<run-id>.
