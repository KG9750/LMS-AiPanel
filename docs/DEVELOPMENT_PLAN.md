# LMS-AiPanel Development Plan

## Milestones

- **M0 Architecture & Repo Setup**: repository, docs, ignore rules, version workflow.
- **M1 Foundation**: React/Vite/Fastify/TypeScript/Vitest, schemas, API envelope, mock graph.
- **M2 Adapter Runtime**: adapter contract, timeout, stale state, redaction boundary, adapter health.
- **M3 First Adapters**: Claude, Codex, Docker read-only adapters.
- **M4 Drift Engine**: configured-vs-live drift and evidence in UI.
- **M5 Local Stack Adapters**: Open WebUI, LaunchAgent, Local Models, Skills, MCP.
- **M6 Config Center & Action Gateway**: preview/diff, atomic write contract, guarded configure only.
- **M7 UI Polish & E2E**: browser QA and read-only live machine verification.

## Version Control

- `main` must remain runnable and test-passing.
- Feature work uses `feature/<scope>` branches.
- Fix work uses `fix/<scope>` branches.
- PRs must include scope, test results, and security notes.

## Release Tags

- `v0.1.0`: runnable skeleton plus mock graph.
- `v0.2.0`: adapter runtime plus Claude/Codex/Docker adapters.
- `v0.3.0`: drift engine plus drift UI.
- `v0.4.0`: local stack adapters.
- `v0.5.0`: config center, action plan, dry-run, audit.
- `v1.0.0`: stable local AI stack overview.

## Validation

Every milestone must pass:

```bash
npm test
npm run build
```

Live machine collection remains read-only unless a later task explicitly opens controlled configuration writes.

