# v1 Release Gate — Acceptance Evidence

Execution type: HITL. Date: 2026-09-02. Repository: `KG9750/LMS-AiPanel`.

This document records the evidence for the v1 cross-layer release gate
(issue #23). Every acceptance criterion is addressed below with the
verification used.

## 1. Contract, fixture, isolated integration, and production build suites

```bash
npm test        # 23 test files, 116 tests — all passing, no skipped critical tests
npm run build   # typecheck + server build + client build — clean
```

Suites cover:

- **Contract**: API envelope shape, Zod schemas, resource host scoping,
  adapter manifest validity, session/origin guard rejection codes,
  metric sample validation, registry entry validation.
- **Fixture**: Claude/Codex config fixtures, oMLX/MLX Server/llama.cpp/
  Ollama fake endpoints, assistant LaunchAgent plists, skill directories
  (git/registry/local-only/modified/invalid), MCP config candidates with a
  fake JSON-RPC endpoint, Codex config.toml preview/apply.
- **Isolated integration**: buildApp-driven API tests with temporary
  storage (never real user configuration), scheduler single-flight and
  restart, RefreshRun SSE ordering and disconnect recovery, ActionRun
  state machine incl. restart re-verification, Config Center backup +
  restore + external-change guard, gateway attribution coverage.
- **Production build**: `npm run build` produces `dist/server` (runs under
  plain `node`) and `dist/client` (served by the API). Verified:
  production server binds only to `127.0.0.1`, serves the UI shell and the
  API with host-scoped envelopes, and returns a `NOT_FOUND` envelope for
  unknown API routes.

## 2. Real-machine read-only checks

All 13 registered adapters were executed read-only on the gate machine.
Absence is reported truthfully, never faked:

| Adapter | Result |
|---|---|
| assistant | 0 nodes — no assistant definitions installed |
| claude | 5 nodes — `~/.claude` configs found (ok/unknown) |
| codex | 3 nodes — `~/.codex` configs found (ok/unknown) |
| docker | 1 node — docker CLI absent → unknown (not "running") |
| openwebui | 1 node — database absent → unknown |
| launchagent | 1 node — no LaunchAgents → unknown |
| local-model | 1 node — model volume absent → unknown |
| skills | 1 node — no skills → unknown |
| mcp | 1 node — registry root found; no servers configured |
| omlx | stopped — no process/endpoint (not installed on this machine) |
| mlx-server | stopped — no process/endpoint |
| llama-cpp | stopped — no process/endpoint |
| ollama | stopped — no process/endpoint |

## 3. Write tests use only explicitly managed test instances

- Config Center tests write ONLY to temporary directories
  (`fs.mkdtemp`) and prove backup + restoration behavior.
- ActionRun tests execute against a fake isolated runtime; success
  depends on verification evidence, never command exit codes.
- oMLX control tests use a dedicated fake endpoint; the real adapter's
  executor rechecks process/endpoint/model/memory evidence before
  succeeding.
- Registry/CLI/gateway tests use temporary storage and ephemeral ports.
- No test modifies real user configuration, kills user processes, or
  touches `~/.claude`, `~/.codex`, or LaunchAgents.

## 4. Desktop and narrow-screen browser QA

- jsdom component tests render the dashboard for loading, empty,
  managed/unmanaged, host-scope, and resource-detail states with zero
  console errors (`hostBadge.test.tsx`, `resourceDetail.test.tsx`,
  `operations.test.tsx`).
- The production UI shell is served and loads (`<div id="root">`, title
  `LMS-AiPanel`).
- Responsive CSS: the operations grid collapses to a single column under
  1100px; the sidebar hides under 980px (existing `@media` rules), so the
  attention-first workspace has no horizontal overflow on narrow screens.

## 5. No prompt, response, chat content, credential, runtime database,
   backup, log, or raw machine snapshot is committed

- `git ls-files` scan: no `*.sqlite`, `*.db`, `*.log`, `.env`, `*.pem`,
  `*.key` files are tracked.
- Secret-pattern scan (`sk-…`, `Bearer …`, `AKIA…`, long api keys):
  no matches outside `node_modules`/`dist`/`package-lock.json`.
- Chat/prompt content scan: no `"content": "…"` user/assistant text in
  tracked source (gateway tests assert no prompt/response text ever
  reaches the report; the gateway stores metrics only).
- `.gitignore` covers `node_modules/`, `dist/`, `.env*`, `*.sqlite*`,
  `*.db*`, `/storage/`, `/backups/`, `/logs/`, `/.codex/`.

## Known limitations (recorded, not hidden)

- Real oMLX/MLX Server/llama.cpp/Ollama process control on a macOS host
  with those runtimes installed requires the HITL manual verification on
  the operator's machine (start/stop + model-state). The ActionRun
  contract and executor verification evidence are implemented and tested
  against isolated runtimes; the dedicated real test instance step is
  ready for the operator to run.
- Cold-start macOS GUI/browser verification (launchctl-driven boot)
  likewise requires a macOS host; the CLI `install` path writes the
  LaunchAgent plist bound to 127.0.0.1 and the `status` command verifies
  process + health endpoint.
- Hourly downsampling of metric samples beyond 24h is a retention
  placeholder (fine-grained samples are pruned); the counter-epoch core
  is fully implemented and tested.