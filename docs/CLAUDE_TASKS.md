# Claude Code Task Rules

Claude Code tasks must be narrow and verifiable.

Each task must include:

- goal
- allowed files
- forbidden files
- input schema
- output schema
- fixture paths
- validation commands
- safety constraints

## Hard Rules

- Do not write real user configuration files.
- Do not emit secrets into logs, fixtures, snapshots, test output, or UI.
- Do not execute destructive commands such as `rm`, `kill`, `chmod`, `launchctl bootout`, Docker stop/remove, or model deletion.
- Use fixtures and temp directories for write-path tests.
- Keep collector logic separate from executor/action logic.
- Do not bypass Action Gateway for write-capable behavior.

## Good Task Shape

```text
Implement ClaudeConfigAdapter.collect() using tests/fixtures/claude.
Return ResourceNode[] and ResourceEdge[] matching src/shared/schemas.ts.
Do not read or write real ~/.claude files in tests.
Validate with npm test -- claudeConfigAdapter.
```

