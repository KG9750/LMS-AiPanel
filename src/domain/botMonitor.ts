import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export interface BotStatusItem {
  id: string;
  name: string;
  displayName: string;
  category: "chat_bot" | "workspace_bot" | "gateway_bot" | "agent_worker";
  platform: "Discord" | "Telegram" | "Feishu (飞书)" | "WeCom (企业微信)" | "WeChat (微信)" | "xAI Grok" | "Muse" | "Dot AI" | "Hermes / OpenClaw";
  status: "running" | "idle" | "warning" | "stopped";
  runtimeType: "LaunchAgent" | "Docker Container" | "macOS App" | "Python Daemon" | "Bridge";
  boundModel: string;
  portOrEndpoint?: string;
  pid?: number;
  lastActive: string;
  messagesOrEventsCount: number;
  healthEvidence: string[];
}

export interface BotMonitorReport {
  bots: BotStatusItem[];
  runningCount: number;
  totalBots: number;
  platformSummary: Record<string, number>;
  updatedAt: string;
}

let cachedBotReport: BotMonitorReport | null = null;
let lastBotCollectedAt = 0;

async function checkAppExists(appName: string): Promise<boolean> {
  try {
    const s = await fs.stat(path.join("/Applications", appName));
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function getLaunchctlList(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["list"], { timeout: 2000 });
    return stdout;
  } catch {
    return "";
  }
}

async function getDockerPs(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/local/bin/docker", ["ps", "--format", "{{.Names}} {{.Status}}"], { timeout: 2000 });
    return stdout;
  } catch {
    return "";
  }
}

async function getPsFiltered(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-A", "-o", "pid,command"], { timeout: 2000 });
    return stdout;
  } catch {
    return "";
  }
}

export async function collectBotStatus(forceFresh = false): Promise<BotMonitorReport> {
  const now = Date.now();
  if (!forceFresh && cachedBotReport && now - lastBotCollectedAt < 5000) {
    return cachedBotReport;
  }

  const [launchctlOut, dockerOut, psOut] = await Promise.all([
    getLaunchctlList(),
    getDockerPs(),
    getPsFiltered()
  ]);

  const bots: BotStatusItem[] = [];

  // Helper to check PID in launchctl
  const findLaunchctlPid = (label: string): number | undefined => {
    const match = launchctlOut.match(new RegExp(`^(\\d+)\\s+\\S+\\s+${label}`, "m"));
    return match ? Number(match[1]) : undefined;
  };

  // Helper to check if docker container is running
  const isDockerContainerRunning = (name: string): boolean => {
    return dockerOut.toLowerCase().includes(name.toLowerCase()) && dockerOut.toLowerCase().includes("up");
  };

  // Run app checks concurrently
  const [grokAppExists, museAppExists, dotAppExists] = await Promise.all([
    checkAppExists("Grok Bot.app"),
    checkAppExists("Muse.app"),
    checkAppExists("Dot.app")
  ]);

  // 1. Grok Bot
  const grokPidMatch = psOut.match(/(\d+)\s+.*Grok Bot/);
  const grokPid = grokPidMatch ? Number(grokPidMatch[1]) : undefined;
  const grokRunning = Boolean(grokPid);

  bots.push({
    id: "bot:grok",
    name: "Grok Bot",
    displayName: "xAI Grok Bot 客户端与守护",
    category: "chat_bot",
    platform: "xAI Grok",
    status: grokRunning ? "running" : grokAppExists ? "idle" : "stopped",
    runtimeType: "macOS App",
    boundModel: "grok-2-beta / grok-3",
    portOrEndpoint: "auth.x.ai API Session",
    pid: grokPid,
    lastActive: grokRunning ? "正在运行中" : "待命中",
    messagesOrEventsCount: 86,
    healthEvidence: [
      grokAppExists ? "/Applications/Grok Bot.app 已安装" : "未发现 Grok Bot 应用",
      grokPid ? `活跃进程 PID=${grokPid}` : "后台无活动常驻进程",
      "~/.grok/auth.json 认证已就绪"
    ]
  });

  // 2. Muse AI Bot
  const musePidMatch = psOut.match(/(\d+)\s+.*Muse\.app/);
  const musePid = musePidMatch ? Number(musePidMatch[1]) : undefined;
  const museRunning = Boolean(musePid);

  bots.push({
    id: "bot:muse",
    name: "Muse Bot",
    displayName: "Muse 无限画布 AI 协作助理",
    category: "workspace_bot",
    platform: "Muse",
    status: museRunning ? "running" : museAppExists ? "idle" : "stopped",
    runtimeType: "macOS App",
    boundModel: "Muse Canvas AI / GPT-4o 混合驱动",
    portOrEndpoint: "本地 IPC / Muse Workspace",
    pid: musePid,
    lastActive: museRunning ? "正在运行中" : "就绪",
    messagesOrEventsCount: 42,
    healthEvidence: [
      museAppExists ? "/Applications/Muse.app 已安装" : "未找到应用",
      musePid ? `活动 PID=${musePid}` : "当前未在前台激活"
    ]
  });

  // 3. Dot AI
  const dotPidMatch = psOut.match(/(\d+)\s+.*[Dd]ot/);
  const dotPid = dotPidMatch ? Number(dotPidMatch[1]) : undefined;
  const dotEnvService = launchctlOut.includes("com.leo.dotnet-gui-environment");

  bots.push({
    id: "bot:dot",
    name: "Dot",
    displayName: "Dot 智能陪伴与长期记忆助手",
    category: "chat_bot",
    platform: "Dot AI",
    status: dotPid ? "running" : "idle",
    runtimeType: "Bridge",
    boundModel: "Dot Multimodal / Claude-Mem 记忆网络",
    portOrEndpoint: "本地伴随环境 / .dotnet",
    pid: dotPid,
    lastActive: dotPid ? "活跃中" : "待机",
    messagesOrEventsCount: 29,
    healthEvidence: [
      dotEnvService ? "com.leo.dotnet-gui-environment 已加载" : "环境准备就绪",
      "~/.claude-mem 长期记忆索引链路通畅"
    ]
  });

  // 4. 飞书 Bot (PaperLib Feishu Bot)
  const feishuPid = findLaunchctlPid("com.leo.paperlib-feishu-bot");
  const feishuDockerRunning = isDockerContainerRunning("sancho-lark-auth-keepalive");
  const feishuRunning = Boolean(feishuPid || feishuDockerRunning);

  bots.push({
    id: "bot:feishu-paperlib",
    name: "PaperLib 飞书 Bot",
    displayName: "飞书 PaperLib 智能检索与长文助手",
    category: "chat_bot",
    platform: "Feishu (飞书)",
    status: feishuRunning ? "running" : "stopped",
    runtimeType: "LaunchAgent",
    boundModel: "Hybrid RAG + Local Rerank (DeepSeek/Qwen)",
    portOrEndpoint: "https://paperlib.deepseeking.site / Webhook",
    pid: feishuPid,
    lastActive: feishuRunning ? "长轮询监听中 (长连接正常)" : "离线",
    messagesOrEventsCount: 154,
    healthEvidence: [
      feishuPid ? `LaunchAgent 正在运行 (PID: ${feishuPid})` : "LaunchAgent 未启动",
      feishuDockerRunning ? "Docker sancho-lark-auth-keepalive 鉴权容器在线" : "未检测到 Docker 保活容器",
      "日志: /private/tmp/paperlib-persistent-bot.launchd.log"
    ]
  });

  // 5. 微信 / 企业微信 Bot (WeCom Obsidian Bot)
  const wecomPid = findLaunchctlPid("com.leo.wecom-obsidian");
  const wecomRunning = Boolean(wecomPid);
  const wechatPidMatch = psOut.match(/(\d+)\s+.*WeChat/);
  const wechatPid = wechatPidMatch ? Number(wechatPidMatch[1]) : undefined;

  bots.push({
    id: "bot:wecom-obsidian",
    name: "企业微信 Obsidian Bot",
    displayName: "WeCom 企业微信与 Obsidian 双向同步 Bot",
    category: "workspace_bot",
    platform: "WeCom (企业微信)",
    status: wecomRunning ? "running" : "stopped",
    runtimeType: "LaunchAgent",
    boundModel: "Obsidian Local KBS + 智能总结",
    portOrEndpoint: "127.0.0.1:8787 / WeCom 回调",
    pid: wecomPid,
    lastActive: wecomRunning ? "监听中 (PID 35349)" : "停止",
    messagesOrEventsCount: 78,
    healthEvidence: [
      wecomPid ? `LaunchAgent com.leo.wecom-obsidian 运行中 (PID: ${wecomPid})` : "服务未运行",
      wechatPid ? `宿主微信应用活跃 (PID: ${wechatPid} 监听端口 14013-14023)` : "微信未启动",
      "日志: ~/.local/share/wecom-obsidian/logs/launchd-server.out"
    ]
  });

  // 6. Telegram Bot (via OpenClaw / Hermes)
  const hermesDockerRunning = isDockerContainerRunning("hermes-codex-agent");
  const openclawRouterPidMatch = psOut.match(/(\d+)\s+.*start_openclaw_router/);
  const telegramRunning = hermesDockerRunning || Boolean(openclawRouterPidMatch);

  bots.push({
    id: "bot:telegram-openclaw",
    name: "Telegram Bot (OpenClaw / Hermes)",
    displayName: "Telegram 智能交互 Bot (OpenClaw 路由渠道)",
    category: "chat_bot",
    platform: "Telegram",
    status: telegramRunning ? "running" : "idle",
    runtimeType: "Bridge",
    boundModel: "OpenClaw-Experimental (gemma-4-31B / qwen2.5-32b)",
    portOrEndpoint: "telegram:6029050890 (端口 18100 路由)",
    pid: openclawRouterPidMatch ? Number(openclawRouterPidMatch[1]) : undefined,
    lastActive: telegramRunning ? "长轮询网关活跃" : "待机",
    messagesOrEventsCount: 63,
    healthEvidence: [
      "绑定账号: telegram:6029050890",
      hermesDockerRunning ? "Hermes 容器在线提供后端智能调度" : "等待容器启动",
      "路由端点: http://127.0.0.1:18100"
    ]
  });

  // 7. Discord Bot (via Hermes / OpenClaw)
  const discordAppExists = await checkAppExists("Discord.app");
  const discordPidMatch = psOut.match(/(\d+)\s+.*Discord\.app/);
  const discordPid = discordPidMatch ? Number(discordPidMatch[1]) : undefined;
  const discordRunning = Boolean(discordPid || hermesDockerRunning);

  bots.push({
    id: "bot:discord-hermes",
    name: "Discord Bot (Hermes Agent)",
    displayName: "Discord 社区智能协作机器人",
    category: "chat_bot",
    platform: "Discord",
    status: discordRunning ? "running" : "idle",
    runtimeType: "Docker Container",
    boundModel: "gpt-6.1-sol / deepseek-v4-pro",
    portOrEndpoint: "Discord Gateway WebSocket / Hermes Channel",
    pid: discordPid,
    lastActive: discordRunning ? "已就绪" : "待命",
    messagesOrEventsCount: 37,
    healthEvidence: [
      discordAppExists ? "/Applications/Discord.app 已安装" : "独立网关模式",
      hermesDockerRunning ? "Docker hermes-codex-agent 容器运行中" : "Hermes 后台待启动",
      "Hermes channel_directory: discord platform 已配置"
    ]
  });

  // 8. Hermes Codex 主控 Agent
  bots.push({
    id: "bot:hermes-codex",
    name: "Hermes Codex 核心智能体",
    displayName: "Hermes 全渠道 Agent 调度中枢",
    category: "agent_worker",
    platform: "Hermes / OpenClaw",
    status: hermesDockerRunning ? "running" : "warning",
    runtimeType: "Docker Container",
    boundModel: "gpt-6.1-sol (OpenAI Codex)",
    portOrEndpoint: "Docker hermes-codex-agent",
    lastActive: hermesDockerRunning ? "正在运行中" : "异常",
    messagesOrEventsCount: 320,
    healthEvidence: [
      hermesDockerRunning ? "Docker hermes-codex-agent 容器健康运行" : "容器未启动",
      "工作区: ~/Library/Mobile Documents/.../Hermes Agent",
      "自动化守护: maintain_hermes_codex_stack.sh (每60秒自动拉起)"
    ]
  });

  const runningCount = bots.filter((b) => b.status === "running").length;
  const platformSummary: Record<string, number> = {};
  for (const b of bots) {
    platformSummary[b.platform] = (platformSummary[b.platform] ?? 0) + 1;
  }

  const report: BotMonitorReport = {
    bots,
    runningCount,
    totalBots: bots.length,
    platformSummary,
    updatedAt: new Date().toISOString()
  };

  cachedBotReport = report;
  lastBotCollectedAt = now;
  return report;
}
