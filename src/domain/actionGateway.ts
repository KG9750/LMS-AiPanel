import { nanoid } from "nanoid";
import type { ActionPlan, ResourceNode } from "../shared/schemas";
import type { AdapterManifest } from "../shared/schemas";

const ACTION_TYPE_BY_VERB: Record<string, "read" | "dry-run" | "configure"> = {
  read: "read",
  "dry-run": "dry-run",
  start: "dry-run",
  stop: "dry-run",
  restart: "dry-run",
  "load-model": "dry-run",
  "unload-model": "dry-run",
  configure: "configure",
  backup: "dry-run",
  restore: "dry-run"
};

export function createDisabledControlPlan(resourceId: string, action: string): ActionPlan {
  return {
    actionId: `action:${nanoid()}`,
    resourceId,
    type: "dry-run",
    dryRunCommands: [`# ${action} is intentionally disabled in MVP`],
    affectedResources: [resourceId],
    requiresConfirm: true,
    requiresBackup: false,
    reversible: false,
    riskLevel: "high",
    disabledReason: "Real control actions are deferred until the Action Gateway execution phase."
  };
}

export function createReadPlan(resourceId: string): ActionPlan {
  return {
    actionId: `action:${nanoid()}`,
    resourceId,
    type: "read",
    dryRunCommands: [],
    affectedResources: [resourceId],
    requiresConfirm: false,
    requiresBackup: false,
    reversible: true,
    riskLevel: "low"
  };
}

export interface PlanGateInput {
  resource: ResourceNode | undefined;
  manifest: AdapterManifest | undefined;
  action: string;
}

export interface PlanGateResult {
  plan: ActionPlan | null;
  reason: string | null;
}

/**
 * Action Gateway plan gate (issue #17): only managed resources with a
 * declared adapter action can produce an EXECUTABLE plan. Everything else
 * gets a disabled dry-run plan with an explicit reason.
 */
export function gateActionPlan(input: PlanGateInput): PlanGateResult {
  const { resource, manifest, action } = input;

  if (!resource) {
    return { plan: null, reason: `resource not found: ${action}` };
  }

  const managed = resource.properties.registryManaged === true;
  if (!managed) {
    return {
      plan: createDisabledControlPlan(resource.id, action),
      reason: "resource is not marked managed; only managed resources can execute actions"
    };
  }

  if (!manifest) {
    return {
      plan: createDisabledControlPlan(resource.id, action),
      reason: "adapter manifest missing"
    };
  }

  const declared = manifest.supportedActions ?? [];
  const verb = action.split(":")[0];
  if (!declared.includes(ACTION_TYPE_BY_VERB[verb] ?? ("dry-run" as const)) && !manifest.supportedCapabilities.includes(`action-${verb}` as never)) {
    // Fall through: if the capability is declared the plan is executable.
    if (!manifest.supportedCapabilities.includes(`action-${verb}` as never)) {
      return {
        plan: createDisabledControlPlan(resource.id, action),
        reason: `adapter ${manifest.adapterId} does not declare action '${verb}'`
      };
    }
  }

  return {
    plan: {
      actionId: `action:${nanoid()}`,
      resourceId: resource.id,
      type: ACTION_TYPE_BY_VERB[verb] ?? "dry-run",
      dryRunCommands: [],
      affectedResources: [resource.id],
      requiresConfirm: true,
      requiresBackup: false,
      reversible: true,
      riskLevel: verb === "configure" ? "high" : "medium"
    },
    reason: null
  };
}