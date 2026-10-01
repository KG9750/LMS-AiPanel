import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HardwareInfo {
  model: string;
  cpuBrand: string;
  cpuCores: number;
  arch: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  usedMemoryBytes: number;
  memoryUsagePercent: number;
  powerSource: string;
  uptimeSeconds: number;
  bootTime: string;
}

export interface OsInfo {
  platform: string;
  productName: string;
  productVersion: string;
  buildVersion: string;
  kernelVersion: string;
  hostname: string;
  username: string;
  homeDir: string;
}

export interface NetworkInterfaceItem {
  name: string;
  family: string;
  address: string;
  netmask: string;
  mac: string;
  internal: boolean;
  type: "loopback" | "ethernet" | "wifi" | "vpn" | "virtual" | "other";
}

export interface VpnInfo {
  active: boolean;
  detectedType?: string;
  interfaces: string[];
  details: string[];
}

export interface ProxyInfo {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  socksProxy?: string;
  exceptions: string[];
  envProxies: Record<string, string>;
}

export interface ListeningPort {
  protocol: "tcp";
  port: number;
  address: string;
  pid: number;
  command: string;
  user: string;
  serviceTag?: string;
  category: "ai" | "proxy" | "web" | "system" | "other";
}

export interface StorageVolume {
  filesystem: string;
  mountPoint: string;
  size: string;
  used: string;
  avail: string;
  capacity: string;
  category: "system" | "model-volume" | "external";
}

export interface ToolchainItem {
  name: string;
  version: string;
  status: "installed" | "missing";
}

export interface AiRuntimeStatus {
  name: string;
  status: "running" | "detected" | "stopped";
  details: string;
  port?: number;
}

export interface SystemEnvironmentReport {
  timestamp: string;
  hardware: HardwareInfo;
  os: OsInfo;
  network: {
    interfaces: NetworkInterfaceItem[];
    vpn: VpnInfo;
    proxy: ProxyInfo;
    dns: string[];
  };
  listeningPorts: ListeningPort[];
  storage: StorageVolume[];
  toolchain: ToolchainItem[];
  aiRuntimes: AiRuntimeStatus[];
}

let cachedReport: { report: SystemEnvironmentReport; expiresAt: number } | null = null;

async function safeExec(cmd: string, args: string[], timeoutMs = 2_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs });
    return stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Collects a comprehensive snapshot of macOS hardware, network (VPN/Proxy),
 * listening TCP ports, storage volumes, toolchain, and local AI runtimes.
 */
export async function collectSystemEnvironment(forceFresh = false): Promise<SystemEnvironmentReport> {
  const now = Date.now();
  if (!forceFresh && cachedReport && cachedReport.expiresAt > now) {
    return cachedReport.report;
  }

  // 1. Hardware & OS Probes (in parallel)
  const [
    swVersOut,
    cpuBrandOut,
    hwModelOut,
    pmsetOut,
    scutilProxyOut,
    scutilDnsOut,
    lsofOut,
    dfOut,
    nodeVer,
    pythonVer,
    gitVer,
    dockerVer,
    brewVer,
    ollamaVer
  ] = await Promise.all([
    safeExec("sw_vers", []),
    safeExec("sysctl", ["-n", "machdep.cpu.brand_string"]),
    safeExec("sysctl", ["-n", "hw.model"]),
    safeExec("pmset", ["-g", "batt"]),
    safeExec("scutil", ["--proxy"]),
    safeExec("scutil", ["--dns"]),
    safeExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]),
    safeExec("df", ["-h"]),
    safeExec("node", ["-v"]),
    safeExec("python3", ["--version"]),
    safeExec("git", ["--version"]),
    safeExec("docker", ["--version"]),
    safeExec("brew", ["--version"]),
    safeExec("ollama", ["--version"])
  ]);

  // Parse OS info from sw_vers
  let productName = "macOS";
  let productVersion = os.release();
  let buildVersion = "";
  for (const line of swVersOut.split("\n")) {
    const [k, ...v] = line.split(":");
    const val = v.join(":").trim();
    if (k.includes("ProductName")) productName = val;
    if (k.includes("ProductVersion")) productVersion = val;
    if (k.includes("BuildVersion")) buildVersion = val;
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const uptime = os.uptime();
  const bootTime = new Date(now - uptime * 1000).toISOString();

  let powerSource = "AC Power";
  if (pmsetOut.includes("Battery Power")) {
    powerSource = "Battery";
  } else if (pmsetOut.includes("AC Power")) {
    powerSource = "AC Power";
  }

  const hardware: HardwareInfo = {
    model: hwModelOut || "Mac",
    cpuBrand: cpuBrandOut || os.cpus()[0]?.model || "Apple Silicon",
    cpuCores: os.cpus().length,
    arch: os.arch(),
    totalMemoryBytes: totalMem,
    freeMemoryBytes: freeMem,
    usedMemoryBytes: usedMem,
    memoryUsagePercent: memPercent,
    powerSource,
    uptimeSeconds: uptime,
    bootTime
  };

  const osInfo: OsInfo = {
    platform: os.platform(),
    productName,
    productVersion,
    buildVersion,
    kernelVersion: os.release(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    homeDir: os.homedir()
  };

  // 2. Network Interfaces & VPN detection
  const netInterfaces = os.networkInterfaces();
  const interfaces: NetworkInterfaceItem[] = [];
  const vpnInterfaces: string[] = [];
  const vpnDetails: string[] = [];

  for (const [name, addrs] of Object.entries(netInterfaces)) {
    if (!addrs) continue;
    let type: NetworkInterfaceItem["type"] = "other";
    if (name.startsWith("lo")) type = "loopback";
    else if (name.startsWith("utun") || name.startsWith("ppp") || name.startsWith("ipsec") || name.startsWith("wg") || name.startsWith("tailscale")) {
      type = "vpn";
      vpnInterfaces.push(name);
    } else if (name === "en0" || name === "en1") type = "wifi";
    else if (name.startsWith("en")) type = "ethernet";
    else if (name.startsWith("bridge") || name.startsWith("awdl") || name.startsWith("anpi")) type = "virtual";

    for (const a of addrs) {
      interfaces.push({
        name,
        family: a.family,
        address: a.address,
        netmask: a.netmask,
        mac: a.mac,
        internal: a.internal,
        type
      });

      // Detect VPN IP patterns
      if (a.family === "IPv4") {
        if (a.address.startsWith("198.18.")) {
          vpnDetails.push(`Clash/Surge Fake-IP 虚拟子网 (${name}: ${a.address})`);
        } else if (a.address.startsWith("100.64.") || a.address.startsWith("100.")) {
          vpnDetails.push(`Tailscale / WireGuard 虚拟网段 (${name}: ${a.address})`);
        } else if (type === "vpn") {
          vpnDetails.push(`TUN 虚拟专网通道 (${name}: ${a.address})`);
        }
      }
    }
  }

  // 3. Proxy Parsing from scutil --proxy
  let httpProxy: string | undefined;
  let httpsProxy: string | undefined;
  let socksProxy: string | undefined;
  const exceptions: string[] = [];

  const httpEnabled = /HTTPEnable\s*:\s*1/.test(scutilProxyOut);
  const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(scutilProxyOut);
  const socksEnabled = /SOCKSEnable\s*:\s*1/.test(scutilProxyOut);

  const httpHostMatch = scutilProxyOut.match(/HTTPProxy\s*:\s*([^\s\n]+)/);
  const httpPortMatch = scutilProxyOut.match(/HTTPPort\s*:\s*(\d+)/);
  if (httpEnabled && httpHostMatch && httpPortMatch) {
    httpProxy = `${httpHostMatch[1]}:${httpPortMatch[1]}`;
  }

  const httpsHostMatch = scutilProxyOut.match(/HTTPSProxy\s*:\s*([^\s\n]+)/);
  const httpsPortMatch = scutilProxyOut.match(/HTTPSPort\s*:\s*(\d+)/);
  if (httpsEnabled && httpsHostMatch && httpsPortMatch) {
    httpsProxy = `${httpsHostMatch[1]}:${httpsPortMatch[1]}`;
  }

  const socksHostMatch = scutilProxyOut.match(/SOCKSProxy\s*:\s*([^\s\n]+)/);
  const socksPortMatch = scutilProxyOut.match(/SOCKSPort\s*:\s*(\d+)/);
  if (socksEnabled && socksHostMatch && socksPortMatch) {
    socksProxy = `${socksHostMatch[1]}:${socksPortMatch[1]}`;
  }

  // Exceptions
  const exceptionsBlock = scutilProxyOut.match(/ExceptionsList\s*:\s*<array>\s*\{([^}]+)\}/);
  if (exceptionsBlock) {
    const lines = exceptionsBlock[1].split("\n");
    for (const line of lines) {
      const m = line.match(/\d+\s*:\s*([^\s\n]+)/);
      if (m && m[1]) exceptions.push(m[1]);
    }
  }

  const envProxies: Record<string, string> = {};
  for (const key of ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    if (process.env[key]) {
      envProxies[key] = process.env[key]!;
    }
  }

  const proxyEnabled = httpEnabled || httpsEnabled || socksEnabled || Object.keys(envProxies).length > 0;
  if (proxyEnabled && vpnDetails.length === 0) {
    vpnDetails.push(`系统代理转发已启用 (${httpProxy || httpsProxy || socksProxy || "环境变量配置"})`);
  }

  const vpnInfo: VpnInfo = {
    active: vpnInterfaces.length > 0 || proxyEnabled,
    detectedType: vpnDetails[0] || (vpnInterfaces.length > 0 ? "TUN 虚拟专网 (活跃)" : undefined),
    interfaces: vpnInterfaces,
    details: vpnDetails
  };

  const proxyInfo: ProxyInfo = {
    enabled: proxyEnabled,
    httpProxy,
    httpsProxy,
    socksProxy,
    exceptions,
    envProxies
  };

  // DNS
  const dnsServers: string[] = [];
  const dnsMatches = scutilDnsOut.matchAll(/nameserver\[\d+\]\s*:\s*([^\s\n]+)/g);
  for (const m of dnsMatches) {
    if (m[1] && !dnsServers.includes(m[1])) {
      dnsServers.push(m[1]);
    }
  }

  // 4. Listening Ports (lsof)
  const listeningPorts: ListeningPort[] = [];
  const lines = lsofOut.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0];
    const pid = parseInt(parts[1], 10);
    const user = parts[2];
    const nameCol = parts[parts.length - 2]; // e.g. "127.0.0.1:3777" or "*:8000" or "[::1]:8000"

    const colonIdx = nameCol.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const address = nameCol.substring(0, colonIdx);
    const port = parseInt(nameCol.substring(colonIdx + 1), 10);
    if (isNaN(port) || isNaN(pid)) continue;

    // Deduplicate port & address
    if (listeningPorts.some((p) => p.port === port && p.address === address)) continue;

    let serviceTag: string | undefined;
    let category: ListeningPort["category"] = "other";

    if (port === 3777) {
      serviceTag = "LMS-AiPanel 控制面";
      category = "ai";
    } else if (port === 11434) {
      serviceTag = "Ollama 推理服务";
      category = "ai";
    } else if (port === 8000) {
      serviceTag = "MLX / vLLM 推理端点";
      category = "ai";
    } else if (port === 8080) {
      serviceTag = "llama.cpp / WebUI";
      category = "ai";
    } else if (port === 8501) {
      serviceTag = "Streamlit AI 应用";
      category = "ai";
    } else if (port >= 8780 && port <= 8789) {
      serviceTag = "Python AI 运行时 / oMLX";
      category = "ai";
    } else if (port === 7890 || port === 7897 || port === 55062 || command.toLowerCase().includes("clash")) {
      serviceTag = "Clash / 代理核心";
      category = "proxy";
    } else if (port === 4173 || port === 5173 || port === 3000) {
      serviceTag = "Web 前端服务";
      category = "web";
    } else if (port === 5000 || port === 7000) {
      serviceTag = "macOS 控制中心 / AirPlay";
      category = "system";
    } else if (port === 6767 || port === 62895) {
      serviceTag = "Paseo 本地进程";
      category = "other";
    } else if (command.toLowerCase().includes("python")) {
      serviceTag = "Python 后台服务";
      category = "ai";
    } else if (command.toLowerCase().includes("node")) {
      serviceTag = "Node.js 实例";
      category = "web";
    }

    listeningPorts.push({
      protocol: "tcp",
      port,
      address,
      pid,
      command,
      user,
      serviceTag,
      category
    });
  }

  // Sort ports numerically
  listeningPorts.sort((a, b) => a.port - b.port);

  // 5. Storage & Model Volumes (df -h)
  const storage: StorageVolume[] = [];
  const dfLines = dfOut.split("\n");
  for (let i = 1; i < dfLines.length; i++) {
    const parts = dfLines[i].trim().split(/\s+/);
    if (parts.length < 6) continue;
    const filesystem = parts[0];
    const size = parts[1];
    const used = parts[2];
    const avail = parts[3];
    const capacity = parts[4];
    const mountPoint = parts.slice(8).join(" ") || parts[parts.length - 1];

    if (!mountPoint) continue;

    // Filter relevant mounts: / and /Volumes/*
    if (mountPoint === "/" || mountPoint.startsWith("/Volumes/")) {
      let category: StorageVolume["category"] = "external";
      if (mountPoint === "/") {
        category = "system";
      } else if (
        mountPoint.toLowerCase().includes("llm") ||
        mountPoint.toLowerCase().includes("model") ||
        mountPoint.toLowerCase().includes("ai")
      ) {
        category = "model-volume";
      }

      storage.push({
        filesystem,
        mountPoint,
        size,
        used,
        avail,
        capacity,
        category
      });
    }
  }

  // 6. Toolchain
  const toolchain: ToolchainItem[] = [
    { name: "Node.js", version: nodeVer || "未检测到", status: nodeVer ? "installed" : "missing" },
    { name: "Python 3", version: pythonVer || "未检测到", status: pythonVer ? "installed" : "missing" },
    { name: "Git", version: gitVer || "未检测到", status: gitVer ? "installed" : "missing" },
    { name: "Homebrew", version: brewVer ? brewVer.split("\n")[0] : "未检测到", status: brewVer ? "installed" : "missing" },
    { name: "Docker", version: dockerVer || "未检测到", status: dockerVer ? "installed" : "missing" },
    { name: "Ollama", version: ollamaVer || "未检测到", status: ollamaVer ? "installed" : "missing" }
  ];

  // 7. AI Runtimes status
  const aiRuntimes: AiRuntimeStatus[] = [
    {
      name: "MLX / oMLX",
      status: listeningPorts.some((p) => p.port >= 8780 && p.port <= 8785) ? "running" : "detected",
      details: "Apple Silicon Metal 统一内存原生加速推理",
      port: listeningPorts.find((p) => p.port >= 8780 && p.port <= 8785)?.port
    },
    {
      name: "Ollama",
      status: listeningPorts.some((p) => p.port === 11434) ? "running" : ollamaVer ? "detected" : "stopped",
      details: "本地轻量级模型运行引擎与端点",
      port: 11434
    },
    {
      name: "Docker Runtime",
      status: dockerVer ? "running" : "stopped",
      details: "隔离容器推理与 Open WebUI 承载环境"
    },
    {
      name: "LMS-AiPanel 控制面",
      status: "running",
      details: "本机 127.0.0.1 AI 工作栈控制中心",
      port: 3777
    }
  ];

  const report: SystemEnvironmentReport = {
    timestamp: new Date().toISOString(),
    hardware,
    os: osInfo,
    network: {
      interfaces,
      vpn: vpnInfo,
      proxy: proxyInfo,
      dns: dnsServers
    },
    listeningPorts,
    storage,
    toolchain,
    aiRuntimes
  };

  cachedReport = {
    report,
    expiresAt: now + 5_000 // 5 seconds cache
  };

  return report;
}
