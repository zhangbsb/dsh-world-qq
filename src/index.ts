import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createBridge, type Bridge } from './ecosystem/bridge/bridge.ts';
import { bridgeRoute } from './ecosystem/bridge/route.ts';
import { createWechatInstaller, wechatPaths } from './ecosystem/wechat/installer.ts';
import { consoleRoute, type ConsoleActions } from './console/routes.ts';
import { consoleSources } from './console/snapshot.ts';
import { errorText, Faults } from './faults.ts';
import { hostLife } from './life/host.ts';
import { createLifeStore, durableWrite } from './life/lifeStore.ts';
import { toastSupported, windowsToast, type Notifier } from './life/notify.ts';
import { createLifeRuntime, type LifeRuntime } from './life/runtime.ts';
import type { LifeOptions } from './life/types.ts';
import { createOutlet } from './ecosystem/shared/outlets.ts';
import { readPersona, writePersona } from './persona.ts';
import type { QqNativeModule } from './ecosystem/qq-native/index.ts';
import { qqRoute } from './ecosystem/qq/route.ts';
import { createConsoleDoors } from './ecosystem/qq/panel.ts';
import { createWorldRuntime } from './runtime.ts';
import { createArchiveStore } from './store.ts';
import type { WorldConfig } from './types.ts';
import { DEFAULT_TEMPLATE_FILE, roomTitle, worldNames } from './worldPrompt.ts';
import { createWorldSwitch } from './worldSwitch.ts';
import { createWechatModule, type WechatModule } from './ecosystem/wechat/index.ts';
import { createWechatRecorder } from './ecosystem/wechat/archive.ts';
import { createAdapterSupervisor, type AdapterSupervisor } from './ecosystem/wechat/supervisor.ts';
import { createChannelSessions } from './ecosystem/shared/sessions.ts';
import { createArchiveSelection } from './archiveSelection.ts';
import { belongsToWorld } from './sourceArchive.ts';

export { createWorldRuntime } from './runtime.ts';
export type { WorldConfig, ConversationRecord, ConversationTurn, ArchiveCursor } from './types.ts';
export const name = 'dsh-world';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'llm'];
/** What `apply` receives: the schema below fills these defaults. */
export type Config = WorldConfig & Required<Pick<WorldConfig, 'life' | 'fallbackWakeTime' | 'outlets' | 'bridge' | 'toast' | 'allowedHosts'>>;
// One companion per profile is the usual case, so it works as installed: the standard preset, a world named
// default and the system time zone, with the life line on (it needs the desktop host's services and stays off without them).
const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const Config = z.object({
  worldId: z.string().default('default'), agentPreset: z.string().default('standard'), timeZone: z.string().default(systemTimeZone),
  companionName: z.string(), partnerName: z.string(),
  archiveScope: z.union([z.const('home').description('仅家会话'), z.const('workspace').description('家所在工作区'), z.transform(z.const('world').hidden(), () => 'workspace' as const).hidden()]).default('workspace').description('记忆归档范围，修改后重启生效'),
  life: z.boolean().default(true), diaryDir: z.string(), fallbackWakeTime: z.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:00'),
  selfFile: z.string(), worldPromptFile: z.string(), alarmTemplateFile: z.string(), personaFile: z.string(),
  // Where her words go outside DSH; no app is known by name (see README for the push body).
  outlets: z.array(z.object({ name: z.string().required(), url: z.string(), urlFile: z.string(), path: z.string(), kinds: z.array(z.union([z.const('reply'), z.const('busy'), z.const('reach')])) })).default([]),
  // A local app may hand her partner's words to her home through POST /dsh-world/bridge/say.
  bridge: z.boolean().default(false),
  qqNative: z.object({
    enabled: z.boolean().default(false),
    // 连接方式：http = NapCat / OneBot 11 的 HTTP（和 qq-bridge 用的是同一条路，不用另起桥进程）；
    // ws = 旧的 SnowLuma WebSocket，留着给已经在用的人。
    transport: z.union([z.const('http').description('OneBot 11 HTTP 轮询（NapCat 的 3000 端口）'), z.const('ws').description('SnowLuma WebSocket（旧通道）')]).default('http'),
    httpUrl: z.string().default('http://127.0.0.1:3000'),
    wsUrl: z.string().default('ws://127.0.0.1:3003'),
    accessToken: z.string().default(''),
    // 轮询间隔（毫秒）。2000 是 qq-bridge 的默认值：一天十几万次请求，NapCat 扛得住。
    pollIntervalMs: z.number().default(2000),
    // 谁可以跟她说话：everyone = 谁发都收，房间按会话自动开（默认，对应「不用自己手动绑定」）；
    // list = 只认下面两个白名单（旧行为）。两个黑名单在哪种模式下都生效。
    whoCanTalk: z.union([z.const('everyone').description('谁发都收，按会话自动开会话'), z.const('list').description('只认白名单')]).default('everyone'),
    denyPrivate: z.array(z.string()).default([]),
    denyGroups: z.array(z.string()).default([]),
    allowPrivate: z.array(z.string()).default([]),
    allowGroups: z.array(z.string()).default([]),
    autoReply: z.boolean().default(true),
    contextMessages: z.number().default(6),
    // 群里什么时候接话。默认 all：不 @ 也接（照老大的要求）；mention 还是留着的，
    // 嫌吵的人填 mention 就退回到「被 @ / 被引用 / 命中关键词才接」。
    groupTrigger: z.union([z.const('mention').description('只接被叫到的（被 @ / 被引用她的话 / 命中关键词）'), z.const('all').description('每句都接')]).default('all'),
    groupKeywords: z.array(z.string()).default([]),
    // 群里闲聊的节奏闸。@ 她 / 引用她的话不排队，冲她来的就回。
    replyCooldownSec: z.number().default(3),
    maxPerMinute: z.number().default(6),
    replyProbability: z.number().default(100),
    // SnowLuma 装在哪：控制台那扇门要去它的 config/runtime.json 拿地址与端口。空着就按 D:\SnowLuma、
    // C:\SnowLuma、~/SnowLuma 挨个认（认「里面有 config/runtime.json」这一条）。
    snowlumaHome: z.string().default(''),
    // 谁和她的家会话共用一个入口。'owner'（默认）＝群各自独立、私聊用她的家；'all'＝都用她的家；
    // 'none'＝谁都不绑，每个入口各建一个 —— 开发测试 QQ 的时候填 none，回合就不会走进步话生活的家里。
    bindHomeSession: z.union([z.const('owner').description('群各自独立，私聊用她的家会话'), z.const('all').description('都用她的家会话'), z.const('none').description('谁都不绑，每个入口各建一个'), z.const('')]).default('owner'),
    // 阳台：给这台机器上别的程序留的一条线。口令空着就由插件自己生成一条并存在世界目录里。
    bridge: z.object({
      port: z.number().default(0),
      token: z.string().default(''),
      title: z.string().default('阳台'),
      contextMessages: z.number().default(6),
    }).default({ port: 0, token: '', title: '阳台', contextMessages: 6 }),
  }).description('QQ 直接连 OneBot：不经过 qq-bridge 进程，会话与状态都由这个插件自己管'),
  wechat: z.boolean().default(false),
  wechatAdapter: z.object({ python: z.string(), config: z.string() }).description('随微信模块启动和停止 Windows 适配器；写上即视为允许它发送消息'),
  toast: z.boolean().default(true),
  // The console and the bridge answer only this machine by name, plus these (a LAN address or domain behind a proxy).
  allowedHosts: z.array(z.string()).default([]),
});
interface WebServer { register(route: ReturnType<typeof consoleRoute> | ReturnType<typeof bridgeRoute> | ReturnType<typeof qqRoute>): () => void }

/**
 * Her world runs only after her partner presses start in the world console, and stops when they press stop:
 * memory block, persona, world prompt, archive and life line come and go together. The switch is kept in
 * `<world>/world.json`, so it outlasts a restart.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dshHome = resolveDshHome();
  const worldDir = join(dshHome, 'worlds', config.worldId);
  const store = createArchiveStore({ ...config, root: dshHome });
  const power = createWorldSwitch(worldDir, config.archiveScope ?? 'workspace');
  const memoryConfig = { ...config, archiveScope: power.archiveScope() };
  const faults = new Faults();
  // Her self-description lives in her room whether or not the life line runs; she writes it with her file tools.
  const selfFile = config.selfFile || join(worldDir, 'room', '我是谁.md');
  const personaFile = config.personaFile || join(worldDir, 'persona.md');
  const worldPromptFile = config.worldPromptFile || join(worldDir, 'world-prompt.md');
  const options: LifeOptions = { worldDir, roomDir: join(worldDir, 'room'), diaryDir: config.diaryDir || join(worldDir, 'diary'), selfFile, fallbackWakeTime: config.fallbackWakeTime, timeZone: config.timeZone, alarmFile: config.alarmTemplateFile || join(worldDir, 'alarm.md') };
  /** The name in her persona comes first, then the configured one. */
  const names = () => worldNames({ ...config, companionName: readPersona(personaFile).名字 || config.companionName });
  const lifeStore = (() => {
    if (!config.life) return undefined;
    try { const current = createLifeStore(worldDir, config.timeZone); current.read(); return current; }
    catch (error) { faults.set('life', `生活线没能启动：${errorText(error)}`); ctx.logger.error(error); return undefined; }
  })();
  const storedHome = () => lifeStore?.read().homeSessionId;
  let isHome: (sessionId: string) => boolean = id => id === storedHome();
  const includesSession = createArchiveSelection(ctx, power.archiveScope(), id => isHome(id), options.roomDir);

  let memory: ReturnType<typeof createWorldRuntime> | undefined;
  let stopLifeLine: (() => Promise<void>) | undefined;
  async function startMemory(fresh: boolean): Promise<void> {
    if (memory) return;
    const prompt = { file: worldPromptFile, persona: personaFile, conversationsDir: join(worldDir, 'conversations'), names: names(), ...(config.life ? { life: options } : {}) };
    memory = createWorldRuntime(ctx, { ...memoryConfig, selfFile }, store, { prompt, isHome: id => isHome(id), archiveSession: includesSession }, power.memoryTurns);
    await memory.start({ fresh });
  }
  async function stopMemory(): Promise<void> {
    const running = memory; memory = undefined;
    await running?.stop();
  }
  ctx.effect(() => async () => {
    try { await stopLifeLine?.(); }
    finally { await stopMemory().finally(() => store.close()); }
  }, 'dsh-world memory line');
  if (power.running()) await startMemory(false);
  // The host's workspace service may come up after this plugin; what the first catch-up could not place is read then.
  ctx.inject(['workspaceRegistry'], injected => { void memory?.retryCatchUp().catch(error => injected.logger.error(error)); });

  // The console and the life line need the desktop host.
  ctx.inject(['sessionController', 'permissionPresets', 'webServer'], async lifeCtx => {
    const webServer = (lifeCtx as unknown as { webServer: WebServer }).webServer;
    const host = hostLife(lifeCtx);
    // QQ 的两扇门：她自己那条 OneBot 通道的状态与开关，以及 SnowLuma 的控制台。**无条件注册** —— 通道
    // 关着的时候 /native 回 null，而 SnowLuma 那扇门跟通道没关系。（这里原来还有一半是给外面那个
    // qq-bridge 进程用的，连 qqBridgeDir 一起在 2026-10-27 拆掉了。当时的教训：那条路由是注册在「有桥
    // 目录」这个分支里的，配置一摘，整片 /dsh-world/qq/* 就全 404，界面也一起没了。所以现在它不再挂在
    // 任何配置上 —— 端点先存在，功能再按需开关。）
    const doors = createConsoleDoors({ worldDir, snowlumaHome: config.qqNative?.snowlumaHome ?? '' });
    const unregisterQq = webServer.register(
      qqRoute(config.allowedHosts, doors, () => qqNative?.status() ?? null, patch => {
        if (!qqNative) return null;
        if (patch.bridge) return qqNative.setBridge(patch.bridge);
        return qqNative.setAutoReply(patch.autoReply === true);
      }),
    );
    lifeCtx.effect(() => () => unregisterQq(), 'dsh-world qq route');
    let life: LifeRuntime | undefined;
    let bridge: Bridge | undefined;
    let wechat: WechatModule | undefined;
    let qqNative: QqNativeModule | undefined;
    let qqChannels: ReturnType<typeof createChannelSessions> | undefined;
    let adapter: AdapterSupervisor | undefined;
    let channels: ReturnType<typeof createChannelSessions> | undefined;
    let unregisterWechat: (() => void) | undefined;
    let lifeStop: Promise<void> | undefined;
    let wechatClosing: Promise<void> = Promise.resolve();
    const wechatInstaller = createWechatInstaller({ worldDir, log: message => lifeCtx.logger.info(message), onInstalled: () => { void ensureWechatAdapter(); } });
    /** 配置里写了就用配置的；没写但一键安装过，就用 `.host/wechat` 里装好的那套（对应「装完自动连上」）。 */
    function installedAdapter(): { python: string; config: string } | undefined {
      if (config.wechatAdapter?.python && config.wechatAdapter.config) return { python: config.wechatAdapter.python, config: config.wechatAdapter.config };
      const paths = wechatPaths(worldDir);
      if (existsSync(paths.python) && existsSync(paths.config)) return { python: paths.python, config: paths.config };
      return undefined;
    }
    /** 一键安装结束后把适配器拉起来；已经在跑就什么也不做。 */
    async function ensureWechatAdapter(): Promise<boolean> {
      if (!wechat) return false;
      if (adapter) return true;
      const found = installedAdapter();
      if (!found) return false;
      adapter = createAdapterSupervisor({ python: found.python, config: found.config, logFile: join(worldDir, 'wechat-adapter.log'), log: message => lifeCtx.logger.warn(message) });
      adapter.start();
      faults.clear('wechat');
      return true;
    }
    /** Starts the WeChat module (its tools, route and, when configured, the adapter) against the running life line. */
    async function startWechat(current: LifeRuntime): Promise<void> {
      if (wechat || !config.wechat) return;
      await wechatClosing;
        const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
        channels = groupSessions;
        wechat = createWechatModule({ ctx: lifeCtx, worldId: config.worldId, acceptAgent: agent => belongsToWorld(agent.session, config), home: identity => identity.conversationType === 'group' ? groupSessions.open(identity) : current.home(), origin: () => host.origin(), file: join(worldDir, 'wechat.json'), incomingDir: join(worldDir, 'wechat-incoming'), allowedHosts: config.allowedHosts, settings: () => ({ contextMessages: power.wechatContext(), bufferSeconds: power.wechatBufferSeconds() }),
          ...createWechatRecorder(store, config.worldId, includesSession) });
        wechat.start(); unregisterWechat = webServer.register(wechat.route);
        const found = installedAdapter();
        if (found) { adapter = createAdapterSupervisor({ python: found.python, config: found.config, logFile: join(worldDir, 'wechat-adapter.log'), log: message => lifeCtx.logger.warn(message) }); adapter.start(); }
        else faults.set('wechat', '微信模块还没安装：在控制台点一次「一键安装微信模块」');
    }
    /** Takes the WeChat tools, route and adapter down; the adapter goes first because it exits when the module's connection file disappears. */
    function stopWechat(): Promise<void> {
      unregisterWechat?.(); unregisterWechat = undefined;
      const closingAdapter = adapter?.stop(); adapter = undefined;
      const closing = Promise.all([closingAdapter, wechat?.stop()]).then(() => {}); wechat = undefined;
      channels?.stop(); channels = undefined;
      return wechatClosing = closing;
    }
    /** QQ talks to her through the same home the WeChat channel uses; only the transport differs. */
    async function startQqNative(current: LifeRuntime): Promise<void> {
      const q = config.qqNative;
      if (qqNative || !q?.enabled || !power.qqEnabled()) return;
      try {
        const { createQqNativeModule } = await import('./ecosystem/qq-native/index.ts');
        if (qqNative || life !== current || !power.running() || !power.qqEnabled()) return;
        const groupSessions = createChannelSessions({ ctx: lifeCtx, host, store, roomDir: options.roomDir, roomTitle: roomTitle(names()), agentPreset: config.agentPreset });
        qqChannels = groupSessions;
        qqNative = createQqNativeModule({
          ctx: lifeCtx,
          // `none` keeps private test traffic out of her real home, as groups are by default.
          home: identity => {
            const bind = q.bindHomeSession ?? 'owner';
            if (identity.conversationType === 'group') return bind === 'all' ? current.home() : groupSessions.open(identity);
            return bind === 'none' ? groupSessions.open(identity) : current.home();
          },
          logger: lifeCtx.logger,
          stateFile: join(options.roomDir, '..', 'qq-native.json'),
          config: () => ({
            enabled: q.enabled ?? false,
            transport: q.transport ?? 'http',
            httpUrl: q.httpUrl ?? 'http://127.0.0.1:3000',
            wsUrl: q.wsUrl ?? 'ws://127.0.0.1:3003',
            accessToken: q.accessToken ?? '',
            pollIntervalMs: q.pollIntervalMs ?? 2000,
            whoCanTalk: q.whoCanTalk ?? 'everyone',
            denyPrivate: q.denyPrivate ?? [],
            denyGroups: q.denyGroups ?? [],
            allowPrivate: q.allowPrivate ?? [],
            allowGroups: q.allowGroups ?? [],
            autoReply: q.autoReply ?? true,
            contextMessages: q.contextMessages ?? 6,
            groupTrigger: q.groupTrigger ?? 'all',
            groupKeywords: q.groupKeywords ?? [],
            replyCooldownSec: q.replyCooldownSec ?? 3,
            maxPerMinute: q.maxPerMinute ?? 6,
            replyProbability: q.replyProbability ?? 100,
            bridge: {
              port: q.bridge?.port ?? 0,
              token: q.bridge?.token ?? '',
              title: q.bridge?.title ?? '阳台',
              contextMessages: q.bridge?.contextMessages ?? 6,
            },
            bindHomeSession: q.bindHomeSession ?? 'owner',
          }),
        });
        qqNative.start();
        faults.clear('qq');
      } catch (error) {
        stopQqNative();
        faults.set('qq', `QQ 模块没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopQqNative(): void { qqNative?.stop(); qqNative = undefined; qqChannels?.stop(); qqChannels = undefined; faults.clear('qq'); }
    async function startLife(resumed: boolean): Promise<void> {
      if (!lifeStore || life) return;
      try {
        await lifeStop;
        const outlets = config.outlets.map(outlet => createOutlet(outlet, () => host.origin()));
        const notifier: Notifier = { ...(config.toast && toastSupported() ? { toast: windowsToast() } : {}), outlets };
        const current = createLifeRuntime({ ctx: lifeCtx, config: { ...config, companionName: names().companion }, options, store: lifeStore, host, notifier, dailyBudget: power.dailyBudget });
        life = current; isHome = current.isHome;
        if (config.bridge) { bridge = createBridge({ ctx: lifeCtx, home: () => current.home(), outlets, origin: () => host.origin(), file: join(worldDir, 'bridge.json'), name: names().companion }); bridge.start(); }
        if (config.wechat && power.wechatEnabled()) await startWechat(current);
        if (config.qqNative?.enabled && power.qqEnabled()) await startQqNative(current);
        faults.clear('life');
        await current.start({ resumed });
      } catch (error) {
        // The console still opens and says why, instead of looking as if the life line were simply off.
        await stopLife();
        faults.set('life', `生活线没能启动：${errorText(error)}`); lifeCtx.logger.error(error);
      }
    }
    function stopLife(): Promise<void> {
      isHome = id => id === storedHome();
      bridge?.stop(); life?.stop();
      const closingWechat = stopWechat();
      stopQqNative();
      bridge = undefined; life = undefined;
      return lifeStop = Promise.all([lifeStop, closingWechat]).then(() => {});
    }
    stopLifeLine = stopLife;
    lifeCtx.effect(() => () => stopLife(), 'dsh-world life line');
    // The host matches exact routes before the longest prefix, so this path never reaches the console.
    if (config.bridge) lifeCtx.effect(() => webServer.register(bridgeRoute(() => bridge, config.allowedHosts)), 'dsh-world bridge route');

    // Her album lives in her room, so the console shows it whether or not the life line is running.
    const sources = consoleSources({ ctx: lifeCtx, config: memoryConfig, archive: store, names, ...(lifeStore ? { lifeStore } : {}), life: () => life, diaryDir: options.diaryDir, running: power.running, dailyBudget: power.dailyBudget, memoryTurns: power.memoryTurns, selectedArchiveScope: power.selectedArchiveScope, wechat: () => wechat ? { ...wechat.status(), adapter: adapter?.status() ?? null } : undefined, includesSession, native: () => qqNative?.status() ?? null,
      modules: () => ({ wechat: { available: config.wechat, enabled: power.wechatEnabled(), running: wechat !== undefined }, qq: { available: Boolean(config.qqNative?.enabled), enabled: power.qqEnabled(), running: qqNative !== undefined } }), faults: () => [...faults.list(), ...(memory?.faults() ?? []), ...(bridge?.faults() ?? [])] });
    const actions: ConsoleActions = {
      async start() {
        if (power.running()) return;
        power.set(true);
        try { await startMemory(true); await startLife(true); } finally { sources.invalidate(); }
      },
      async stop() {
        if (!power.running()) return;
        power.set(false);
        await stopLife();
        try { await stopMemory(); } finally { sources.invalidate(); }
      },
      prompts: () => ({
        persona: readPersona(personaFile),
        worldPrompt: existsSync(worldPromptFile) ? { text: readFileSync(worldPromptFile, 'utf8'), custom: true } : { text: readFileSync(DEFAULT_TEMPLATE_FILE, 'utf8'), custom: false },
      }),
      savePersona: persona => { writePersona(personaFile, { ...readPersona(personaFile), ...persona }); sources.invalidate(); },
      setDailyBudget: yuan => { power.setDailyBudget(yuan); sources.invalidate(); },
      setMemoryTurns: turns => { power.setMemoryTurns(turns); sources.invalidate(); },
      async setModules(patch) {
        if (patch.wechat !== undefined && !config.wechat) return '没有配置微信模块（配置里 wechat: true）';
        if (patch.qq !== undefined && !config.qqNative?.enabled) return '没有配置原生 QQ 通道（配置里 qqNative.enabled）';
        power.setModules(patch);
        try {
          if (patch.wechat === false) await stopWechat();
          if (patch.wechat === true && life) await startWechat(life);
          if (patch.qq === false) stopQqNative();
          if (patch.qq === true && life) await startQqNative(life);
          if (patch.qq === true && life && !qqNative) return 'QQ 模块没能启动，请查看健康状态';
        } catch (error) { faults.set('wechat', `微信模块没能切换：${errorText(error)}`); lifeCtx.logger.error(error); return `切换失败：${errorText(error)}`; }
        finally { sources.invalidate(); }
        faults.clear('wechat');
        return undefined;
      },
      restartWechatAdapter: async () => { try { if (adapter) await adapter.restart(); else return await ensureWechatAdapter(); } finally { sources.invalidate(); } return true; },
      /** 一键安装：立刻返回当前状态，真正的安装在后台跑，界面轮询 status 看进度。 */
      wechatInstall: () => { void wechatInstaller.install().catch(error => lifeCtx.logger.warn(`微信一键安装失败：${errorText(error)}`)); return wechatInstaller.status(); },
      wechatInstallStatus: () => wechatInstaller.status(),
      setWechatSettings: next => { power.setWechat(next); sources.invalidate(); },
      setArchiveScope: scope => { power.setArchiveScope(scope); sources.invalidate(); return power.restartRequired(); },
      saveWorldPrompt: text => { if (text.trim()) durableWrite(worldPromptFile, text); else rmSync(worldPromptFile, { force: true }); },
    };
    lifeCtx.effect(() => webServer.register(consoleRoute(sources, actions, config.allowedHosts)), 'dsh-world console routes');
    if (power.running()) await startLife(false);
  });
}
