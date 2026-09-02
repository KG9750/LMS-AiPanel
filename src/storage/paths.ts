import path from "node:path";
import os from "node:os";

export interface AppPaths {
  root: string;
  storage: string;
  backups: string;
  logs: string;
  databasePath: string;
  migrationsDir: string;
}

export function getAppPaths(): AppPaths {
  const override = process.env.LMS_AIPANEL_DATA_DIR;
  const root =
    override && override.trim().length > 0
      ? override
      : path.join(os.homedir(), "Library", "Application Support", "LMS-AiPanel");

  return {
    root,
    storage: path.join(root, "storage"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
    databasePath: path.join(root, "storage", "lms-aipanel.sqlite"),
    migrationsDir: path.join(process.cwd(), "migrations")
  };
}