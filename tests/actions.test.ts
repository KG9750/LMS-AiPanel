import { describe, expect, it } from "vitest";
import { parseActionPlanRequest } from "../src/server/actions";
import { createDisabledControlPlan } from "../src/domain/actionGateway";

describe("action plan request", () => {
  it("accepts the three MVP action types", () => {
    for (const action of ["read", "dry-run", "configure"] as const) {
      expect(parseActionPlanRequest({ resourceId: "codex:tool:desktop", action })).toEqual({
        resourceId: "codex:tool:desktop",
        action
      });
    }
  });

  it("rejects missing, unsupported, and extra fields", () => {
    expect(() => parseActionPlanRequest({ action: "read" })).toThrow();
    expect(() => parseActionPlanRequest({ resourceId: "x", action: "restart" })).toThrow();
    expect(() => parseActionPlanRequest({ resourceId: "x", action: "read", command: "rm" })).toThrow();
  });

  it("keeps configure plans typed as configure while execution stays disabled", () => {
    const plan = createDisabledControlPlan("codex:config:user", "configure");
    expect(plan.type).toBe("configure");
    expect(plan.disabledReason).toBeTruthy();
  });
});
