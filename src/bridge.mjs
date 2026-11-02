// 洛希桥客户端：连 127.0.0.1 上的 宿主，收 event.*，发 action.*。
import { WebSocket } from 'ws';

const PROTOCOL = 1;
const ACTION_TIMEOUT_MS = 30000;

export class BridgeClient {
  constructor({ url, token, name = 'luoxi-plugin-dsh', version = '0.1.0', log = () => {}, onMessage, onCommand, onOpen, onClose } = {}) {
    this.url = url;
    this.token = token;
    this.name = name;
    this.version = version;
    this.log = log;
    this.onMessage = onMessage ?? (() => {});
    this.onCommand = onCommand ?? (() => {});
    this.onOpen = onOpen ?? (() => {});
    this.onClose = onClose ?? (() => {});
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    this.retry = 1000;
    this.approvalSeq = 0;
    this.approvals = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.url);
      } catch (error) {
        // 地址写错（协议/端口非法）时别把进程抛死：记一条日志继续按退避重试。
        this.log(`[bridge] 地址无效：${error?.message ?? error}`);
        this.#scheduleReconnect();
        resolve(null);
        return;
      }
      this.ws = ws;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: this.token, protocol: PROTOCOL, plugin: { name: this.name, version: this.version } }));
      });
      ws.on('message', (data) => {
        let message;
        try { message = JSON.parse(String(data)); } catch { return; }
        if (message.type === 'hello.ok') {
          this.retry = 1000;
          settled = true;
          this.log(`[bridge] 已连上 ${this.url}（${message.bot?.name ?? 'luoxi-host'}）`);
          this.onOpen(message);
          resolve(message);
          return;
        }
        if (message.type === 'error') {
          this.log(`[bridge] 服务端拒绝：${message.code} ${message.message}`);
          fail(new Error(`${message.code}: ${message.message}`));
          return;
        }
        if (message.type === 'result' && this.pending.has(message.id)) {
          const { resolve: done, reject: failAction, timer } = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(timer);
          if (message.ok === false) failAction(new Error(message.error ?? '动作失败'));
          else done(message);
          return;
        }
        if (message.type === 'approval.decision' && this.approvals.has(message.id)) {
          const done = this.approvals.get(message.id);
          this.approvals.delete(message.id);
          done(message.choice ?? null);
          return;
        }
        if (message.type === 'event.message') { this.onMessage(message); return; }
        if (message.type === 'event.command') { this.onCommand(message); return; }
      });
      ws.once('error', (error) => { this.log(`[bridge] 连接错误：${error?.message ?? error}`); fail(error); });
      ws.once('close', (code) => {
        this.ws = null;
        for (const { reject: rejectAction, timer } of this.pending.values()) { clearTimeout(timer); rejectAction(new Error('连接已断开')); }
        this.pending.clear();
        // 审批请求在断线后不会再有 decision：立刻按拒绝收尾，别让 ACP 干等 120 秒。
        for (const done of this.approvals.values()) { try { done(null); } catch { /* 已处理 */ } }
        this.approvals.clear();
        if (!settled) fail(new Error(`连接关闭 code=${code}`));
        this.onClose(code);
        if (!this.closed) this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    const delay = this.retry;
    this.retry = Math.min(this.retry * 2, 30000);
    this.log(`[bridge] ${Math.round(delay / 1000)}s 后重连`);
    // 不要 unref：ACP 还没起来时这是进程里唯一的活动句柄，unref 会让进程静默退出。
    setTimeout(() => { if (!this.closed) this.connect().catch(() => {}); }, delay);
  }

  action(payload) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('桥未连接'));
    const id = `a${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('动作超时')); }, ACTION_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  requestApproval({ chatKey, title, detail, options, timeoutMs = 120000 }) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve(null);
    const id = `ap${++this.approvalSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.approvals.delete(id); resolve(null); }, timeoutMs);
      this.approvals.set(id, (choice) => { clearTimeout(timer); resolve(choice); });
      this.ws.send(JSON.stringify({ type: 'approval.request', id, chatKey, title, detail, options }));
    });
  }

  sendText(chatKey, text) {
    return this.action({ type: 'action.send', chatKey, text });
  }

  reportTool(chatKey, sessionId, payload = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve();
    try {
      this.ws.send(JSON.stringify({ type: 'tool.report', chatKey, sessionId, ...payload }));
    } catch { /* 连接刚断，丢掉这条 */ }
    return Promise.resolve();
  }

  reportUsage(chatKey, sessionId, { inputTokens = 0, outputTokens = 0, contextUsed = 0, contextSize = 0 } = {}) {
    // 协议里 usage.report 是单向通知（宿主不回 result），不能走 action() 等回执——
    // 否则每次用量更新都会挂一个 30 秒超时定时器。
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve();
    try {
      this.ws.send(JSON.stringify({ type: 'usage.report', chatKey, sessionId, inputTokens, outputTokens, contextUsed, contextSize }));
    } catch { /* 连接刚断，丢掉这一条即可 */ }
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* 已关闭 */ }
    this.ws = null;
  }
}
