import type { StackAdapter } from "./types";
import { ClaudeConfigAdapter } from "./claudeConfigAdapter";
import { CodexConfigAdapter } from "./codexConfigAdapter";
import { DockerAdapter } from "./dockerAdapter";
import { LaunchAgentAdapter } from "./launchAgentAdapter";
import { LocalModelsAdapter } from "./localModelsAdapter";
import { McpAdapter } from "./mcpAdapter";
import { OpenWebUIAdapter } from "./openWebUIAdapter";
import { SkillsAdapter } from "./skillsAdapter";
import { createAdapterCatalog } from "./catalog";

export function createAdapters(): StackAdapter[] {
  const catalog = createAdapterCatalog();
  return [
    new ClaudeConfigAdapter(),
    new CodexConfigAdapter(),
    new DockerAdapter(),
    new OpenWebUIAdapter(),
    new LaunchAgentAdapter(),
    new LocalModelsAdapter(catalog.modelRoots),
    new SkillsAdapter(catalog.skillRoots),
    new McpAdapter(catalog.mcpConfigCandidates)
  ];
}
