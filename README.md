# LMS-AiPanel

Localhost AI stack control plane for macOS AI tooling.

## Current Baseline

This repository contains the first runnable foundation:

- React/Vite/TypeScript UI
- Fastify API with a uniform envelope
- Resource Graph schemas
- Adapter Runtime with timeout and failure isolation
- Read-only adapters for Claude, Codex, Docker, Open WebUI, LaunchAgents, local models, skills, and MCP config candidates
- Drift detection for configured-vs-live MVP signals
- Action execution disabled by default; action planning only

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

## Runtime Data

Runtime state belongs outside the repository:

```text
~/Library/Application Support/LMS-AiPanel
```

