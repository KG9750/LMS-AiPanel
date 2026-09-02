import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type {
  SkillManagerIssue,
  SkillManagerModuleSnapshot,
  SkillManagerSkill,
  SkillManagerStatus,
  SkillManagerSummary,
  SkillManagerValidationState
} from "../shared/schemas";

const DEFAULT_PORT = 8787;

interface SkillManagerScanPayload {
  skills?: unknown[];
  rootWarnings?: unknown[];
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CollectOptions {
  environment?: NodeJS.ProcessEnv;
  projectPath?: string;
  cliPath?: string;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  runCommand?: (file: string, args: string[], options: { cwd: string; signal?: AbortSignal }) => Promise<CommandResult>;
  checkPort?: (port: number) => Promise<boolean>;
  probePanel?: (port: number) => Promise<PanelProbe>;
}

export interface PanelProbe {
  portOccupied: boolean;
  identityVerified: boolean;
}

interface InspectOptions {
  projectPath: string;
  cliPath?: string;
  port?: number;
  probePanel?: (port: number) => Promise<PanelProbe>;
}

export async function inspectSkillManagerIntegration(options: InspectOptions) {
  const projectPath = options.projectPath.trim();
  if (!projectPath) throw new Error("未配置技能管理器项目路径。");
  const cliPath = options.cliPath ?? path.join(projectPath, "dist", "cli", "index.js");
  if (!(await exists(cliPath))) throw new Error("技能管理器 CLI 尚未构建。");
  const port = options.port ?? DEFAULT_PORT;
  const probe = await (options.probePanel ?? probeSkillManagerPanel)(port);
  return { projectPath, cliPath, panel: panelStatus(projectPath, port, probe) };
}

export async function collectSkillManagerModule(options: CollectOptions = {}): Promise<SkillManagerModuleSnapshot> {
  const environment = options.environment ?? process.env;
  const projectPath = (options.projectPath ?? environment.LMS_AIPANEL_SKILL_MANAGER_PATH ?? "").trim();
  const port = options.port ?? parseSkillManagerPort(environment.LMS_AIPANEL_SKILL_MANAGER_PORT);
  const scannedAt = new Date().toISOString();
  const emptySummary = createEmptySummary();
  if (!projectPath) {
    return {
      configured: false,
      available: false,
      projectPath: "",
      cliPath: "",
      scannedAt,
      summary: emptySummary,
      skills: [],
      rootWarnings: [],
      recentSkills: [],
      panel: panelStatus("", port, false),
      error: "未配置技能管理器。请设置 LMS_AIPANEL_SKILL_MANAGER_PATH。"
    };
  }
  const cliPath = options.cliPath ?? path.join(projectPath, "dist", "cli", "index.js");
  const probe = options.probePanel
    ? await options.probePanel(port)
    : options.checkPort
      ? { portOccupied: await options.checkPort(port), identityVerified: false }
      : await probeSkillManagerPanel(port);
  const panel = panelStatus(projectPath, port, probe);

  if (!(await exists(cliPath))) {
    return {
      configured: true,
      available: false,
      projectPath,
      cliPath,
      scannedAt,
      summary: emptySummary,
      skills: [],
      rootWarnings: [],
      recentSkills: [],
      panel,
      error: "技能管理器 CLI 尚未构建。请先在技能项目中运行 npm run build。"
    };
  }

  const runCommand = options.runCommand ?? runNodeCommand;
  let result: CommandResult;
  const scanController = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const abortFromRequest = () => scanController.abort(new Error("技能管理器扫描已取消。"));
  if (options.signal?.aborted) abortFromRequest();
  else options.signal?.addEventListener("abort", abortFromRequest, { once: true });
  let rejectOnAbort: (reason?: unknown) => void = () => undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });
  const abortScan = () => rejectOnAbort(scanController.signal.reason);
  if (scanController.signal.aborted) abortScan();
  else scanController.signal.addEventListener("abort", abortScan, { once: true });
  const timeout = setTimeout(
    () => scanController.abort(new Error(`技能管理器扫描超时（${timeoutMs}ms）。`)),
    timeoutMs
  );
  try {
    result = await Promise.race([
      runCommand(
        process.execPath,
        [cliPath, "scan", "--dry-run", "--json", "--workspace", projectPath],
        { cwd: projectPath, signal: scanController.signal }
      ),
      abortPromise
    ]);
  } catch (error) {
    return {
      configured: true,
      available: false,
      projectPath,
      cliPath,
      scannedAt,
      summary: emptySummary,
      skills: [],
      rootWarnings: [],
      recentSkills: [],
      panel,
      error: `技能管理器扫描失败：${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromRequest);
    scanController.signal.removeEventListener("abort", abortScan);
  }

  if (result.exitCode !== 0 && result.exitCode !== 2) {
    return {
      configured: true,
      available: false,
      projectPath,
      cliPath,
      scannedAt,
      summary: emptySummary,
      skills: [],
      rootWarnings: [],
      recentSkills: [],
      panel,
      error: result.stderr || `技能管理器扫描异常退出，退出码 ${result.exitCode}。`
    };
  }

  try {
    const payload = JSON.parse(result.stdout) as SkillManagerScanPayload;
    const skills = (payload.skills ?? []).map(toSkill).filter((skill): skill is SkillManagerSkill => Boolean(skill));
    const summary = summarizeSkills(skills);
    const recentSkills = [...skills]
      .filter((skill) => Boolean(skill.updatedAt))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
      .slice(0, 10);

    return {
      configured: true,
      available: true,
      projectPath,
      cliPath,
      scannedAt,
      summary,
      skills,
      rootWarnings: (payload.rootWarnings ?? []).map(toIssue).filter((issue): issue is SkillManagerIssue => Boolean(issue)),
      recentSkills,
      panel
    };
  } catch (error) {
    return {
      configured: true,
      available: false,
      projectPath,
      cliPath,
      scannedAt,
      summary: emptySummary,
      skills: [],
      rootWarnings: [],
      recentSkills: [],
      panel,
      error: `技能管理器返回了无效数据：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function panelStatus(projectPath: string, port: number, probe: PanelProbe | false) {
  const status = probe || { portOccupied: false, identityVerified: false };
  return {
    running: status.identityVerified,
    port,
    portOccupied: status.portOccupied,
    identityVerified: status.identityVerified,
    url: null,
    accessMessage: status.identityVerified
      ? "已识别技能管理器。请使用该进程启动时打印的一次性 URL 访问。"
      : status.portOccupied
        ? "端口已被占用，但无法确认服务身份。"
        : "独立面板未监听。",
    readonlyCommand: projectPath
      ? `cd "${projectPath}" && node dist/cli/index.js serve --readonly --port ${port}`
      : ""
  };
}

async function runNodeCommand(
  file: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal }
): Promise<CommandResult> {
  const result = await execa(file, args, {
    cwd: options.cwd,
    reject: false,
    cancelSignal: options.signal
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function probeSkillManagerPanel(port: number): Promise<PanelProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
      signal: AbortSignal.timeout(500)
    });
    const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    return {
      portOccupied: true,
      identityVerified: response.status === 401 && payload?.error?.code === "AUTH_REQUIRED"
    };
  } catch {
    return { portOccupied: false, identityVerified: false };
  }
}

function toSkill(value: unknown): SkillManagerSkill | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const validation = typeof record.validation === "object" && record.validation ? record.validation as Record<string, unknown> : {};
  const name = stringValue(record.name) || stringValue(record.relativeDirName);
  const id = stringValue(record.id);
  const platform = record.platform === "claude" ? "claude" : record.platform === "codex" ? "codex" : null;
  const scope = record.scope === "project" ? "project" : record.scope === "user" ? "user" : null;
  const status = toStatus(record.status);
  const validationState = toValidationState(validation.state);
  if (!id || !name || !platform || !scope || !status || !validationState) return null;

  return {
    id,
    name,
    description: stringValue(record.description),
    platform,
    scope,
    status,
    validationState,
    issues: Array.isArray(validation.issues)
      ? validation.issues.map(toIssue).filter((issue): issue is SkillManagerIssue => Boolean(issue))
      : [],
    skillMdPath: stringValue(record.skillMdPath),
    updatedAt: stringValue(record.skillMdMtime) || null
  };
}

function toIssue(value: unknown): SkillManagerIssue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const code = stringValue(record.code);
  const message = stringValue(record.message);
  if (!code || !message) return null;
  const severity = record.severity === "INFO" || record.severity === "ERROR" || record.severity === "UNKNOWN" ? record.severity : "WARN";
  return {
    severity,
    code,
    message,
    paths: Array.isArray(record.paths) ? record.paths.map(stringValue).filter(Boolean) : undefined
  };
}

function summarizeSkills(skills: SkillManagerSkill[]): SkillManagerSummary {
  const summary = createEmptySummary();
  for (const skill of skills) {
    summary.total += 1;
    summary.byPlatform[skill.platform] += 1;
    summary.byScope[skill.scope] += 1;
    summary.byStatus[skill.status] += 1;
    summary.byValidation[skill.validationState] += 1;
  }
  return summary;
}

function createEmptySummary(): SkillManagerSummary {
  return {
    total: 0,
    byPlatform: { codex: 0, claude: 0 },
    byScope: { user: 0, project: 0 },
    byStatus: {
      enabled: 0,
      disabled: 0,
      readonly: 0,
      manual_restore_candidate: 0,
      conflict_disabled_duplicate: 0
    },
    byValidation: { OK: 0, WARN: 0, ERROR: 0, UNKNOWN: 0 }
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseSkillManagerPort(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_PORT;
}

function toStatus(value: unknown): SkillManagerStatus | null {
  return value === "enabled" ||
    value === "disabled" ||
    value === "readonly" ||
    value === "manual_restore_candidate" ||
    value === "conflict_disabled_duplicate"
    ? value
    : null;
}

function toValidationState(value: unknown): SkillManagerValidationState | null {
  return value === "OK" || value === "WARN" || value === "ERROR" || value === "UNKNOWN" ? value : null;
}
