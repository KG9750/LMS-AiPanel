# LMS-AiPanel

Localhost AI stack control plane for macOS AI tooling.

## Current Baseline

This repository contains the first runnable foundation:

- React/Vite/TypeScript UI
- Fastify API with a uniform envelope
- Resource Graph schemas
- Adapter Runtime with cancellation, single-flight refresh, stale fallback, and failure isolation
- Read-only adapters for Claude, Codex, Docker, Open WebUI, oMLX telemetry, LaunchAgents, local models, skills, and MCP config candidates
- Local Skill Manager module with live skill inventory, status summary, recent updates, and a read-only handoff path to the dedicated manager panel
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
LMS_AIPANEL_SKILL_MANAGER_PATH
LMS_AIPANEL_SKILL_MANAGER_PORT
```

The generic Skills adapter discovers installed skills from the configured skill roots. The optional Skill Manager module is a separate management and validation integration. It is disabled until its project path is configured explicitly:

```text
LMS_AIPANEL_SKILL_MANAGER_PATH=/absolute/path/to/skill-manager-project
LMS_AIPANEL_SKILL_MANAGER_PORT=8787
```

The Resource Graph adapter performs only a lightweight installation and panel identity check. Opening the Skill Manager page calls the dedicated module API, which runs `dist/cli/index.js scan --dry-run --json` with cancellation and a five-second timeout. Editing, disabling, and restoring skills remain in the dedicated Local Skill Manager panel. LMS-AiPanel never stores or renders that panel's one-time access token.

## Runtime Data

Runtime state belongs outside the repository:

```text
~/Library/Application Support/LMS-AiPanel
```
