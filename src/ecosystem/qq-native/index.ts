import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { speakerIdentity, conversationKey, type SpeakerIdentity } from '../shared/identity.ts';
import type { ChannelContextMessage } from '../shared/context.ts';
import { createBridge } from './snowluma.ts';
import { createOneBotHttpTransport } from './onebot-http.ts';
import { createQqHome } from './home.ts';
import { createNativeBridge, type BridgeStatus, type NativeBridge } from './native-bridge.ts';

/** The largest single message we accept from QQ; anything longer is cut before it reaches her. */
const MAX_INCOMING = 2_000;
/** How many distinct messages we remember to drop repeats of. */
const SEEN_LIMIT = 500;

/**
 * What we actually read off an incoming message.
 *
 * The transport (`snowluma.ts` / `onebot-http.ts`) hands over its own normalized shape; this is the
 * part of it the module depends on, written out here so the wiring does not lean on a file's types.
 */
export interface QqIncoming {
  kind: 'group' | 'private';
  groupId: string | null;
  userId: string;
  messageId: string;
  selfId: string;
  text: string;
  sender?: { nickname?: string; card?: string | null } | undefined;
  /** 原始段数组（OneBot 的 message）。群里那句是不是在叫她，看的就是它。 */
  segments?: Array<{ type?: string; data?: Record<string, unknown> }> | undefined;
}

export interface QqNativeConfig {
  enabled: boolean;
  /** 走哪条传输：`http` = napcat/OneBot HTTP（和 dsh-qq-bridge 同一条路）；`ws` = 旧 SnowLuma WebSocket。 */
  transport: 'http' | 'ws';
  /** `transport: 'http'` 用这个地址，例如 http://127.0.0.1:3000。 */
  httpUrl: string;
  /** `transport: 'ws'` 用这个地址。 */
  wsUrl: string;
  accessToken: string;
  /** HTTP 轮询间隔（毫秒），qq-bridge 默认 2000。 */
  pollIntervalMs: number;
  /** 谁可以跟她说话：`everyone` = 谁发都收（自动开新会话）；`list` = 只认白名单。 */
  whoCanTalk: 'everyone' | 'list';
  /** 永远不接的 QQ 号 / 群号（两种模式都生效）。 */
  denyPrivate: readonly string[];
  denyGroups: readonly string[];
  /** `whoCanTalk: 'list'` 时才看：白名单。 */
  allowPrivate: readonly string[];
  allowGroups: readonly string[];
  /** 她会不会回。关掉是「收到但不理」——连问都不问，不花调用。 */
  autoReply: boolean;
  /** How many earlier messages of the same conversation are shown to her with each new one. */
  contextMessages: number;
  /** 群里什么时候接话：mention 只接被叫到的（被 @ / 被引用她的消息 / 命中关键词），all 每句都接。 */
  groupTrigger: 'mention' | 'all';
  /** 群里命中这些词也算在叫她。 */
  groupKeywords: readonly string[];
  /** 群里接话的节奏（只对被喊到的以外的闲聊生效；@ 她 / 引用她的话不受限）。 */
  replyCooldownSec: number;
  maxPerMinute: number;
  replyProbability: number;
  /** Who shares her home session: `owner` keeps it for the owner's private chat, `none` gives every
   *  conversation its own, empty follows whatever the bridge's own setting says. */
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 阳台：让这台机器上别的程序能跟家里说话的那条线。`port` 为 0 就整块不开。 */
  bridge: { port: number; token: string; title: string; contextMessages: number };
}

export interface QqNativeStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  transport: 'http' | 'ws';
  whoCanTalk: 'everyone' | 'list';
  allowPrivate: number;
  allowGroups: number;
  autoReply: boolean;
  conversations: number;
  answering: number;
  lastEventAt: string | null;
  lastError: string | null;
  sent: number;
  failed: number;
  /** 阳台那条线现在什么样（没开就是 null）。 */
  bridge: BridgeStatus | null;
  /** 到了通道、但被白名单 / 黑名单挡下的条数。 */
  blocked: number;
  /** 最近一次被挡下的时刻。 */
  lastBlockedAt: string | null;
  bindHomeSession: 'owner' | 'all' | 'none' | '';
  /** 群里接话的规矩。 */
  groupTrigger: 'mention' | 'all';
}

/**
 * QQ as another way into the same home, without a bridge process in between.
 *
 * One OneBot connection in, the same `home` the WeChat channel uses in the middle, and a reply sent
 * back out. There is no separate session store: a conversation's identity key is the whole mapping,
 * so a group keeps talking to the same conversation she already has for it.
 */
/** 传输层交给通道的那几件（真身是 snowluma.js 的 createBridge / onebot-http.js）。 */
export interface QqTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): string;
  sendGroup(groupId: string, text: string): Promise<{ messageId: string }>;
  sendPrivate(userId: string, text: string): Promise<{ messageId: string }>;
}

/** 两种传输都认的几个选项；通道只用到这几个。 */
export interface QqTransportOptions {
  wsUrl: string;
  /** HTTP 传输用的根地址（`transport: 'http'` 时才给）。 */
  baseUrl?: string;
  /** HTTP 轮询间隔（毫秒）。 */
  pollIntervalMs?: number;
  accessToken?: string;
  log(level: string, message: string): void;
  onGroupMessage?(message: unknown): void;
  onPrivateMessage?(message: unknown): void;
  onNotice?(type: string, notice?: unknown): void;
}

export function createQqNativeModule(deps: {
  ctx: Context;
  home(identity: SpeakerIdentity): Promise<Agent>;
  config(): QqNativeConfig;
  /** 面板拨的开关存这儿；不给就只在内存里活到下一次重载。 */
  stateFile?: string;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** 传输层；不给就按配置自己挑（http / ws）。测试靠它把合成事件灌进来。 */
  transport?(options: QqTransportOptions): QqTransport;
}) {
  const home = createQqHome({ ctx: deps.ctx, home: deps.home });
  const seen = new Set<string>();
  const contexts = new Map<string, ChannelContextMessage[]>();
  const answering = new Set<string>();
  // 群聊节奏：每个会话上一次开口的时刻、这一分钟的条数。
  const lastReplyAt = new Map<string, number>();
  const minuteCounts = new Map<string, { minute: number; count: number }>();
  // 她自己的那条线：最后一次见到的账号。
  let lastSelfId = '';
  let client: QqTransport | undefined;
  let nativeBridge: NativeBridge | undefined;
  let stopped = false;
  // 面板要的那几个数自己记：传输层只交出一个 getState()，不带计数。
  const stats: { sent: number; failed: number; blocked: number; lastEventAt: string | null; lastBlockedAt: string | null; lastError: string | null } = {
    sent: 0, failed: 0, blocked: 0, lastEventAt: null, lastBlockedAt: null, lastError: null,
  };

  // 拨过的开关写在 stateFile 里，重载不丢；配置里那个是出厂默认。
  let overrides: { autoReply?: boolean; bridge?: { port?: number } } = {};
  let overridesRead = false;
  function readOverrides(): void {
    if (overridesRead) return;
    overridesRead = true;
    const file = deps.stateFile;
    if (!file) return;
    try { overrides = JSON.parse(readFileSync(file, 'utf8')) as { autoReply?: boolean; bridge?: { port?: number } }; } catch { overrides = {}; }
  }
  function writeOverrides(): void {
    const file = deps.stateFile;
    if (!file) return;
    try { writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n', 'utf8'); } catch (error) { deps.logger.warn('QQ 通道：开关没存下来', error); }
  }
  const settings = (): QqNativeConfig => {
    readOverrides();
    const base = deps.config();
    // 面板上改过端口就以面板为准；其余字段还是配置里那套。
    const bridge = overrides.bridge?.port === undefined ? base.bridge : { ...base.bridge, port: overrides.bridge.port };
    return {
      ...base,
      ...(overrides.autoReply === undefined ? {} : { autoReply: overrides.autoReply }),
      bridge,
    };
  };

  function remember(messageId: string): boolean {
    if (!messageId) return true;
    if (seen.has(messageId)) return false;
    seen.add(messageId);
    if (seen.size > SEEN_LIMIT) { const first = seen.values().next().value; if (first !== undefined) seen.delete(first); }
    return true;
  }

  // 她说出去的消息 id。有人引用她的话，引用的就是这个 id。
  const sentIds = new Set<string>();
  function rememberSent(id: unknown): void {
    const value = id == null ? '' : String(id);
    if (value === '') return;
    sentIds.add(value);
    if (sentIds.size > SEEN_LIMIT) {
      const oldest = sentIds.values().next().value;
      if (oldest !== undefined) sentIds.delete(oldest);
    }
  }

  /**
   * 群里这句是不是在叫她。
   *
   * 量过：不做这个判断时，群里没被叫到的每一句都会让她跑完一整轮、还往群里冒一条——哪怕她自己在话里
   * 写的是「这句不接」，钱和噪声都已经花了。所以只有被 @ 到、有人引用过她的话、或者命中配的关键词，
   * 才把话递到她跟前；其余只记进那个群的上下文，等她真被叫到时知道刚才在说什么。
   */
  function directedAtHer(message: QqIncoming, config: QqNativeConfig): boolean {
    if (config.groupTrigger === 'all') return true;
    for (const segment of message.segments ?? []) {
      const data = segment?.data ?? {};
      if (segment?.type === 'at' && (data.qq === 'all' || String(data.qq ?? '') === message.selfId)) return true;
      if (segment?.type === 'reply' && data.id != null && sentIds.has(String(data.id))) return true;
    }
    return config.groupKeywords.some(word => word !== '' && message.text.includes(word));
  }

  function allowed(identity: SpeakerIdentity): boolean {
    const config = settings();
    const isGroup = identity.conversationType === 'group';
    const id = isGroup ? identity.conversationId : identity.speakerId.slice('qq:'.length);
    // 黑名单永远生效：先拒了再说。
    if (isGroup ? config.denyGroups.includes(id) : config.denyPrivate.includes(id)) return false;
    // everyone = 谁发都收，房间按会话自动开；list = 只认白名单（旧行为）。
    if (config.whoCanTalk === 'everyone') return true;
    return isGroup ? config.allowGroups.includes(id) : config.allowPrivate.includes(id);
  }

  /** 群里闲聊的节奏闸：掷骰子、冷却、每分钟上限。返回 false = 这一句先不开口。 */
  function groupGate(key: string, config: QqNativeConfig): boolean {
    const probability = Math.max(0, Math.min(100, Number(config.replyProbability)));
    if (probability < 100 && Math.random() * 100 >= probability) return false;
    const now = Date.now();
    const cooldown = Math.max(0, Number(config.replyCooldownSec)) * 1_000;
    if (cooldown > 0 && now - (lastReplyAt.get(key) ?? 0) < cooldown) return false;
    const minute = Math.floor(now / 60_000);
    const record = minuteCounts.get(key);
    const count = record && record.minute === minute ? record.count : 0;
    return count < Math.max(1, Number(config.maxPerMinute));
  }

  function noteReply(key: string): void {
    const now = Date.now();
    lastReplyAt.set(key, now);
    const minute = Math.floor(now / 60_000);
    const record = minuteCounts.get(key);
    minuteCounts.set(key, { minute, count: record && record.minute === minute ? record.count + 1 : 1 });
  }

  function pushContext(key: string, message: ChannelContextMessage, limit: number) {
    const list = contexts.get(key) ?? [];
    list.push(message);
    while (list.length > Math.max(1, Math.min(limit, 20))) list.shift();
    contexts.set(key, list);
  }

  async function deliver(message: QqIncoming) {
    if (stopped) return;
    const config = settings();
    if (!config.enabled) return;
    const messageId = message.messageId;
    if (!remember(messageId)) return;
    const selfId = message.selfId;
    const userId = message.userId;
    // Her own words come back through the same socket; answering them would be talking to herself.
    if (!userId || userId === selfId) return;
    const text = message.text.trim().slice(0, MAX_INCOMING);
    if (!text) return;
    const isGroup = message.kind === 'group';
    const conversationId = isGroup ? message.groupId ?? '' : userId;
    if (!conversationId) return;
    stats.lastEventAt = new Date().toISOString();
    // 有人说话了：房间安静了多久她得记得，顺带记住自己这个号是哪个。
    lastSelfId = selfId || lastSelfId;
    // 引擎开没开都得记 —— 不然开关一拨开，它以为「一直没人说过话」。
    const speakerName = message.sender?.card || message.sender?.nickname || '';
    let identity: SpeakerIdentity;
    try {
      identity = speakerIdentity({
        channel: 'qq',
        accountId: selfId || '0',
        speakerId: `qq:${userId}`,
        ...(speakerName ? { speakerName } : {}),
        conversationId,
        conversationType: isGroup ? 'group' : 'private',
        ...(isGroup ? { conversationName: `群 ${conversationId}` } : {}),
        ...(messageId ? { platformMessageId: messageId } : {}),
      });
    } catch (error) { deps.logger.warn('QQ 消息身份不合法:', error); return; }
    // 不在名单里也算「到过」：不然分不清「消息根本没送到」和「送到了但被挡下」——
    // 明天拿手机发一条时，这两件事的区别就是全部的意义。
    if (!allowed(identity)) {
      stats.blocked += 1;
      stats.lastBlockedAt = new Date().toISOString();
      return;
    }
    const key = conversationKey(identity);
    const directed = isGroup ? directedAtHer(message, config) : true;
    // 关掉自动回复的意思就是「别理它」：连问都不问。原来是先问完再决定发不发，
    // 于是开关关着每条还是照样花一轮（今晚拿假服务器实测：两条合成消息各烧了一轮）。
    // 群里没叫她的消息只进上下文，不开口、不花一轮。私聊不受这条管。
    if (isGroup && !directed) {
      pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }
    // 群里闲聊的节奏闸；@ 她 / 引用她的话不排队，冲她来的就回。
    if (isGroup && !directedAtHer(message, { ...config, groupTrigger: 'mention' })) {
      if (!groupGate(key, config)) {
        pushContext(key, { id: messageId || String(Date.now()), occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
        return;
      }
    }

    if (!config.autoReply || stopped) {
      pushContext(key, { id: messageId || `${Date.now()}`, occurredAt: new Date().toISOString(), text, identity }, config.contextMessages);
      return;
    }
    const context = contexts.get(key) ?? [];
    answering.add(key);
    try {
      const answer = await home.ask(text, identity, context);
      // 她那句话记成她自己说的：不然后面拿这段上下文问她「刚才聊到哪了」时，
      // 她说过的会被当成对方说的（home.ts 里按 speakerId 判 role 为 assistant）。
      const herIdentity = speakerIdentity({
        channel: 'qq',
        accountId: identity.accountId,
        speakerId: `qq:${identity.accountId}`,
        conversationId: identity.conversationId,
        conversationType: identity.conversationType,
      });
      pushContext(key, { id: answer.id, occurredAt: new Date().toISOString(), text: answer.text, identity: herIdentity }, config.contextMessages);
      const reply = answer.text.trim();
      if (!reply) return;
      if (isGroup) {
        rememberSent((await client?.sendGroup(conversationId, reply))?.messageId);
        noteReply(key);
      } else {
        rememberSent((await client?.sendPrivate(conversationId, reply))?.messageId);
      }
      stats.sent += 1;
    } catch (error) {
      stats.failed += 1;
      stats.lastError = error instanceof Error ? error.message : String(error);
      deps.logger.warn(`QQ 回复 ${key} 失败: ${stats.lastError}`);
    } finally { answering.delete(key); }
  }

  /**
   * 阳台：给机器上别的程序留的一条线。
   *
   * 和 QQ 那条完全分开 —— 它是外面递话进来，不是 QQ 消息。一条线一间屋子（会话键里带着
   * `qq-bridge`），所以它跟她别的会话互不打扰。口令落在世界目录（qq-bridge.json），
   * 重启 DSH 对面那份配置不用改。
   */
  function startBridge(config: QqNativeConfig): void {
    if (nativeBridge || !config.bridge.port) return;
    nativeBridge = createNativeBridge({
      ctx: deps.ctx,
      session: identity => deps.home(identity),
      config: () => {
        const live = settings().bridge;
        return { port: live.port, token: live.token, title: live.title, contextMessages: live.contextMessages };
      },
      worldDir: deps.stateFile ? dirname(deps.stateFile) : process.cwd(),
      script: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'qq-line.js'),
      log: (message: string) => deps.logger.info(message),
    });
    void nativeBridge.start().catch((error: unknown) => deps.logger.error('阳台没能开起来', error));
  }

  return {
    status(): QqNativeStatus {
      const config = settings();
      return {
        enabled: config.enabled,
        connected: client?.getState() === 'online',
        url: config.transport === 'http' ? config.httpUrl : config.wsUrl,
        transport: config.transport,
        whoCanTalk: config.whoCanTalk,
        allowPrivate: config.allowPrivate.length,
        allowGroups: config.allowGroups.length,
        autoReply: config.autoReply,
        bindHomeSession: config.bindHomeSession,
        bridge: nativeBridge?.status() ?? null,
        groupTrigger: config.groupTrigger,
        conversations: contexts.size,
        answering: answering.size,
        lastEventAt: stats.lastEventAt,
        blocked: stats.blocked,
        lastBlockedAt: stats.lastBlockedAt,
        lastError: stats.lastError,
        sent: stats.sent,
        failed: stats.failed,
      };
    },
    /** 面板上改阳台的端口：当场关掉重开那条线（0 就是关）。 */
    setBridge(patch: { port?: number }): QqNativeStatus {
      if (patch.port !== undefined) { overrides.bridge = { port: patch.port }; writeOverrides(); }
      nativeBridge?.stop();
      nativeBridge = undefined;
      startBridge(settings());
      return this.status();
    },
    /** 面板上那个「会不会自己回」的开关。 */
    setAutoReply(value: boolean) {
      readOverrides();
      overrides.autoReply = value;
      writeOverrides();
      return this.status();
    },
    start() {
      if (stopped) return;
      const config = settings();
      if (!config.enabled) return;
      const log = (level: string, message: string) => {
        const line = `QQ 通道：${message}`;
        // 连回来就把上次的报错擦掉（不然面板上挂着一句昨天的错，会让人以为现在还坏着）。
        // 「QQ 账号离线」不是这一层的事，留着。
        if (level === 'info') {
          if ((message.startsWith('WS 已连接') || message.startsWith('OneBot HTTP 已连接')) && stats.lastError !== 'QQ 账号离线') stats.lastError = null;
          deps.logger.info(line);
        } else if (level === 'warn') deps.logger.warn(line);
        else { stats.lastError = message; deps.logger.error(line); }
      };
      const wire = {
        // 传输层只交出一条归一化过的消息，形状见 QqIncoming；两边对不上的字段这里本来也不用。
        onGroupMessage: (message: unknown) => { void deliver(message as QqIncoming); },
        onPrivateMessage: (message: unknown) => { void deliver(message as QqIncoming); },
        // bot_status 是 SnowLuma 的自有扩展：账号掉线时让它显示成「QQ 账号离线」，别和「桥挂了」混在一起。
        onNotice: (type: string) => {
          if (type === 'bot_offline') stats.lastError = 'QQ 账号离线';
          if (type === 'bot_online') stats.lastError = null;
        },
        log,
      };
      let bridge: QqTransport;
      if (deps.transport) {
        bridge = deps.transport({
          wsUrl: config.transport === 'http' ? '' : config.wsUrl,
          ...(config.transport === 'http' ? { baseUrl: config.httpUrl, pollIntervalMs: config.pollIntervalMs } : {}),
          ...(config.accessToken ? { accessToken: config.accessToken } : {}),
          ...wire,
        });
      } else if (config.transport === 'http') {
        bridge = createOneBotHttpTransport({
          wsUrl: '',
          baseUrl: config.httpUrl,
          pollIntervalMs: config.pollIntervalMs,
          ...(config.accessToken ? { accessToken: config.accessToken } : {}),
          ...wire,
        });
      } else {
        bridge = createBridge({
          wsUrl: config.wsUrl,
          ...(config.accessToken ? { accessToken: config.accessToken } : {}),
          ...wire,
        });
      }
      client = bridge;
      startBridge(config);
      bridge.start().catch((error: unknown) => {
        stats.lastError = error instanceof Error ? error.message : String(error);
        deps.logger.warn('QQ 通道首次连接失败：', stats.lastError);
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      home.stop();
      nativeBridge?.stop(); nativeBridge = undefined;
      void client?.stop();
      client = undefined;
      contexts.clear();
      seen.clear();
      lastReplyAt.clear();
      minuteCounts.clear();
    },
  };
}

export type QqNativeModule = ReturnType<typeof createQqNativeModule>;
