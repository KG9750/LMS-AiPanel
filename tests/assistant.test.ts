import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantAdapter } from "../src/adapters/assistantAdapter";
import type { AdapterContext } from "../src/adapters/types";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lms-assistant-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const CTX: AdapterContext = { now: () => new Date(), timeoutMs: 1_000 };

async function write(dir: string, file: string, content: string): Promise<void> {
  await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
  await fs.writeFile(path.join(tmpDir, dir, file), content, "utf8");
}

describe("Assistant adapter", () => {
  it("separates definitions, instances, channels, and model routes", async () => {
    // Definition with a LaunchAgent, a channel, and a model route.
    await fs.mkdir(path.join(tmpDir, "Library", "LaunchAgents"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "Library", "LaunchAgents", "com.openclaw.hermes.plist"),
      `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.openclaw.hermes</string><key>ProgramArguments</key><array><string>/usr/local/bin/hermes</string></array></dict></plist>`,
      "utf8"
    );
    await write(path.join(".openclaw", "agents", "hermes"), "agent.json", JSON.stringify({ model: "qwen2.5-32b" }));
    await write(
      path.join(".openclaw", "agents", "hermes"),
      "channels.json",
      JSON.stringify({ channels: [{ id: "telegram-main", type: "telegram", endpoint: "http://127.0.0.1:1" }] })
    );

    const adapter = new AssistantAdapter();
    const result = await adapter.collect(CTX);

    // Definition node.
    const definition = result.nodes.find((n) => n.id === "assistant:assistant:hermes")!;
    expect(definition).toBeDefined();
    expect(definition.state).toBe("warning"); // stopped instance + unreachable channel

    // Instance (LaunchAgent; launchctl absent -> loaded=false, stopped).
    const instance = result.nodes.find((n) => n.id.startsWith("assistant:process:hermes@"))!;
    expect(instance.state).toBe("stopped");
    expect((instance.properties.evidence as string[]).some((e: string) => e.includes("instance state is distinct"))).toBe(true);

    // Channel: distinct unreachable state, secrets excluded.
    const channel = result.nodes.find((n) => n.id === "assistant:channel:telegram-main")!;
    expect(channel.state).toBe("stopped");
    expect(channel.properties.failureState).toBe("channel-unreachable");
    expect(channel.properties.endpointReachable).toBe(false);
    // No secret VALUES or message content enter normalized resources.
    const props = JSON.stringify(channel.properties);
    expect(props).not.toMatch(/"token"|"secret"|"password"|"message"|"content"|api[_-]?key/i);
    expect(props).not.toMatch(/Bearer [A-Za-z0-9]+|sk-[A-Za-z0-9]+/);

    // Model route.
    const route = result.nodes.find((n) => n.id === "assistant:model:route:qwen2.5-32b")!;
    expect(route).toBeDefined();

    // Aggregate status without hiding component evidence.
    expect(definition.properties.aggregateStatus).toBe("partial-failure");
    expect(definition.properties.instanceStates).toEqual(["stopped"]);
    expect(definition.properties.channelStates).toEqual([false]);
  });

  it("a definition can relate to multiple instances", async () => {
    await fs.mkdir(path.join(tmpDir, "Library", "LaunchAgents"), { recursive: true });
    for (const label of ["com.openclaw.hermes", "com.openclaw.hermes-worker"]) {
      await fs.writeFile(
        path.join(tmpDir, "Library", "LaunchAgents", `${label}.plist`),
        `<?xml version="1.0"?><plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>x</string></array></dict></plist>`,
        "utf8"
      );
    }
    await write(path.join(".openclaw", "agents", "hermes"), "agent.json", JSON.stringify({ model: "m1" }));

    const result = await new AssistantAdapter().collect(CTX);
    const instances = result.nodes.filter((n) => n.id.startsWith("assistant:process:hermes@"));
    expect(instances.length).toBe(2);
  });

  it("partial failure: one instance down, one healthy — states stay distinct", async () => {
    await fs.mkdir(path.join(tmpDir, "Library", "LaunchAgents"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "Library", "LaunchAgents", "com.openclaw.hermes.plist"),
      `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.openclaw.hermes</string></dict></plist>`,
      "utf8"
    );
    await write(path.join(".openclaw", "agents", "hermes"), "agent.json", JSON.stringify({ model: "m1" }));
    await write(
      path.join(".openclaw", "agents", "hermes"),
      "channels.json",
      JSON.stringify({ channels: [{ id: "web", type: "web", endpoint: "http://127.0.0.1:9" }] })
    );

    const result = await new AssistantAdapter().collect(CTX);
    const definition = result.nodes.find((n) => n.id === "assistant:assistant:hermes")!;
    expect(definition.properties.instanceStates).toContain("stopped");
    // Instance stopped and channel unreachable are separately reported.
    const instance = result.nodes.find((n) => n.id.startsWith("assistant:process:hermes@"))!;
    expect(instance.state).toBe("stopped");
    const channel = result.nodes.find((n) => n.id === "assistant:channel:web")!;
    expect(channel.properties.failureState).toBe("channel-unreachable");
  });
});
describe("Assistant model route drift (M4)", () => {
  it("detects drift when the endpoint serves a different model", async () => {
    const http = await import("node:http");
    // Fake endpoint serving a DIFFERENT model than configured.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "other-model-9b" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    await fs.mkdir(path.join(tmpDir, "Library", "LaunchAgents"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "Library", "LaunchAgents", "com.openclaw.hermes.plist"),
      `<?xml version="1.0"?><plist><dict><key>Label</key><string>com.openclaw.hermes</string></dict></plist>`,
      "utf8"
    );
    await write(
      path.join(".openclaw", "agents", "hermes"),
      "agent.json",
      JSON.stringify({ model: "qwen2.5-32b", endpoint: `http://127.0.0.1:${port}` })
    );

    const result = await new AssistantAdapter().collect(CTX);
    server.close();

    const route = result.nodes.find((n) => n.id === "assistant:model:route:qwen2.5-32b")!;
    expect(route.state).toBe("warning");
    expect((route.properties.evidence as string[]).some((e) => e.includes("route drift"))).toBe(true);

    // The definition aggregates the drift without hiding component evidence.
    const definition = result.nodes.find((n) => n.id === "assistant:assistant:hermes")!;
    expect(definition.properties.routeDrift).toBe(true);
  });

  it("does not claim drift when the endpoint is unreachable", async () => {
    await write(path.join(".openclaw", "agents", "hermes"), "agent.json", JSON.stringify({ model: "m1", endpoint: "http://127.0.0.1:1" }));
    const result = await new AssistantAdapter().collect(CTX);
    const route = result.nodes.find((n) => n.id === "assistant:model:route:m1")!;
    expect(route.state).toBe("ok");
    expect((route.properties.evidence as string[]).some((e) => e.includes("route drift"))).toBe(false);
  });
});
