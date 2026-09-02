import { nanoid } from "nanoid";
import type { ActionPlan, ActionPlanRequest } from "../shared/schemas";

export function createDisabledControlPlan(
  resourceId: string,
  action: Exclude<ActionPlanRequest["action"], "read">
): ActionPlan {
  return {
    actionId: `action:${nanoid()}`,
    resourceId,
    type: action,
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
