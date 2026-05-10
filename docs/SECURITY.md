# LMS-AiPanel Security Model

LMS-AiPanel is localhost-only, but local access is not treated as a substitute for safety.

## Baselines

- Bind to `127.0.0.1`.
- Keep runtime state outside the repository.
- Redact secrets before API responses, storage snapshots, logs, and UI rendering.
- Default to read-only adapters.
- Require Action Gateway for all write-capable operations.

## Sensitive Data

Fields are sensitive when their key path includes:

- token
- api key
- secret
- password
- credential
- auth
- helper

Sensitive values are represented as `<redacted>`.

## Configuration Writes

Configuration writes are deferred until the Config Center milestone. They must use:

- file hash check before apply
- temp-file write
- fsync
- atomic rename
- backup metadata
- audit event

