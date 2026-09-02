import type { AdapterResult } from "../shared/schemas";
import type { AdapterContext, HealthStatus, StackAdapter } from "./types";
import { edge, node } from "./helpers";
import { inspectSkillManagerIntegration, type PanelProbe } from "../modules/skillManagerModule";

export class LocalSkillManagerAdapter implements StackAdapter {
  id = "local-skill-manager";
  name = "Local Skill Manager";
  private lastError: string | undefined;

  constructor(
    private readonly projectPath: string,
    private readonly port = 8787,
    private readonly probePanel?: (port: number) => Promise<PanelProbe>
  ) {}

  async collect(context: AdapterContext): Promise<AdapterResult> {
    try {
      const inspection = await inspectSkillManagerIntegration({
        projectPath: this.projectPath,
        port: this.port,
        probePanel: this.probePanel
      });
      const manager = node(this.id, "tool", "local-skill-manager", "Local Skill Manager", "ok", {
        projectPath: inspection.projectPath,
        cliPath: inspection.cliPath,
        panelRunning: inspection.panel.running,
        panelIdentityVerified: inspection.panel.identityVerified,
        evidence: ["Local Skill Manager installation detected; full scan uses the module API"]
      });
      const skillRoot = node(this.id, "config", "skill-manager-project", "Local Skill Manager Project", "ok", {
        path: inspection.projectPath,
        evidence: ["Configured Skills project path"]
      });
      const nodes = [manager, skillRoot];
      const edges = [edge(manager.id, "configured_by", skillRoot.id)];

      if (inspection.panel.portOccupied) {
        const port = node(this.id, "port", `127.0.0.1:${inspection.panel.port}`, `127.0.0.1:${inspection.panel.port}`, inspection.panel.identityVerified ? "running" : "warning", {
          identityVerified: inspection.panel.identityVerified,
          evidence: [inspection.panel.identityVerified ? "Local Skill Manager AUTH_REQUIRED response" : "Port occupied; service identity unverified"]
        });
        nodes.push(port);
        edges.push(edge(manager.id, "exposes", port.id));
      }

      this.lastError = undefined;
      return { nodes, edges, redactionHints: [] };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async health(): Promise<HealthStatus> {
    return { adapterId: this.id, alive: this.lastError === undefined, lastError: this.lastError };
  }
}
