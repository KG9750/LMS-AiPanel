# LMS-AiPanel PRD

## Product Goal

LMS-AiPanel is a localhost-only macOS AI stack control plane. It gives one operator a trustworthy view of configured AI tools, assistants, local models, runtimes, skills, MCP servers, and configuration files, with special focus on drift between configured and live state.

## MVP Scope

- Show a real AI stack overview for Claude Code, Codex, Docker, Open WebUI, LaunchAgents, local model directories, Codex skills, and MCP config candidates.
- Present resources in both table form and a lightweight relationship map.
- Show local-model token telemetry with endpoint-wide provider totals separated from partial client records, so Waku, headless tools, scripts, and UI clients are represented without double counting.
- Detect configured-vs-live drift with evidence.
- Provide a safe Config Center foundation: preview, diff, backup metadata, and guarded apply contracts.
- Provide action plans and dry-runs only for control actions; real start/stop/restart is explicitly deferred.
- Keep runtime state outside the repository under `~/Library/Application Support/LMS-AiPanel`.

## Non-Goals

- No public network access.
- No multi-user auth.
- No dynamic plugin marketplace or hot loading.
- No destructive actions such as deleting models or uninstalling skills.
- No long-term metrics dashboard in MVP.
- No full GGUF/safetensors metadata parser in MVP.

## Success Criteria

- The app starts locally and listens only on `127.0.0.1`.
- The UI can display resources returned by real read-only adapters.
- Adapter failures are isolated and surfaced as stale/unhealthy state.
- No API, log, UI, fixture, or database output includes plaintext secrets.
- Every write-capable code path is forced through the Action Gateway contract.
