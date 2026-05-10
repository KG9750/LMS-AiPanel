# GitHub Workflow

Remote repository:

```text
https://github.com/KG9750/LMS-AiPanel
```

## Branches

- `main`: runnable, tested baseline.
- `feature/<scope>`: new implementation work.
- `fix/<scope>`: corrections after review or test failure.
- `docs/<scope>`: planning or documentation changes.

## Pull Requests

Each PR must include:

- purpose and scope
- implementation summary
- validation commands and results
- security notes
- whether the change touches real configuration or only fixtures

## Runtime Data

Never commit:

- runtime SQLite databases
- backups
- logs
- `.env` files
- secrets
- raw machine snapshots

