/**
 * OneBot 11 over plain HTTP —— 和 dsh-qq-bridge 用的是同一条路。
 *
 * 为什么要有它：SnowLuma 那条线要开 WebSocket（`ws://127.0.0.1:3001`），装的人还得先把
 * SnowLuma 起起来；而 NapCat 这类实现本来就开着 3000 端口的 HTTP，qq-bridge 用的就是它。
 * 这里把同一套 HTTP 接口接到世界插件的传输层上，于是「QQ 模块」不再需要另外一条桥进程。
 *
 * 纯 HTTP 有个天生的缺口：它没有推送。所以这里自己长了一套**自动发现**：
 *   1. `get_recent_contact`（NapCat / SnowLuma 的扩展接口）—— 最近会话列表，谁刚说过话一看就知道；
 *   2. 拿不到这个接口时退回到 `get_group_list` + `get_friend_list`，挨个轮询；
 *   3. 每一个聊天各记各的「看到哪儿了」，第一次见到某个聊天时不补历史。
 *
 * 这条设计对应老大那句「不用自己手动绑定」：一个聊天只要有人说话，就会自动被发现、自动进世界，
 * 由 `shared/sessions.ts` 按会话键开一间新会话；不需要在配置里填 QQ 号或群号。
 */

import type { QqIncoming, QqTransport, QqTransportOptions } from './index.ts';

/** 一条消息 / 通知最多记多久（去重用）。 */
const SEEN_LIMIT = 2_000;
/** 一次轮询最多看几个聊天 —— 聊天多了就大家轮流，不排成一条长队。 */
const DEFAULT_CHATS_PER_TICK = 8;
/** 最近会话：多久问一次。 */
const DEFAULT_DISCOVER_MS = 5_000;
/** 群 / 好友名单：多久刷一次（用来判断一个 peerUin 是群还是人）。 */
const DEFAULT_LIST_REFRESH_MS = 60_000;
/** 历史接口一次拉多少条。 */
const GROUP_HISTORY_COUNT = 20;
const PRIVATE_HISTORY_COUNT = 10;
/** 连续几次调用失败才判「离线」，避免一次超时就把面板打红。 */
const OFFLINE_AFTER_FAILURES = 3;

export interface OneBotHttpOptions extends QqTransportOptions {
  /** OneBot 11 的 HTTP 根地址，例如 `http://127.0.0.1:3000`。 */
  baseUrl: string;
  pollIntervalMs?: number;
  discoverIntervalMs?: number;
  listRefreshMs?: number;
  chatsPerTick?: number;
  /** 启动时如果已经知道自己的 QQ 号，可以先填上（面板显示用）。 */
  selfIdHint?: string;
}

interface WatchedChat {
  key: string;
  kind: 'group' | 'private';
  id: string;
  name: string;
  /** 已经看到这个聊天里最后一条消息的时间（秒）。 */
  lastTime: number;
  /** 第一次轮询时从这个时间开始（秒）；null = 第一次轮询从「此刻」开始，不补历史。 */
  bootstrapFrom: number | null;
  lastPollAt: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 把 OneBot 的 `message` 段数组转成给人看的一句话（和 snowluma.ts 那份保持同一种口味）。 */
export function segmentText(message: unknown): string {
  if (typeof message === 'string') return message.trim();
  const list = Array.isArray(message) ? message : (message && typeof message === 'object' ? [message] : []);
  const out: string[] = [];
  for (const raw of list) {
    const segment = raw as { type?: string; data?: Record<string, unknown> };
    const data = segment?.data ?? {};
    switch (segment?.type) {
      case 'text': out.push(String(data.text ?? '')); break;
      case 'at': out.push(String(data.qq) === 'all' ? '@全体成员' : `@${String(data.name ?? data.qq ?? '')}`); break;
      case 'face': out.push(`[表情${data.id ?? ''}]`); break;
      case 'mface': out.push(`[表情${data.summary ? `:${String(data.summary)}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${data.name ? `:${String(data.name)}` : ''}]`); break;
      case 'reply': out.push('[引用消息]'); break;
      case 'json': out.push('[卡片消息]'); break;
      case 'xml': out.push('[卡片消息]'); break;
      case 'forward': out.push('[转发消息]'); break;
      case 'markdown': out.push(String(data.text ?? data.content ?? '[Markdown]')); break;
      default: out.push(`[${String(segment?.type ?? '未知')}]`); break;
    }
  }
  return out.join('').trim();
}

/** 数字化一个可能来自字符串/数字的字段；不合法时返回兜底值。 */
function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * HTTP 轮询版传输层。
 *
 * 返回的就是 `QqTransport`，上层（qq-native/index.ts）不知道消息是从推还是从轮询来的 ——
 * 它只收归一化过的 `QqIncoming`。
 */
export function createOneBotHttpTransport(options: OneBotHttpOptions): QqTransport {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const token = String(options.accessToken || '');
  const pollIntervalMs = Math.max(500, Math.min(num(options.pollIntervalMs, 2_000), 30_000));
  const discoverIntervalMs = Math.max(1_000, Math.min(num(options.discoverIntervalMs, DEFAULT_DISCOVER_MS), 120_000));
  const listRefreshMs = Math.max(5_000, Math.min(num(options.listRefreshMs, DEFAULT_LIST_REFRESH_MS), 600_000));
  const chatsPerTick = Math.max(1, Math.min(num(options.chatsPerTick, DEFAULT_CHATS_PER_TICK), 30));

  const watch = new Map<string, WatchedChat>();
  const seen = new Set<string>();
  let selfId = String(options.selfIdHint || '');
  let knownGroups = new Set<string>();
  let knownFriends = new Set<string>();
  let recentContactSupported = true;
  let failures = 0;
  let online = false;
  let announcedOffline = false;
  let stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let lastDiscoverAt = 0;
  let lastListAt = 0;

  function log(level: string, message: string): void {
    try { options.log(level, message); } catch { /* 日志不该把轮询带走 */ }
  }

  function markOnline(): void {
    failures = 0;
    if (online) return;
    online = true;
    announcedOffline = false;
    options.onNotice?.('bot_online');
    log('info', `OneBot HTTP 已连接（${baseUrl}）`);
  }

  function markFailure(reason: unknown): void {
    failures += 1;
    if (failures < OFFLINE_AFTER_FAILURES) return;
    if (online || !announcedOffline) {
      online = false;
      announcedOffline = true;
      options.onNotice?.('bot_offline');
      log('warn', `OneBot HTTP 连不上（${reason instanceof Error ? reason.message : String(reason)}）`);
    }
  }

  /** 调一个 OneBot action，拿 `data`；失败返回 null。 */
  async function call(action: string, body: Record<string, unknown> = {}): Promise<any | null> {
    if (!baseUrl) return null;
    try {
      const response = await fetch(`${baseUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as any;
      if (!payload || payload.status === 'failed') return null;
      markOnline();
      return payload.data ?? null;
    } catch (error) {
      markFailure(error);
      return null;
    }
  }

  function remember(key: string): boolean {
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) {
      const first = seen.values().next().value;
      if (first !== undefined) seen.delete(first);
    }
    return true;
  }

  /** 把一个聊天挂进轮询表；同一时间同一种聊天只留一条。 */
  function watchChat(kind: 'group' | 'private', id: string, name: string, bootstrapFrom: number | null): void {
    const key = `${kind}:${id}`;
    if (watch.has(key)) return;
    const now = Math.floor(Date.now() / 1000);
    watch.set(key, {
      key, kind, id, name,
      lastTime: now,
      // 从最近会话发现的聊天：从「它最后一条消息的前一秒」开始，这样刚才那条不会被漏掉。
      bootstrapFrom: bootstrapFrom == null ? null : Math.max(0, Math.floor(bootstrapFrom) - 1),
      lastPollAt: 0,
    });
  }

  /** 最近会话（NapCat 扩展接口）。谁刚说过话，这里一秒就能知道。 */
  async function discoverRecent(): Promise<void> {
    if (!recentContactSupported) return;
    const data = await call('get_recent_contact', { count: 20 });
    if (data == null) {
      // 接口不存在 → 永久退回名单轮询（别每五秒白问一次）。
      recentContactSupported = false;
      log('info', '这个 OneBot 实现没有 get_recent_contact，改用群/好友名单轮询');
      return;
    }
    const list = Array.isArray(data) ? data : (Array.isArray(data?.list) ? data.list : []);
    for (const item of list) {
      const peer = String(item?.peerUin ?? item?.peer_uin ?? item?.peerUid ?? '').trim();
      if (!peer) continue;
      const name = String(item?.peerName ?? item?.remark ?? peer);
      const at = num(item?.msgTime ?? item?.msg_time, 0);
      // chatType 在不同实现里 1/2/3 的指代并不统一：拿名单判断，比猜它更稳。
      if (knownGroups.has(peer)) watchChat('group', peer, name, at || null);
      else watchChat('private', peer, name, at || null);
    }
  }

  /** 群 / 好友名单：判断 peerUin 是群还是人，也给「没有最近会话接口」时兜底。 */
  async function refreshLists(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastListAt < listRefreshMs) return;
    lastListAt = now;
    const groups = await call('get_group_list');
    if (Array.isArray(groups)) {
      knownGroups = new Set(groups.map((row: any) => String(row?.group_id ?? '')).filter(Boolean));
      for (const row of groups) {
        const id = String((row as any)?.group_id ?? '');
        if (id) watchChat('group', id, String((row as any)?.group_name ?? id), null);
      }
    }
    const friends = await call('get_friend_list');
    if (Array.isArray(friends)) {
      knownFriends = new Set(friends.map((row: any) => String(row?.user_id ?? '')).filter(Boolean));
      for (const row of friends) {
        const id = String((row as any)?.user_id ?? '');
        if (id) watchChat('private', id, String((row as any)?.remark ?? (row as any)?.nickname ?? id), null);
      }
    }
  }

  /** 记录一个新消息，交给上层；返回 false 表示这是自己发的 / 重复的。 */
  async function handOver(chat: WatchedChat | null, raw: any): Promise<void> {
    const messageId = String(raw?.message_id ?? raw?.messageId ?? '');
    const senderId = String(raw?.sender?.user_id ?? raw?.user_id ?? '');
    if (selfId && senderId === selfId) return;
    if (messageId && !remember(messageId)) return;
    const isGroup = raw?.message_type === 'group' || (chat?.kind ?? '') === 'group';
    const groupId = String(raw?.group_id ?? (isGroup ? chat?.id ?? '' : ''));
    if (isGroup && !groupId) return;
    const incoming: QqIncoming = {
      kind: isGroup ? 'group' : 'private',
      groupId: isGroup ? groupId : null,
      userId: senderId,
      messageId,
      selfId,
      text: segmentText(raw?.message ?? raw?.raw_message ?? ''),
      sender: {
        nickname: String(raw?.sender?.nickname ?? ''),
        card: raw?.sender?.card != null ? String(raw.sender.card) : null,
      },
      segments: Array.isArray(raw?.message) ? raw.message as Array<{ type?: string; data?: Record<string, unknown> }> : undefined,
    };
    if (!incoming.text && !(incoming.segments ?? []).some(s => s?.type === 'image' || s?.type === 'mface')) return;
    if (isGroup) options.onGroupMessage?.(incoming);
    else options.onPrivateMessage?.(incoming);
  }

  /** 拉一个聊天的历史，把新消息按时间顺序递上去。 */
  async function pollChat(chat: WatchedChat): Promise<void> {
    const firstPoll = chat.bootstrapFrom !== null;
    const from = firstPoll ? (chat.bootstrapFrom as number) : chat.lastTime;
    const isGroup = chat.kind === 'group';
    const data = await call(
      isGroup ? 'get_group_msg_history' : 'get_friend_msg_history',
      isGroup
        ? { group_id: Number(chat.id), count: GROUP_HISTORY_COUNT }
        : { user_id: Number(chat.id), count: PRIVATE_HISTORY_COUNT },
    );
    if (data === null) return;
    chat.lastPollAt = Date.now();
    const messages: any[] = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data) ? data : []);
    const fresh = messages
      .filter(row => Number(row?.time ?? 0) >= from)
      .sort((a, b) => num(a?.time, 0) - num(b?.time, 0) || String(a?.message_id ?? '').localeCompare(String(b?.message_id ?? '')));
    for (const raw of fresh) {
      await handOver(chat, { ...raw, message_type: isGroup ? 'group' : 'private', ...(isGroup ? {} : { user_id: String(raw?.sender?.user_id ?? chat.id) }) });
      chat.lastTime = Math.max(chat.lastTime, num(raw?.time, chat.lastTime));
    }
    if (firstPoll) chat.bootstrapFrom = null;
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return;
    ticking = true;
    try {
      if (!selfId) {
        const login = await call('get_login_info');
        if (login && login.user_id != null) selfId = String(login.user_id);
        if (selfId) log('info', `已登录 QQ ${selfId}`);
      }
      if (!selfId) return; // 号没登，什么都不用拉
      const now = Date.now();
      if (now - lastDiscoverAt >= discoverIntervalMs) {
        lastDiscoverAt = now;
        await discoverRecent();
        if (!recentContactSupported) await refreshLists();
        else if (watch.size === 0) await refreshLists(true);
      }
      // 轮流拉：最久没看过的先看。
      const queue = [...watch.values()].sort((a, b) => a.lastPollAt - b.lastPollAt).slice(0, chatsPerTick);
      for (const chat of queue) {
        if (stopped) return;
        await pollChat(chat);
      }
    } catch (error) {
      log('warn', `轮询出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
      if (!stopped) timer = setTimeout(() => { void tick(); }, pollIntervalMs);
    }
  }

  return {
    async start() {
      if (!stopped) return;
      if (!baseUrl) throw new Error('没有配置 NapCat / OneBot 的 HTTP 地址（例如 http://127.0.0.1:3000）');
      stopped = false;
      log('info', `OneBot HTTP 轮询启动：${baseUrl}，每 ${pollIntervalMs}ms 看一次`);
      await refreshLists(true);
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      online = false;
      watch.clear();
      seen.clear();
    },
    getState() {
      return online ? 'online' : (stopped ? 'offline' : 'connecting');
    },
    async sendGroup(groupId: string, text: string) {
      const data = await call('send_group_msg', {
        group_id: Number(groupId),
        message: [{ type: 'text', data: { text } }],
      });
      return { messageId: String(data?.message_id ?? '') };
    },
    async sendPrivate(userId: string, text: string) {
      const data = await call('send_private_msg', {
        user_id: Number(userId),
        message: [{ type: 'text', data: { text } }],
      });
      return { messageId: String(data?.message_id ?? '') };
    },
  };
}
