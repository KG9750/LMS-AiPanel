import type { StackAdapter } from "./types";
import { ClaudeConfigAdapter } from "./claudeConfigAdapter";
import { CodexConfigAdapter } from "./codexConfigAdapter";
import { DockerAdapter } from "./dockerAdapter";
import { LaunchAgentAdapter } from "./launchAgentAdapter";
import { LocalModelsAdapter } from "./localModelsAdapter";
import { LocalSkillManagerAdapter } from "./localSkillManagerAdapter";
import { McpAdapter } from "./mcpAdapter";
import { OpenWebUIAdapter } from "./openWebUIAdapter";
import { SkillsAdapter } from "./skillsAdapter";
import { createAdapterCatalog } from "./catalog";
import { OmlxUsageAdapter } from "./omlxUsageAdapter";
import { parseSkillManagerPort } from "../modules/skillManagerModule";

export function createAdapters(environment: NodeJS.ProcessEnv = process.env): StackAdapter[] {
  const catalog = createAdapterCatalog(environment);
  const adapters: StackAdapter[] = [
    new ClaudeConfigAdapter(),
    new CodexConfigAdapter(),
    new DockerAdapter(),
    new OpenWebUIAdapter(),
    new OmlxUsageAdapter(catalog.omlxDataRoots),
    new LaunchAgentAdapter(),
    new LocalModelsAdapter(catalog.modelRoots),
    new SkillsAdapter(catalog.skillRoots),
    new McpAdapter(catalog.mcpConfigCandidates)
  ];
  const skillManagerPath = environment.LMS_AIPANEL_SKILL_MANAGER_PATH?.trim();
  if (skillManagerPath) {
    const port = parseSkillManagerPort(environment.LMS_AIPANEL_SKILL_MANAGER_PORT);
    adapters.splice(-2, 0, new LocalSkillManagerAdapter(skillManagerPath, port));
  }
  return adapters;
}
