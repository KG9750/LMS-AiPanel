// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { HostBadge, type HostInfo } from "../src/client/hostBadge";

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(element);
  return container;
}

const HOST: HostInfo = {
  host: {
    hostId: "host-abc123",
    hostName: "macbook-pro",
    scope: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-02T00:00:00.000Z"
  },
  scope: "local",
  storageRoot: "/tmp/lms-data"
};

describe("HostBadge (browser)", () => {
  it("shows host name and local scope from the persisted host record", () => {
    const container = render(<HostBadge info={HOST} />);
    expect(container.textContent).toContain("本机 · macbook-pro");
    expect(container.textContent).toContain("local");
  });

  it("exposes the stable hostId and storage root in the tooltip", () => {
    const container = render(<HostBadge info={HOST} />);
    const badge = container.querySelector(".host-badge");
    expect(badge?.getAttribute("title")).toContain("hostId=host-abc123");
    expect(badge?.getAttribute("title")).toContain("/tmp/lms-data");
  });

  it("renders a loading state before the host record arrives", () => {
    const container = render(<HostBadge info={undefined} />);
    expect(container.textContent).toContain("本机 · 加载中");
  });
});