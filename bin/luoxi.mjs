#!/usr/bin/env node
// luoxi-plugin-dsh：把 洛希桥过来的任务交给 DeepSeek Harness（ACP），再把回答送回 会话。
// 用法见 README；所有参数也支持环境变量（LUOXI_*）。
import path from 'node:path';
import { AcpClient } from '../src/acp.mjs';
import { BridgeClient } from '../src/bridge.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = '') => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = (flag) => args.includes(flag);

const bridgeUrl = value('--bridge', process.env.LUOXI_BRIDGE_URL ?? 'ws://127.0.0.1:3311');
const token = value('--token', process.env.LUOXI_BRIDGE_TOKEN ?? '');
const workspace = path.resolve(value('--workspace', process.env.LUOXI_WORKSPACE ?? process.cwd()));
const dshBin = value('--dsh', process.env.LUOXI_DSH_BIN ?? '');
const nodePath = value('--node', process.env.LUOXI_NODE ?? process.execPath);
const dshHome = value('--dsh-home', process.env.LUOXI_DSH_HOME ?? '');
const permission = value('--permission', process.env.LUOXI_PERMISSION ?? 'ask');
const checkOnly = has('--check');

const log = (line) => console.log(`[luoxi] ${line}`);

if (!token) {
  console.error('缺少 token：用 --token 或 LUOXI_BRIDGE_TOKEN 指定（在 宿主 的「DeepSeek → 洛希通道」里复制）。');
  process.exit(2);
}
if (!checkOnly && !dshBin) {
  console.error('缺少 dsh 入口：用 --dsh 指向 runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js。');
  process.exit(2);
}

const sessionChat = new Map();
const sessions = new Map();
const queues = new Map();
const buffers = new Map();
let bridgeRef = null;

const acp = new AcpClient({
  node: nodePath,
  bin: dshBin,
  cwd: workspace,
  permission,
  log,
  env: dshHome ? { DSH_HOME: dshHome } : {},
  onExit: () => {
    // DSH 进程退出时它的 session 全部失效；清掉映射，下条消息自动建新会话，
    // 免得用户看到一串 "session not found" 却不知道要发 /dsh new。
    sessions.clear();
    sessionChat.clear();
  },
  onPermission: async (params) => {
    const chatKey = sessionChat.get(params?.sessionId) ?? '';
    const options = (params?.options ?? []).map(option => ({ id: String(option.optionId ?? ''), label: String(option.name ?? option.kind ?? '选项') }));
    if (!chatKey || !bridgeRef) return null;
    const title = params?.toolCall?.title ?? params?.toolCall?.kind ?? '工具调用';
    log(`等待 会话 审批：${title}`);
    const choice = await bridgeRef.requestApproval({ chatKey, title, detail: params?.toolCall?.rawInput ? JSON.stringify(params.toolCall.rawInput).slice(0, 300) : '', options });
    return choice || null;
  },
});

acp.on('session/update', (params) => {
  const update = params?.update;
  if (!update) return;
  const chatKey = sessionChat.get(params.sessionId);
  if (!chatKey || !bridgeRef) return;

  if (update.sessionUpdate === 'usage_update') {
    bridgeRef.reportUsage(chatKey, params.sessionId, { contextUsed: Number(update.used) || 0, contextSize: Number(update.size) || 0 });
    return;
  }
  // 工具调用轨迹：面板里要能实时看到"执行了命令 / 调用了工具"。
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const started = update.sessionUpdate === 'tool_call';
    bridgeRef.reportTool(chatKey, params.sessionId, {
      phase: started ? 'start' : 'end',
      id: String(update.toolCallId ?? ''),
      title: String(update.title ?? ''),
      status: String(update.status ?? ''),
      input: started && update.rawInput ? JSON.stringify(update.rawInput).slice(0, 4000) : '',
      output: !started && update.content ? JSON.stringify(update.content).slice(0, 4000) : '',
    });
  }
});

function enqueue(chatKey, task) {
  const previous = queues.get(chatKey) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(chatKey, next.catch(() => {}));
  return next;
}

async function sessionFor(chatKey, { fresh = false } = {}) {
  if (!fresh && sessions.has(chatKey)) return sessions.get(chatKey);
  const previous = sessions.get(chatKey);
  if (previous) sessionChat.delete(previous); // 换新会话：旧 sessionId 的反向映射一起清掉
  const sessionId = await acp.newSession(workspace);
  sessions.set(chatKey, sessionId);
  sessionChat.set(sessionId, chatKey);
  log(`会话 ${chatKey} → ${sessionId}`);
  return sessionId;
}

const bridge = new BridgeClient({
  url: bridgeUrl,
  token,
  log,
  onOpen: () => { if (checkOnly) { log('连接正常，退出。'); bridge.close(); process.exit(0); } },
  onClose: () => { /* 自动重连 */ },
  onMessage: (event) => {
    const chatKey = event.chat?.key;
    if (!chatKey) return;
    const text = String(event.text ?? '').trim();
    if (!text) return;
    void enqueue(chatKey, async () => {
      buffers.set(chatKey, '');
      try {
        // 桌宠里选了某个旧会话：先恢复它（失败就回退新会话，别让任务断掉）。
        if (event.sessionId && sessions.get(chatKey) !== String(event.sessionId)) {
          try {
            await acp.resumeSession(String(event.sessionId), workspace);
            sessions.set(chatKey, String(event.sessionId));
            sessionChat.set(String(event.sessionId), chatKey);
            log(`会话 ${chatKey} 恢复到 ${event.sessionId}`);
          } catch (error) {
            log(`恢复会话失败：${error?.message ?? error}`);
            await bridge.sendText(chatKey, `恢复那个会话失败：${error?.message ?? error}。这条改用新会话。`).catch(() => {});
          }
        }
        const sessionId = await sessionFor(chatKey, { fresh: event.fresh === true });
        const stop = await acp.prompt(sessionId, text, (chunk) => buffers.set(chatKey, (buffers.get(chatKey) ?? '') + chunk));
        const answer = (buffers.get(chatKey) ?? '').trim();
        // 回送失败只记日志：答案可能已经排队发出，别反过来再补一条"出错了"误导用户。
        await bridge
          .sendText(chatKey, answer || (stop === 'cancelled' ? '任务已取消。' : '（DSH 没有输出文本）'))
          .catch((error) => log(`回送失败：${error?.message ?? error}`));
      } catch (error) {
        log(`任务失败：${error?.message ?? error}`);
        await bridge.sendText(chatKey, `DSH 出错了：${error?.message ?? error}`).catch(() => {});
      } finally {
        buffers.delete(chatKey);
      }
    });
  },
  onCommand: (event) => {
    const chatKey = event.chat?.key;
    if (!chatKey) return;
    if (event.command === 'new') {
      const old = sessions.get(chatKey);
      if (old) sessionChat.delete(old);
      sessions.delete(chatKey);
      log(`会话 ${chatKey} 已重置`);
    } else if (event.command === 'stop') {
      const sessionId = sessions.get(chatKey);
      if (sessionId) acp.cancel(sessionId);
      log(`会话 ${chatKey} 已请求中断`);
    }
  },
});

bridgeRef = bridge;
log(`工作区 ${workspace}`);
// 首次连不上不退出：桥客户端自己按 1s→30s 退避重连，
// 这样"宿主还没起来"或"宿主刚重启"时插件能自己爬起来，不用人工再点一次启动。
bridge.connect().catch((error) => {
  log(`连接 宿主 失败，将自动重试：${error?.message ?? error}`);
});

const shutdown = () => { bridge.close(); acp.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
