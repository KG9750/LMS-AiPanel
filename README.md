# LMS-AiPanel

Localhost AI stack control plane for macOS AI tooling.

## Current Baseline

This repository contains the first runnable foundation:

- React/Vite/TypeScript UI
- Fastify API with a uniform envelope
- Resource Graph schemas
- Adapter Runtime with cancellation, single-flight refresh, stale fallback, and failure isolation
- Read-only adapters for Claude, Codex, Docker, Open WebUI, oMLX telemetry, LaunchAgents, local models, skills, and MCP config candidates
- Drift detection for configured-vs-live MVP signals
- Action execution disabled by default; action planning only
- SQLite persistence for redacted snapshots and audit entries
- Chinese resource filters and detailed hover descriptions
- Provider-level local token totals from oMLX, plus separate client-level details from Open WebUI history

## Run

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

API server:

```text
http://127.0.0.1:3777
```

## Validate

```bash
npm test
npm run build
```

Optional path-delimited discovery overrides:

```text
LMS_AIPANEL_MODEL_ROOTS
LMS_AIPANEL_SKILL_ROOTS
LMS_AIPANEL_MCP_CONFIGS
LMS_AIPANEL_OMLX_DATA_ROOTS
```

## Runtime Data

Runtime state belongs outside the repository:

```text
~/Library/Application Support/LMS-AiPanel
```
