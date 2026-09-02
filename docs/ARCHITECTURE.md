# LMS-AiPanel Architecture

## Layers

1. **UI Shell**: React, Vite, TypeScript. Shows resource tables, lightweight stack map, drift evidence, adapter health, and audit entries.
2. **Control API**: Fastify and Zod. All endpoints return `{ ok, data, error, meta }`.
3. **Domain Core**: Resource Graph, Adapter Runtime, Drift Engine, Action Gateway, Redaction Service, Snapshot Manager.
4. **Adapters**: Static MVP adapters for Claude, Codex, Docker, Open WebUI, LaunchAgent, Local Models, Skills, and MCP.
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
