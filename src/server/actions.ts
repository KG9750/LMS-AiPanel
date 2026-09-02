import { actionPlanRequestSchema, type ActionPlanRequest } from "../shared/schemas";

export function parseActionPlanRequest(value: unknown): ActionPlanRequest {
  return actionPlanRequestSchema.parse(value);
}
