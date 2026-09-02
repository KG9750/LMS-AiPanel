import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { parse, stringify } from "smol-toml";
import type { Db } from "../storage/db";

export const CONFIG_TYPE_CODEX = "codex-config-toml";

/**
 * Versioned Chinese field schema for the Codex config.toml (issue #19).
 * Each field exposes meaning, type, source, sensitivity, version, and
 * restart requirements. Unknown fields survive a round trip and are labeled
 * as undocumented.
 */
export interface ConfigFieldSpec {
  key: string;
  label: string;
  meaning: string;
  type: "string" | "number" | "boolean" | "string[]" | "object";
  source: string;
  sensitive: boolean;
  version: number;
  restartRequired: boolean;
}

export const CODEX_FIELD_SPECS: ConfigFieldSpec[] = [
  {
    key: "model",
    label: "模型",
    meaning: "Codex 使用的默认模型标识。",
    type: "string",
    source: "~/.codex/config.toml",
    sensitive: false,
    version: 1,
    restartRequired: false
  },
  {
    key: "model_provider",
    label: "模型供应商",
    meaning: "模型供应商标识，决定走哪个 API 端点。",
    type: "string",
    source: "~/.codex/config.toml",
    sensitive: false,
    version: 1,
    restartRequired: false
  },
  {
    key: "model_reasoning_effort",
    label: "推理强度",
    meaning: "推理强度等级（如 minimal/low/medium/high）。",
    type: "string",
    source: "~/.codex/config.toml",
    sensitive: false,
    version: 1,
    restartRequired: false
  },
  {
    key: "temperature",
    label: "温度",
    meaning: "采样温度，控制输出随机性。",
    type: "number",
    source: "~/.codex/config.toml",
    sensitive: false,
    version: 1,
    restartRequired: false
  },
  {
    key: "approval_policy",
    label: "审批策略",
    meaning: "Codex 工具调用审批策略。",
    type: "string",
    source: "~/.codex/config.toml",
    sensitive: false,
    version: 1,
    restartRequired: false
  },
  {
    key: "experimental",
    label: "实验性设置",
    meaning: "实验性功能开关集合（结构保留，字段级语义未文档化）。",
    type: "object",
    source: "~/.codex/config.toml",
    sensitive: false,
    version: 1,
    restartRequired: true
  }
];

export interface CodexFieldView {
  key: string;
  label: string;
  meaning: string;
  type: ConfigFieldSpec["type"];
  source: string;
  sensitive: boolean;
  version: number;
  restartRequired: boolean;
  value: unknown;
  valuePresent: boolean;
  documented: boolean;
}

export interface ConfigPreview {
  configType: string;
  filePath: string;
  fileHash: string;
  /** Fields known to the versioned schema. */
  documentedFields: CodexFieldView[];
  /** Fields present in the file but unknown to the schema. */
  undocumentedFields: Array<{ key: string; value: unknown }>;
  rawContent: string;
  /** External-change guard: the hash the preview was built against. */
  previewHash: string;
}

export interface DiffLine {
  type: "same" | "added" | "removed";
  line: string;
}

export interface BackupRecord {
  id: string;
  hostId: string;
  configType: string;
  filePath: string;
  content: string;
  fileHash: string;
  actionRunId?: string;
  createdAt: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function tomlValueType(value: unknown): ConfigFieldSpec["type"] {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "string[]";
  return "object";
}

/**
 * Config Center service for one supported configuration type (Codex
 * config.toml). Reads are hash-guarded; applies use backup -> temp file ->
 * atomic rename -> re-read -> post-apply verification, all recorded as
 * ActionRun + audit evidence.
 */
export class ConfigCenter {
  constructor(
    private readonly db: Db,
    private readonly hostId: string
  ) {}

  async readPreview(filePath: string): Promise<ConfigPreview> {
    const rawContent = await fs.readFile(filePath, "utf8");
    const parsed = parse(rawContent) as Record<string, unknown>;
    const fileHash = sha256(rawContent);

    const documentedFields: CodexFieldView[] = CODEX_FIELD_SPECS.map((spec) => ({
      key: spec.key,
      label: spec.label,
      meaning: spec.meaning,
      type: spec.type,
      source: spec.source,
      sensitive: spec.sensitive,
      version: spec.version,
      restartRequired: spec.restartRequired,
      value: parsed[spec.key],
      valuePresent: Object.prototype.hasOwnProperty.call(parsed, spec.key),
      documented: true
    }));

    const undocumentedFields = Object.entries(parsed)
      .filter(([key]) => !CODEX_FIELD_SPECS.some((spec) => spec.key === key))
      .map(([key, value]) => ({ key, value }));

    return {
      configType: CONFIG_TYPE_CODEX,
      filePath,
      fileHash,
      documentedFields,
      undocumentedFields,
      rawContent,
      previewHash: fileHash
    };
  }

  /** External-change guard: true when the file still matches the preview hash. */
  async previewIsFresh(preview: ConfigPreview): Promise<boolean> {
    try {
      const current = await fs.readFile(preview.filePath, "utf8");
      return sha256(current) === preview.previewHash;
    } catch {
      return false;
    }
  }

  diff(original: string, updated: string): DiffLine[] {
    const a = original.split("\n");
    const b = updated.split("\n");
    const lines: DiffLine[] = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) {
        lines.push({ type: "same", line: a[i] ?? "" });
      } else {
        if (a[i] !== undefined) lines.push({ type: "removed", line: a[i] });
        if (b[i] !== undefined) lines.push({ type: "added", line: b[i] });
      }
    }
    return lines;
  }

  /**
   * Applies the edited content: validates the preview is fresh, backs up the
   * original, writes atomically, re-reads, and returns verification evidence.
   */
  async apply(
    preview: ConfigPreview,
    updatedContent: string,
    actionRunId: string
  ): Promise<{
    ok: boolean;
    evidence: string[];
    backup: BackupRecord;
    error?: string;
  }> {
    const evidence: string[] = [];
    const fresh = await this.previewIsFresh(preview);
    if (!fresh) {
      return {
        ok: false,
        evidence: ["preview invalidated by external file change; re-read before apply"],
        backup: await this.backup(preview.filePath, actionRunId, "invalidated"),
        error: "external change detected"
      };
    }
    evidence.push("preview hash matches current file (external-change guard passed)");

    const backup = await this.backup(preview.filePath, actionRunId, "before-apply");

    // Atomic replacement: temp file -> fsync -> rename.
    const dir = path.dirname(preview.filePath);
    const tmpPath = path.join(dir, `.lms-aipanel-${nanoid(8)}.tmp`);
    await fs.writeFile(tmpPath, updatedContent, "utf8");
    const handle = await fs.open(tmpPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, preview.filePath);
    evidence.push("temp file written, fsynced, and atomically renamed");

    // Re-read and verify the applied content.
    const reRead = await fs.readFile(preview.filePath, "utf8");
    const reParsed = parse(reRead) as Record<string, unknown>;
    const appliedHash = sha256(reRead);
    if (appliedHash === sha256(updatedContent) && typeof reParsed === "object") {
      evidence.push("post-apply re-read verified: content hash matches and TOML parses");
      return { ok: true, evidence, backup };
    }
    return {
      ok: false,
      evidence: [...evidence, "post-apply re-read failed: hash mismatch or parse error"],
      backup,
      error: "post-apply verification failed"
    };
  }

  private async backup(filePath: string, actionRunId: string, reason: string): Promise<BackupRecord> {
    const content = await fs.readFile(filePath, "utf8");
    const record: BackupRecord = {
      id: `backup:${nanoid(10)}`,
      hostId: this.hostId,
      configType: CONFIG_TYPE_CODEX,
      filePath,
      content,
      fileHash: sha256(content),
      actionRunId,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO config_backups (id, host_id, config_type, file_path, content, file_hash, action_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(record.id, record.hostId, record.configType, record.filePath, record.content, record.fileHash, record.actionRunId ?? null, record.createdAt);
    void reason;
    return record;
  }

  /** Restores a backup's content to the original file path (rollback path). */
  async restore(backupId: string): Promise<BackupRecord | null> {
    const row = this.db
      .prepare(
        "SELECT id, host_id, config_type, file_path, content, file_hash, action_run_id, created_at FROM config_backups WHERE id = ? AND host_id = ?"
      )
      .get(backupId, this.hostId) as unknown as
      | {
          id: string;
          host_id: string;
          config_type: string;
          file_path: string;
          content: string;
          file_hash: string;
          action_run_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    const record: BackupRecord = {
      id: row.id,
      hostId: row.host_id,
      configType: row.config_type,
      filePath: row.file_path,
      content: row.content,
      fileHash: row.file_hash,
      actionRunId: row.action_run_id ?? undefined,
      createdAt: row.created_at
    };
    await fs.writeFile(record.filePath, record.content, "utf8");
    return record;
  }

  listBackups(limit = 20): BackupRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, host_id, config_type, file_path, content, file_hash, action_run_id, created_at FROM config_backups WHERE host_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(this.hostId, limit) as unknown as Array<{
      id: string;
      host_id: string;
      config_type: string;
      file_path: string;
      content: string;
      file_hash: string;
      action_run_id: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      hostId: row.host_id,
      configType: row.config_type,
      filePath: row.file_path,
      content: row.content,
      fileHash: row.file_hash,
      actionRunId: row.action_run_id ?? undefined,
      createdAt: row.created_at
    }));
  }
}