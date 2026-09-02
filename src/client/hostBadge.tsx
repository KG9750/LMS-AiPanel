import type { HostRecord } from "../shared/schemas";

export interface HostInfo {
  host: HostRecord;
  scope: "local";
  storageRoot: string;
}

/**
 * Shows the persisted local Host identity and scope. The hostId is the stable
 * key; the hostname is display-only and never used as a resource key.
 */
export function HostBadge({ info }: { info: HostInfo | undefined }) {
  if (!info) {
    return (
      <span className="host-badge" title="等待主机信息...">
        本机 · 加载中
      </span>
    );
  }

  const { host, storageRoot } = info;
  const title = [
    `hostId=${host.hostId}`,
    `创建于 ${host.createdAt}`,
    `最后活动 ${host.lastSeenAt}`,
    `数据目录 ${storageRoot}`
  ].join("\n");

  return (
    <span className="host-badge" title={title}>
      <span className="host-badge-dot" />
      本机 · {host.hostName}
      <code className="host-badge-scope">{host.scope}</code>
    </span>
  );
}