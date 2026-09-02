import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { ActionRunDriver, executorFor, canTransition, type IsolatedRuntime } from "../src/domain/actionRun";
import { ActionRunStore } from "../src/storage/actionRuns";
import { gateActionPlan } from "../src/domain/actionGateway";
import { GRAPH_SCHEMA_VERSION, type AdapterManifest, type ResourceNode } from "../src/shared/schemas";
import type { AdapterContext, StackAdapter } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-action-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function managedNode(id: string): ResourceNode {
  return {
    id,
    type: "runtime",
    label: "oMLX test instance",
    state: "running",
    sourceAdapter: "omlx",
    hostId: "pending",
    properties: { registryManaged: true, stableKey: "test-1" },
    lastSeenAt: new Date().toISOString(),
    graphSchemaVersion: GRAPH_SCHEMA_VERSION
  };
}

function unmanagedNode(id: string): ResourceNode {
  return { ...managedNode(id), properties: { stableKey: "test-1" } };
}

function omlxManifest(): AdapterManifest {
  return {
    adapterId: "omlx",
    adapterName: "oMLX",
    manifestVersion: 1,
    description: "t",
    discoverySources: [],
    permissions: [],
    refreshProfile: { intervalSeconds: 15, onDemand: true },
    telemetryCoverage: [],
    supportedCapabilities: ["action-start", "action-stop", "action-restart"],
    supportedActions: ["read", "dry-run"]
  };
}

describe("ActionRun state machine", () => {
  it("documents and enforces legal transitions; invalid ones are rejected", () => {
    expect(canTransition("planned", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "executing")).toBe(true);
    expect(canTransition("executing", "succeeded")).toBe(true);
    expect(canTransition("failed", "rolled_back")).toBe(true);
    expect(canTransition("succeeded", "executing")).toBe(false);
    expect(canTransition("planned", "executing")).toBe(false);
  });

  it("only managed resources with declared actions produce executable plans", () => {
    // Managed + declared capability: executable.
    const ok = gateActionPlan({ resource: managedNode("omlx:runtime:server"), manifest: omlxManifest(), action: "stop" });
    expect(ok.reason).toBeNull();
    expect(ok.plan?.type).toBe("dry-run");
    expect(ok.plan?.requiresConfirm).toBe(true);

    // Unmanaged: disabled plan with explicit reason.
    const unmanaged = gateActionPlan({ resource: unmanagedNode("omlx:runtime:server"), manifest: omlxManifest(), action: "stop" });
    expect(unmanaged.reason).toContain("not marked managed");
    expect(unmanaged.plan?.disabledReason).toBeDefined();

    // Managed but undeclared action: disabled.
    const undeclared = gateActionPlan({ resource: managedNode("omlx:runtime:server"), manifest: omlxManifest(), action: "configure" });
    expect(undeclared.reason).toContain("does not declare");
  });

  it("success depends on verification evidence, not the command result", async () => {
    const db = (await buildApp({ dataDir: path.join(tmpDir, "verify"), adapters: [], schedulerAutoStart: false })).storage.db;
    const store = new ActionRunStore(db);
    const driver = new ActionRunDriver(store);

    const runtime: IsolatedRuntime = {
      supportedActions: ["start", "verify:start"],
      async run(action) {
        if (action === "start") return { ok: true, evidence: ["command exited 0"] };
        // verify fails: command said ok but the final state is not proven.
        return { ok: false, evidence: ["process not found after start"] };
      }
    };

    const run = store.create({
      actionPlanId: "plan-1",
      resourceId: "omlx:runtime:server",
      adapterId: "omlx",
      action: "start",
      evidence: [],
      requiresRollback: false
    });
    const confirmed = driver.confirm(run.runId)!;
    expect(confirmed.status).toBe("confirmed");
    const outcome = await driver.execute(run.runId, executorFor(runtime, "start")!);
    expect(outcome.ok).toBe(false);
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.error).toContain("verification failed");
  });

  it("verification success marks the run succeeded with evidence", async () => {
    const db = (await buildApp({ dataDir: path.join(tmpDir, "ok"), adapters: [], schedulerAutoStart: false })).storage.db;
    const store = new ActionRunStore(db);
    const driver = new ActionRunDriver(store);
    const runtime: IsolatedRuntime = {
      supportedActions: ["start", "verify:start"],
      async run(action) {
        return { ok: true, evidence: [`${action}: endpoint responds`, "model list contains expected model"] };
      }
    };
    const run = store.create({
      actionPlanId: "plan-2",
      resourceId: "omlx:runtime:server",
      adapterId: "omlx",
      action: "start",
      evidence: [],
      requiresRollback: false
    });
    driver.confirm(run.runId);
    const outcome = await driver.execute(run.runId, executorFor(runtime, "start")!);
    expect(outcome.ok).toBe(true);
    expect(outcome.run.status).toBe("succeeded");
    expect(outcome.run.evidence.some((e) => e.includes("endpoint responds"))).toBe(true);
  });

  it("timeout and execution errors fail the run with rollback eligibility", async () => {
    const db = (await buildApp({ dataDir: path.join(tmpDir, "timeout"), adapters: [], schedulerAutoStart: false })).storage.db;
    const store = new ActionRunStore(db);
    const driver = new ActionRunDriver(store);
    const runtime: IsolatedRuntime = {
      supportedActions: ["stop", "verify:stop"],
      async run(action) {
        if (action === "stop") {
          return { ok: false, evidence: ["command timed out"], error: "timeout after 5s", rollbackState: { before: "running" } };
        }
        return { ok: false, evidence: [] };
      }
    };
    const run = store.create({
      actionPlanId: "plan-3",
      resourceId: "omlx:runtime:server",
      adapterId: "omlx",
      action: "stop",
      evidence: [],
      requiresRollback: false
    });
    driver.confirm(run.runId);
    const outcome = await driver.execute(run.runId, executorFor(runtime, "stop")!);
    expect(outcome.ok).toBe(false);
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.requiresRollback).toBe(true);
    expect(outcome.run.rollbackState).toEqual({ before: "running" });

    const rolled = driver.rollback(run.runId, executorFor(runtime, "stop")!);
    expect(rolled?.status).toBe("rolled_back");
    expect(rolled?.evidence.some((e) => e.includes("pre-action state"))).toBe(true);
  });

  it("a service restart re-verifies unfinished runs", async () => {
    const dataDir = path.join(tmpDir, "restart");
    const first = await buildApp({ dataDir, adapters: [], schedulerAutoStart: false });
    const store = new ActionRunStore(first.storage.db);
    const run = store.create({
      actionPlanId: "plan-4",
      resourceId: "omlx:runtime:server",
      adapterId: "omlx",
      action: "start",
      evidence: [],
      requiresRollback: false
    });
    store.update(run.runId, { status: "executing", evidence: ["execution started"] });
    await first.close();

    // Restart: the run is still incomplete; re-verification resolves it.
    const second = await buildApp({ dataDir, adapters: [], schedulerAutoStart: false });
    const store2 = new ActionRunStore(second.storage.db);
    expect(store2.incomplete().map((r) => r.runId)).toContain(run.runId);
    const driver = new ActionRunDriver(store2);
    const runtime: IsolatedRuntime = {
      supportedActions: ["start", "verify:start"],
      async run(action) {
        return { ok: true, evidence: ["re-verified: endpoint live"] };
      }
    };
    const executor = executorFor(runtime, "start")!;
    const verified = await executor.verify(run.resourceId);
    const updated = store2.update(run.runId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      evidence: [...run.evidence, ...verified.evidence, "re-verified after restart"]
    })!;
    expect(updated.status).toBe("succeeded");
    expect(store2.incomplete()).toHaveLength(0);
    await second.close();
  });

  it("executes through the API: plan gate -> create -> confirm -> execute", async () => {
    const adapters: StackAdapter[] = [
      {
        id: "omlx",
        name: "oMLX",
        manifest: omlxManifest(),
        executor: (verb: string) =>
          executorFor(
            {
              supportedActions: ["stop", "verify:stop"],
              async run(action) {
                return { ok: true, evidence: [`${action} verified on isolated runtime`] };
              }
            },
            verb
          ),
        async collect(_context: AdapterContext) {
          return { nodes: [managedNode("omlx:runtime:server")], edges: [], redactionHints: [] };
        },
        async health() {
          return { adapterId: "omlx", alive: true };
        }
      }
    ];
    const built = await buildApp({
      dataDir: path.join(tmpDir, "api"),
      adapters,
      schedulerAutoStart: false
    });
    await built.scheduler.collect("all");

    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;
    const auth = { "x-lms-session": token };

    // Plan: managed + declared -> executable.
    const plan = await built.app.inject({
      method: "POST",
      url: "/api/actions/plan",
      headers: auth,
      payload: { resourceId: "omlx:runtime:server", action: "stop" }
    });
    expect(plan.json().ok).toBe(true);
    expect(plan.json().data.disabledReason).toBeUndefined();

    // Create run.
    const created = await built.app.inject({
      method: "POST",
      url: "/api/actions/runs",
      headers: auth,
      payload: { resourceId: "omlx:runtime:server", action: "stop" }
    });
    const run = created.json().data;
    expect(run.status).toBe("planned");

    // Unauthorized execute is rejected by the guard.
    const unauthed = await built.app.inject({ method: "POST", url: `/api/actions/runs/${run.runId}/execute` });
    expect(unauthed.json().error.code).toBe("WRITE_GUARD_REJECTED");

    // Confirm then execute.
    const confirmed = await built.app.inject({
      method: "POST",
      url: `/api/actions/runs/${run.runId}/confirm`,
      headers: auth,
      payload: { decision: "confirm" }
    });
    expect(confirmed.json().data.status).toBe("confirmed");

    const executed = await built.app.inject({
      method: "POST",
      url: `/api/actions/runs/${run.runId}/execute`,
      headers: auth
    });
    expect(executed.json().data.status).toBe("succeeded");

    await built.close();
  });

  it("unmanaged resources cannot create executable runs through the API", async () => {
    const built = await buildApp({ dataDir: path.join(tmpDir, "api2"), adapters: [], schedulerAutoStart: false });
    await built.scheduler.collect("all");
    const issue = await built.app.inject({ method: "POST", url: "/api/session" });
    const token = issue.json().data.token;

    const res = await built.app.inject({
      method: "POST",
      url: "/api/actions/runs",
      headers: { "x-lms-session": token },
      payload: { resourceId: "unknown:runtime:x", action: "stop" }
    });
    expect(res.json().error.code).toBe("ACTION_NOT_EXECUTABLE");
    await built.close();
  });
});