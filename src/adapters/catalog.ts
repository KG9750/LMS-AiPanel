import path from "node:path";
import { homePath } from "./helpers";

export interface AdapterCatalog {
  modelRoots: string[];
  skillRoots: string[];
  mcpConfigCandidates: string[];
  omlxDataRoots: string[];
}

export function createAdapterCatalog(environment = process.env): AdapterCatalog {
  return {
    modelRoots: configuredPaths(environment.LMS_AIPANEL_MODEL_ROOTS, [
      homePath("Models"),
      homePath(".cache", "huggingface", "hub"),
      "/Volumes/Leo_LLM/LLM Models"
    ]),
    skillRoots: configuredPaths(environment.LMS_AIPANEL_SKILL_ROOTS, [
      homePath(".codex", "skills"),
      homePath(".claude", "skills"),
      homePath(".agents", "skills")
    ]),
    mcpConfigCandidates: configuredPaths(environment.LMS_AIPANEL_MCP_CONFIGS, [
      homePath(".codex", "config.toml"),
      homePath(".claude", "mcp.json"),
      homePath(".claude.json"),
      homePath("Library", "Application Support", "Claude", "claude_desktop_config.json"),
      homePath(".lmstudio", "mcp.json"),
      homePath(".gemini", "antigravity", "mcp_config.json")
    ]),
    omlxDataRoots: configuredPaths(environment.LMS_AIPANEL_OMLX_DATA_ROOTS, [
      homePath(".local", "share", "omlx"),
      homePath("Library", "Application Support", "oMLX")
    ])
  };
}

function configuredPaths(value: string | undefined, defaults: string[]): string[] {
  if (!value?.trim()) return defaults;
  return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}
