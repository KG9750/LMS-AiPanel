import type { StackAdapter } from "./types";
import { ClaudeConfigAdapter } from "./claudeConfigAdapter";
import { CodexConfigAdapter } from "./codexConfigAdapter";
import { DockerAdapter } from "./dockerAdapter";
import { LaunchAgentAdapter } from "./launchAgentAdapter";
import { LocalModelsAdapter } from "./localModelsAdapter";
import { McpAdapter } from "./mcpAdapter";
import { OmlxAdapter } from "./omlxAdapter";
import { OpenWebUIAdapter } from "./openWebUIAdapter";
import { SkillsAdapter } from "./skillsAdapter";

export function createAdapters(): StackAdapter[] {
  return [
    new ClaudeConfigAdapter(),
    new CodexConfigAdapter(),
    new DockerAdapter(),
    new OpenWebUIAdapter(),
    new LaunchAgentAdapter(),
    new LocalModelsAdapter(),
    new SkillsAdapter(),
    new McpAdapter(),
    new OmlxAdapter()
  ];
}