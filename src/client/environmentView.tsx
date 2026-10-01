import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SystemEnvironmentReport, ListeningPort } from "../domain/environment";
import { readFetch } from "./api";

export function EnvironmentPanel() {
  const [portFilter, setPortFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["environment"],
    queryFn: () => readFetch<SystemEnvironmentReport>("/api/environment"),
    refetchInterval: 15_000
  });

  if (isLoading) {
    return <div className="screen center">正在采集系统与本地环境数据...</div>;
  }

  if (error || !data) {
    return (
      <div className="panel" style={{ padding: 24 }}>
        <div className="error">获取系统环境失败：{(error as Error)?.message || "未知错误"}</div>
        <button className="top-btn" onClick={() => void refetch()} style={{ marginTop: 12 }}>
          重试
        </button>
      </div>
    );
  }

  const { hardware, os, network, listeningPorts, storage, toolchain, aiRuntimes } = data;

  const totalMemGb = (hardware.totalMemoryBytes / (1024 ** 3)).toFixed(0);
  const usedMemGb = (hardware.usedMemoryBytes / (1024 ** 3)).toFixed(1);
  const freeMemGb = (hardware.freeMemoryBytes / (1024 ** 3)).toFixed(1);

  // Uptime formatting
  const days = Math.floor(hardware.uptimeSeconds / 86400);
  const hours = Math.floor((hardware.uptimeSeconds % 86400) / 3600);
  const uptimeStr = `${days} 天 ${hours} 小时`;

  // Port filtering
  const aiPorts = listeningPorts.filter((p) => p.category === "ai");
  const proxyPorts = listeningPorts.filter((p) => p.category === "proxy");
  const webPorts = listeningPorts.filter((p) => p.category === "web");
  const systemPorts = listeningPorts.filter((p) => p.category === "system");

  const filteredPorts = listeningPorts.filter((p) => {
    if (portFilter !== "all" && p.category !== portFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      String(p.port).includes(q) ||
      p.command.toLowerCase().includes(q) ||
      p.address.toLowerCase().includes(q) ||
      (p.serviceTag && p.serviceTag.toLowerCase().includes(q)) ||
      String(p.pid).includes(q)
    );
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* 4 Top Overview Cards */}
      <section className="stat-cards">
        <div className="stat-card">
          <div className="stat-card-title">
            <span>硬件核心架构</span>
            <span style={{ color: "#38bdf8" }}>APPLE SILICON</span>
          </div>
          <div className="stat-card-main">
            <span className="stat-card-val">{hardware.cpuBrand}</span>
          </div>
          <div className="stat-card-sub">
            <span className="cyan-val">核心: <b>{hardware.cpuCores} 核 CPU</b></span>
            <span>架构: <b>{hardware.arch}</b></span>
            <span>机型: <b>{hardware.model}</b></span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span>统一内存分配 (RAM)</span>
            <span style={{ color: "#34d399" }}>UNIFIED MEMORY</span>
          </div>
          <div className="stat-card-main">
            <span className="stat-card-val">{totalMemGb} GB</span>
            <span className="stat-card-unit">已用 {hardware.memoryUsagePercent}%</span>
          </div>
          <div className="stat-card-sub">
            <span className="cyan-val">已分配: <b>{usedMemGb} GB</b></span>
            <span className="ok-val">空闲: <b>{freeMemGb} GB</b></span>
            <span>电源: <b>{hardware.powerSource}</b></span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span>网络代理与 VPN 状态</span>
            <span style={{ color: network.vpn.active ? "#34d399" : "#94a3b8" }}>
              {network.vpn.active ? "VPN CONNECTED" : "DIRECT"}
            </span>
          </div>
          <div className="stat-card-main">
            <span className="stat-card-val" style={{ fontSize: 22 }}>
              {network.proxy.enabled ? "代理加速在线" : network.vpn.active ? "VPN 隧道激活" : "直连网络"}
            </span>
          </div>
          <div className="stat-card-sub">
            <span className="cyan-val">端口: <b>{network.proxy.httpProxy || "无系统代理"}</b></span>
            <span>TUN: <b>{network.vpn.interfaces.slice(0, 2).join(", ") || "无"}</b></span>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-card-title">
            <span>活跃监听端口矩阵</span>
            <span style={{ color: "#818cf8" }}>TCP PORTS</span>
          </div>
          <div className="stat-card-main">
            <span className="stat-card-val">{listeningPorts.length}</span>
            <span className="stat-card-unit">个本地端口</span>
          </div>
          <div className="stat-card-sub">
            <span className="ok-val">AI 服务: <b>{aiPorts.length}</b></span>
            <span>代理: <b>{proxyPorts.length}</b></span>
            <span className="cyan-val">运行时长: <b>{uptimeStr}</b></span>
          </div>
        </div>
      </section>

      {/* Row 2: Hardware & Storage */}
      <section className="content-grid" style={{ gridTemplateColumns: "1.1fr 1fr" }}>
        {/* Hardware & OS Specs */}
        <div className="panel">
          <div className="panel-head">
            <h2>macOS 系统与底层配置</h2>
            <button className="top-btn" onClick={() => void refetch()} disabled={isFetching}>
              ↻ {isFetching ? "更新中..." : "重新探测"}
            </button>
          </div>
          <div style={{ padding: "16px 20px", display: "grid", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
              <div className="env-info-box">
                <span className="env-info-label">操作系统</span>
                <strong className="env-info-val">{os.productName} {os.productVersion}</strong>
                <small className="env-info-sub">Build {os.buildVersion}</small>
              </div>
              <div className="env-info-box">
                <span className="env-info-label">主机名 (Hostname)</span>
                <strong className="env-info-val">{os.hostname}</strong>
                <small className="env-info-sub">用户: {os.username}</small>
              </div>
              <div className="env-info-box">
                <span className="env-info-label">Darwin 内核</span>
                <strong className="env-info-val">{os.kernelVersion}</strong>
                <small className="env-info-sub">平台: {os.platform}</small>
              </div>
              <div className="env-info-box">
                <span className="env-info-label">系统运行时间 (Uptime)</span>
                <strong className="env-info-val">{uptimeStr}</strong>
                <small className="env-info-sub">开机: {new Date(hardware.bootTime).toLocaleDateString()}</small>
              </div>
            </div>

            {/* RAM Breakdown Bar */}
            <div style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12 }}>
                <span style={{ color: "#94a3b8", fontWeight: 600 }}>统一内存负载分布</span>
                <span style={{ color: "#38bdf8", fontWeight: 700 }}>
                  {usedMemGb} GB / {totalMemGb} GB ({hardware.memoryUsagePercent}%)
                </span>
              </div>
              <div style={{ height: 10, background: "#131d31", borderRadius: 9999, overflow: "hidden", display: "flex" }}>
                <div
                  style={{
                    width: `${hardware.memoryUsagePercent}%`,
                    background: "linear-gradient(90deg, #0284c7 0%, #06b6d4 50%, #10b981 100%)",
                    borderRadius: 9999,
                    transition: "width 0.5s ease"
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: "#64748b" }}>
                <span>空闲可用: {freeMemGb} GB</span>
                <span>Metal GPU 动态共享</span>
              </div>
            </div>
          </div>
        </div>

        {/* Storage & Disk Volumes */}
        <div className="panel">
          <div className="panel-head">
            <h2>存储空间与模型盘挂载</h2>
            <span>{storage.length} 个卷</span>
          </div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            {storage.map((vol, idx) => (
              <div
                key={idx}
                style={{
                  background: vol.category === "model-volume" ? "rgba(6, 182, 212, 0.08)" : "#090e1a",
                  border: vol.category === "model-volume" ? "1px solid rgba(6, 182, 212, 0.4)" : "1px solid #1e2a42",
                  borderRadius: 10,
                  padding: "10px 14px"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>{vol.category === "model-volume" ? "🧠" : "💾"}</span>
                    <strong style={{ color: "#ffffff", fontSize: 13 }}>{vol.mountPoint}</strong>
                    {vol.category === "model-volume" && (
                      <span className="status ok" style={{ fontSize: 10, minWidth: 0, padding: "1px 6px" }}>
                        大模型专属卷
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#38bdf8" }}>{vol.capacity}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8" }}>
                  <span>总容量: {vol.size}</span>
                  <span>已用: {vol.used}</span>
                  <span style={{ color: "#34d399" }}>可用: {vol.avail}</span>
                  <span style={{ color: "#64748b" }}>{vol.filesystem}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Row 3: Network & VPN Matrix */}
      <section className="content-grid" style={{ gridTemplateColumns: "1.1fr 1fr" }}>
        {/* VPN & Proxy Details */}
        <div className="panel">
          <div className="panel-head">
            <h2>VPN 隧道与系统代理配置</h2>
            <span className={network.vpn.active ? "status ok" : "status stopped"}>
              {network.vpn.active ? "代理已启用" : "未开启代理"}
            </span>
          </div>
          <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            {network.vpn.detectedType && (
              <div style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: 8, padding: "10px 14px", color: "#34d399", fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <span>🛡️</span>
                <span><b>检测到活动代理通道：</b>{network.vpn.detectedType}</span>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              <div className="env-info-box">
                <span className="env-info-label">HTTP 代理</span>
                <code style={{ color: "#38bdf8", fontSize: 12 }}>{network.proxy.httpProxy || "未配置"}</code>
              </div>
              <div className="env-info-box">
                <span className="env-info-label">HTTPS 代理</span>
                <code style={{ color: "#38bdf8", fontSize: 12 }}>{network.proxy.httpsProxy || "未配置"}</code>
              </div>
              <div className="env-info-box">
                <span className="env-info-label">SOCKS5 代理</span>
                <code style={{ color: "#a855f7", fontSize: 12 }}>{network.proxy.socksProxy || "未配置"}</code>
              </div>
            </div>

            {/* Exceptions */}
            <div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, fontWeight: 700, textTransform: "uppercase" }}>
                代理绕过规则 (Bypass Exceptions)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {network.proxy.exceptions.map((ex, i) => (
                  <span key={i} style={{ background: "#090e1a", border: "1px solid #1e2a42", borderRadius: 4, padding: "2px 8px", fontSize: 11, color: "#94a3b8" }}>
                    {ex}
                  </span>
                ))}
              </div>
            </div>

            {/* TUN Interfaces */}
            <div>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, fontWeight: 700, textTransform: "uppercase" }}>
                TUN 虚拟专网接口 ({network.vpn.interfaces.length} 个)
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {network.vpn.interfaces.map((iface, i) => (
                  <span key={i} style={{ background: iface === "utun1024" ? "#064e3b" : "#131d31", color: iface === "utun1024" ? "#34d399" : "#cbd5e1", border: "1px solid #1e2a42", borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>
                    {iface}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Network Interfaces */}
        <div className="panel">
          <div className="panel-head">
            <h2>网络适配器与 DNS</h2>
            <span>DNS: {network.dns.slice(0, 2).join(", ") || "系统默认"}</span>
          </div>
          <div style={{ padding: "12px 16px", maxHeight: 340, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
            {network.interfaces
              .filter((item) => item.family === "IPv4")
              .map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "8px 12px",
                    background: item.address.startsWith("192.168.") ? "rgba(56, 189, 248, 0.08)" : "#090e1a",
                    border: item.address.startsWith("192.168.") ? "1px solid rgba(56, 189, 248, 0.3)" : "1px solid #1e2a42",
                    borderRadius: 8,
                    fontSize: 12
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 700, color: "#ffffff" }}>{item.name}</span>
                    <span style={{ fontSize: 10, background: "#1e293b", color: "#94a3b8", padding: "1px 5px", borderRadius: 4 }}>
                      {item.type}
                    </span>
                  </div>
                  <code style={{ color: "#38bdf8", fontWeight: 600 }}>{item.address}</code>
                </div>
              ))}
          </div>
        </div>
      </section>

      {/* Row 4: Active Listening Ports Table */}
      <section className="panel">
        <div className="panel-head">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2>活跃监听端口与本地服务 (TCP Listen Sockets)</h2>
            <span style={{ fontSize: 12, color: "#64748b" }}>
              {filteredPorts.length} / {listeningPorts.length} 个端口
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#94a3b8" }}>分类筛选:</span>
            {[
              { id: "all", label: "全部" },
              { id: "ai", label: `AI 推理 (${aiPorts.length})` },
              { id: "proxy", label: `网络代理 (${proxyPorts.length})` },
              { id: "web", label: `Web 服务 (${webPorts.length})` },
              { id: "system", label: `系统服务 (${systemPorts.length})` }
            ].map((f) => (
              <button
                key={f.id}
                className={`top-btn ${portFilter === f.id ? "active" : ""}`}
                style={{
                  background: portFilter === f.id ? "#0e7490" : undefined,
                  borderColor: portFilter === f.id ? "#38bdf8" : undefined,
                  color: portFilter === f.id ? "#ffffff" : undefined,
                  padding: "2px 10px",
                  minHeight: 28,
                  fontSize: 11
                }}
                onClick={() => setPortFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Port Search Box */}
        <div className="table-panel-header">
          <div className="search-box">
            <span>🔍</span>
            <input
              placeholder="搜索端口号 (如 3777, 8780)、进程名 (如 python, clash)、用途..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                style={{ background: "transparent", border: 0, color: "#94a3b8", cursor: "pointer" }}
                onClick={() => setSearchQuery("")}
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Ports Table */}
        <div className="resource-table">
          <div className="row header" style={{ gridTemplateColumns: "110px 140px 180px 1fr" }}>
            <span>端口号</span>
            <span>绑定地址</span>
            <span>进程与 PID</span>
            <span>服务识别与用途说明</span>
          </div>
          {filteredPorts.length === 0 && <p className="empty">没有匹配的监听端口。</p>}
          {filteredPorts.map((item, idx) => (
            <div
              className="row"
              key={idx}
              style={{ gridTemplateColumns: "110px 140px 180px 1fr", cursor: "default" }}
            >
              <div>
                <span
                  style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 12,
                    fontFamily: "ui-monospace, monospace",
                    background:
                      item.category === "ai"
                        ? "rgba(6, 182, 212, 0.2)"
                        : item.category === "proxy"
                          ? "rgba(168, 85, 247, 0.2)"
                          : item.category === "web"
                            ? "rgba(16, 185, 129, 0.2)"
                            : "#131d31",
                    color:
                      item.category === "ai"
                        ? "#22d3ee"
                        : item.category === "proxy"
                          ? "#c084fc"
                          : item.category === "web"
                            ? "#34d399"
                            : "#94a3b8",
                    border: `1px solid ${
                      item.category === "ai"
                        ? "rgba(6, 182, 212, 0.4)"
                        : item.category === "proxy"
                          ? "rgba(168, 85, 247, 0.4)"
                          : item.category === "web"
                            ? "rgba(16, 185, 129, 0.4)"
                            : "#1e2a42"
                    }`
                  }}
                >
                  :{item.port}
                </span>
              </div>
              <code style={{ color: item.address === "127.0.0.1" ? "#38bdf8" : "#fbbf24", fontSize: 12 }}>
                {item.address}
              </code>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong style={{ color: "#ffffff", fontSize: 12 }}>{item.command}</strong>
                <span style={{ color: "#64748b", fontSize: 11 }}>PID {item.pid}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: item.serviceTag ? "#f8fafc" : "#64748b", fontSize: 12, fontWeight: item.serviceTag ? 600 : 400 }}>
                  {item.serviceTag || "常规后台进程"}
                </span>
                {item.category === "ai" && (
                  <span className="status ok" style={{ fontSize: 9, minWidth: 0, padding: "1px 5px" }}>
                    AI 栈
                  </span>
                )}
                {item.category === "proxy" && (
                  <span className="status warning" style={{ fontSize: 9, minWidth: 0, padding: "1px 5px" }}>
                    网络代理
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Row 5: Toolchain & AI Runtimes */}
      <section className="content-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {/* Toolchain Grid */}
        <div className="panel">
          <div className="panel-head">
            <h2>开发者工具链与环境</h2>
            <span>命令行工具</span>
          </div>
          <div style={{ padding: "14px 16px", display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
            {toolchain.map((tool, idx) => (
              <div key={idx} className="env-info-box">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="env-info-label">{tool.name}</span>
                  <span className={tool.status === "installed" ? "status ok" : "status stopped"} style={{ fontSize: 10, minWidth: 0, padding: "1px 5px" }}>
                    {tool.status === "installed" ? "已安装" : "未发现"}
                  </span>
                </div>
                <strong className="env-info-val" style={{ fontSize: 12, marginTop: 4 }}>
                  {tool.version}
                </strong>
              </div>
            ))}
          </div>
        </div>

        {/* AI Runtimes Status */}
        <div className="panel">
          <div className="panel-head">
            <h2>AI 运行时服务探测</h2>
            <span>本地推理引擎</span>
          </div>
          <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            {aiRuntimes.map((rt, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 14px",
                  background: rt.status === "running" ? "rgba(16, 185, 129, 0.08)" : "#090e1a",
                  border: rt.status === "running" ? "1px solid rgba(16, 185, 129, 0.3)" : "1px solid #1e2a42",
                  borderRadius: 8
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <strong style={{ color: "#ffffff", fontSize: 13 }}>{rt.name}</strong>
                    {rt.port && <code style={{ color: "#38bdf8", fontSize: 11 }}>:{rt.port}</code>}
                  </div>
                  <small style={{ color: "#94a3b8", fontSize: 11 }}>{rt.details}</small>
                </div>
                <span className={rt.status === "running" ? "status ok" : rt.status === "detected" ? "status warning" : "status stopped"}>
                  {rt.status === "running" ? "运行中" : rt.status === "detected" ? "已就绪" : "未启动"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
