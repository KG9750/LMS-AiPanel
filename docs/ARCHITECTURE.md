# LMS-AiPanel Architecture

## Layers

1. **UI Shell**: React, Vite, TypeScript. Shows resource tables, lightweight stack map, drift evidence, adapter health, and audit entries.
2. **Control API**: Fastify and Zod. All endpoints return `{ ok, data, error, meta }`.
3. **Domain Core**: Resource Graph, Adapter Runtime, Drift Engine, Action Gateway, Redaction Service, Snapshot Manager.
4. **Adapters**: Static MVP adapters for Claude, Codex, Docker, Open WebUI, oMLX telemetry, LaunchAgent, Local Models, Skills, and MCP. The optional Local Skill Manager adapter is registered only when its project path is explicitly configured.
5. **Local State**: SQLite WAL-ready pathing and migration SQL under the user Application Support directory.

## Resource Graph

Nodes use stable ids in the form:

```text
<adapter>:<type>:<stable-key>
```

Examples:

- `claude:config:user-settings`
- `codex:tool:codex-desktop`
- `docker:container:open-webui-hauhau`
- `local-model:model:path-<url-safe-path-key>`

Edges express relationships such as `configured_by`, `uses`, `runs_on`, `exposes`, `depends_on`, and `owns`.

## Adapter Runtime

Adapters are read-only by default. Each adapter run produces:

- resources
- edges
- redaction hints
- adapter run metadata

Each adapter has an independent timeout and receives an `AbortSignal`. Concurrent refresh requests share one collection. Failure in one adapter does not block other adapters. If a run fails, the runtime uses the most recent successful snapshot, including a snapshot restored from SQLite after restart, and marks its nodes `stale`.

## Drift Engine

MVP drift compares `configured` against `live`.

`expected` is reserved for a later declarative/pinned desired-state feature. MVP drift must not invent expected state.

Statuses:

- `ok`
- `drift-config`
- `drift-runtime`
- `unreachable`
- `unknown`

Each drift record must include evidence.

## Action Gateway

MVP action types are:

- `read`
- `dry-run`
- `configure`

Real control actions such as start, stop, restart, unload, or kill are deferred. Any future write action must pass confirmation, backup, validation or dry-run, and audit.

## Redaction

Adapters may provide hints, but platform redaction is enforced at API/storage boundaries. Sensitive field names include token, key, secret, password, credential, auth, and helper.

## Storage

Runtime data lives outside the repository:

```text
~/Library/Application Support/LMS-AiPanel/storage
~/Library/Application Support/LMS-AiPanel/backups
~/Library/Application Support/LMS-AiPanel/logs
```

Snapshots store redacted summaries and evidence, not full raw config contents. SQLite persists the latest normalized resources, relations, adapter runs, drift records, audit entries, and up to 100 recent system snapshots.

## Adapter Catalog

The MVP keeps static adapter registration while centralizing built-in paths in an `AdapterCatalog`. Model roots, skill roots, and MCP config candidates can be overridden with path-delimited environment variables. One unreadable root does not prevent other configured roots from being scanned.

## Skill Discovery And Management

The generic Skills adapter owns discovery: it inventories skill directories from configured roots without requiring a management tool. Local Skill Manager is an optional management and validation side path enabled by `LMS_AIPANEL_SKILL_MANAGER_PATH`; no machine-specific project path is built in.

The Resource Graph hot path only verifies that the configured directory and built CLI exist, then probes `/api/session` to identify the panel. A full `scan --dry-run --json` runs only through `/api/modules/skill-manager`, receives request cancellation, and is limited to five seconds. The response is normalized and validated with Zod before crossing the API boundary; summary counts are recomputed from accepted skill records.

The dedicated panel requires a one-time URL printed by its own process. LMS-AiPanel records neither that URL nor its token and does not construct a tokenless link. Skill Manager scan output is an on-demand response and is not persisted in Resource Graph snapshots.

## Local Model Token Usage

Token telemetry has two independent layers:

- **Provider telemetry** is the endpoint-wide source of truth. The oMLX adapter reads cumulative prompt, completion, cached-token, and request counters from each instance's `stats.json`. Every request that reaches that oMLX endpoint is included, whether it comes from Waku, a headless CLI, a script, Open WebUI, or another client. Cumulative endpoint counters cannot identify which client made each request.
- **Client telemetry** is a partial client-side view. The Open WebUI adapter aggregates `input_tokens`, `output_tokens`, `total_tokens`, request count, and latest usage time by `model_id` from `chat_message.usage`. It never reads chat content for this feature.

Provider and client values may describe the same requests, so the UI presents them separately and never adds them together. Missing telemetry is unavailable rather than zero. A runtime without provider-side counters cannot provide complete historical usage; full future coverage requires provider instrumentation or routing local inference through a shared observability gateway.
