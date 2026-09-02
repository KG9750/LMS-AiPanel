# Grok Independent Review Fixes

This document records the item-by-item remediation of the independent Grok CLI review.

1. **Redaction boundary**: Adapter results are redacted before caching, persistence, and API output. Redaction hints are applied centrally. JSON-looking strings are structurally redacted. Open WebUI metadata now uses an allowlist.
2. **Drift semantics**: A stopped resource is not drift by itself. Drift requires explicit `configured=true` evidence; LaunchAgent nodes provide configured and loaded evidence.
3. **Persistence**: SQLite persists redacted snapshots, normalized graph data, adapter runs, drift records, and audit entries. Runtime seeds stale fallback data from the latest persisted snapshot after restart.
4. **Runtime cancellation**: Each adapter receives an `AbortSignal`; subprocess adapters pass it to `execa`. Concurrent refreshes share one collection, and late timeout results cannot replace successful cache state.
5. **Localhost boundary**: Non-loopback binding is rejected unless the explicit remote opt-in is set. Health output contains no application paths.
6. **Portable discovery**: A static `AdapterCatalog` centralizes model roots, skill roots, MCP candidates, and environment overrides. Skills include Codex, Claude, and shared agent roots. MCP includes Claude Desktop and Claude Code candidates. LaunchAgent matching uses exact labels and emits assistant nodes for OpenClaw and Hermes.
7. **Tooltip accessibility**: Visible labels remain the accessible text, tooltips use `aria-describedby`, and ordinary labels no longer add Tab stops.
8. **Tests**: Fixtures now exercise Claude and Codex parsers. Tests cover redaction, Open WebUI metadata, configured-vs-live drift, timeout/abort/single-flight/stale behavior, SQLite restart persistence, action schemas, loopback binding, and tooltip markup.
9. **API contracts**: Action plan bodies use a strict Zod schema. Resource and drift endpoints use the common error envelope. Adapter health includes the latest runtime record. Real execution remains disabled.
10. **UI information architecture**: Sidebar items filter real resource types, mobile has replacement navigation, stale nodes are visibly marked, and unimplemented configuration/audit screens are not presented as working routes.

Validation commands:

```bash
npm test
npm run typecheck
npm run build
```

Manual validation covers the live API, desktop rendering, a 386px mobile iframe viewport, navigation filtering, tooltip linkage, console errors, and horizontal overflow.
