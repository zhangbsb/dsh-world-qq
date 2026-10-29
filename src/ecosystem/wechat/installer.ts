/**
 * 微信模块的一键安装。
 *
 * 上游 dsh-world 把 Windows 微信适配器的安装拆成了好几步：建 venv、装依赖、编译原生桥、手写
 * `config.json`、跑 `wechat.ps1 Chats` 把聊天一条条挑进配置。对一个想直接用的用户来说，这套
 * 流程太细了 —— 于是这里把它合成一个动作：点一次「一键安装」，它自己把该建的建好、该编的编好，
 * 探测本机的微信数据目录和账号，把聊天列表写进配置，最后交给 supervisor 去连。
 *
 * 不使用任何微信接口：读的是本机已经登录的微信自己落盘的数据，和上游适配器完全一样。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 适配器脚本在包里始终是 `src/ecosystem/wechat/windows`（src 与 lib 两种布局都指回源码目录）。 */
const ADAPTER = fileURLToPath(new URL('../../../src/ecosystem/wechat/windows/adapter.py', import.meta.url));
const WINDOWS_DIR = dirname(ADAPTER);
/** `wechat.ps1` 与 `engine/build.ps1` 都按「包根目录」定位 `.host/wechat`，这里跟着它们走。 */
const PACKAGE_ROOT = join(WINDOWS_DIR, '../../../..');
const RUNTIME_DIR = process.env.DSH_WORLD_WECHAT_ROOT
  ? process.env.DSH_WORLD_WECHAT_ROOT
  : join(PACKAGE_ROOT, '.host', 'wechat');

export interface WechatPaths {
  windows: string;
  script: string;
  runtime: string;
  python: string;
  config: string;
  engine: string;
}

/** `<world>/wechat.json` 是模块自己写的入口文件；适配器通过它回话。 */
export function wechatPaths(worldDir: string): WechatPaths & { moduleFile: string } {
  return {
    windows: WINDOWS_DIR,
    script: join(WINDOWS_DIR, 'wechat.ps1'),
    runtime: RUNTIME_DIR,
    python: join(RUNTIME_DIR, '.venv', 'Scripts', 'python.exe'),
    config: join(RUNTIME_DIR, 'config.json'),
    engine: join(RUNTIME_DIR, 'engine'),
    moduleFile: join(worldDir, 'wechat.json'),
  };
}

export type WechatInstallPhase = 'idle' | 'installing' | 'ready' | 'failed';
export interface WechatInstallStatus {
  phase: WechatInstallPhase;
  step: string;
  progress: number;
  log: string[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  /** 探测到的本机微信：账号目录名、真实 wxid、数据目录、聊天条数。 */
  detected?: { account: string; selfId: string; dbDir: string; chats: number };
  ready: { python: boolean; engine: boolean; config: boolean; module: boolean };
}

interface AdapterConfig {
  account: string;
  selfId: string;
  dbDir: string;
  moduleFile: string;
  chats?: Array<{ id: string; name: string; trigger?: 'mention' | 'all' }>;
  [key: string]: unknown;
}

/** 一次进程执行：超时也算失败，输出一起交回去（安装失败时要靠它说清楚为什么）。 */
function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code, out }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(-1); }, timeoutMs);
    child.stdout?.on('data', chunk => { out += String(chunk); });
    child.stderr?.on('data', chunk => { out += String(chunk); });
    child.once('error', cause => { out += `\n${String(cause)}`; finish(-1); });
    child.once('close', code => finish(code ?? -1));
  });
}

function powershell(): string {
  const system = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
  return system && existsSync(system) ? system : 'powershell.exe';
}

function readConfig(file: string): AdapterConfig | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as AdapterConfig; } catch { return undefined; }
}

/**
 * 找出本机的微信数据目录与账号。
 *
 * 布局（上游适配器的约束）：`<dbDir>/<account>/db_storage/...`。`account` 是目录名，
 * 4.x 里它可能带后缀，而 `selfId` 必须是真实 wxid —— 所以从目录名里把 `_` 之后的后缀去掉。
 */
export function detectWechat(): { account: string; selfId: string; dbDir: string } | undefined {
  const candidates: string[] = [];
  if (process.env.DSH_WORLD_WECHAT_DBDIR) candidates.push(process.env.DSH_WORLD_WECHAT_DBDIR);
  candidates.push(join(homedir(), 'Documents', 'xwechat_files'), join(homedir(), 'Documents', 'WeChat Files'));
  const found: Array<{ account: string; dbDir: string; at: number }> = [];
  for (const root of candidates) {
    if (!root || !existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const storage = join(dir, 'db_storage');
        if (!existsSync(storage)) continue;
        found.push({ account: entry, dbDir: root, at: statSync(storage).mtimeMs });
      } catch { /* 权限不够或正被写入：换下一个 */ }
    }
  }
  if (!found.length) return undefined;
  found.sort((a, b) => b.at - a.at);
  const account = found[0]!.account;
  // `wxid_abcdef_1234` → `wxid_abcdef`；其余原样用。
  const parts = account.split('_');
  const selfId = account.startsWith('wxid_') && parts.length > 2 ? parts.slice(0, 2).join('_') : account;
  return { account, selfId, dbDir: found[0]!.dbDir };
}

/** 从输出里抠出最后一个 JSON 对象（PowerShell 会在前后夹杂提示行）。 */
function lastJson(text: string): unknown {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* 继续往前找 */ }
  }
  return undefined;
}

export interface WechatInstallerDeps {
  worldDir: string;
  log(message: string): void;
  /** 装好之后调用（通常用来把 supervisor 拉起来）。 */
  onInstalled?(): void;
}

export function createWechatInstaller(deps: WechatInstallerDeps) {
  const paths = wechatPaths(deps.worldDir);
  const log: string[] = [];
  let phase: WechatInstallPhase = 'idle';
  let step = '';
  let progress = 0;
  let error: string | undefined;
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let detected: WechatInstallStatus['detected'];
  let running: Promise<void> | undefined;

  function note(message: string): void {
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    log.push(`[${stamp}] ${message}`);
    if (log.length > 200) log.splice(0, log.length - 200);
    deps.log(`微信安装：${message}`);
  }
  function ready() {
    return {
      python: existsSync(paths.python),
      engine: existsSync(join(paths.engine, 'current.json')),
      config: readConfig(paths.config)?.chats !== undefined && (readConfig(paths.config)?.chats?.length ?? 0) > 0,
      module: existsSync(paths.moduleFile),
    };
  }

  async function install(): Promise<void> {
    if (running) return running;
    running = (async () => {
      phase = 'installing'; progress = 0; error = undefined; step = '准备';
      startedAt = new Date().toISOString(); finishedAt = undefined;
      try {
        if (process.platform !== 'win32') throw new Error('微信模块只能在 Windows 上安装（它读的是 Windows 微信的本地数据）');
        if (!existsSync(paths.script)) throw new Error(`找不到安装脚本：${paths.script}`);

        step = '建立 Python 环境并安装依赖'; progress = 0.1;
        note('运行 wechat.ps1 Install（建 venv、装 requirements.txt）');
        const install = await run(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.script, '-Action', 'Install'], 15 * 60_000);
        if (!existsSync(paths.python)) throw new Error(`Python 环境没能建好：\n${install.out.trim() || '（没有输出）'}`);
        if (install.code !== 0) note(`Install 报错（venv 已就绪，继续）：${install.out.trim().slice(-500)}`);

        step = '编译微信原生桥'; progress = 0.4;
        if (existsSync(join(paths.engine, 'current.json'))) note('原生桥已存在，跳过编译');
        else {
          note('运行 wechat.ps1 Build（需要 Visual Studio C++ x64 构建工具）');
          const build = await run(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.script, '-Action', 'Build'], 20 * 60_000);
          if (!existsSync(join(paths.engine, 'current.json'))) {
            throw new Error(`原生桥编译失败（需要 Visual Studio 的「使用 C++ 的桌面开发」）：\n${build.out.trim().slice(-800) || '（没有输出）'}`);
          }
        }

        step = '探测本机微信账号'; progress = 0.6;
        const existing = readConfig(paths.config);
        const found = existing?.account && existing?.dbDir && existing?.selfId
          ? { account: existing.account, selfId: existing.selfId, dbDir: existing.dbDir }
          : detectWechat();
        if (!found) throw new Error('没找到本机微信数据目录：请确认微信已登录过，或设置环境变量 DSH_WORLD_WECHAT_DBDIR 指向 `xwechat_files` / `WeChat Files`');
        mkdirSync(paths.runtime, { recursive: true });
        writeFileSync(paths.config, JSON.stringify({
          account: found.account, selfId: found.selfId, dbDir: found.dbDir, moduleFile: paths.moduleFile,
          pageSize: 50, pollSeconds: 1, contextMessages: 8, chats: [],
        } satisfies AdapterConfig, null, 2), 'utf8');
        note(`账号 ${found.selfId}（目录 ${found.account}），数据目录 ${found.dbDir}`);

        step = '读取聊天列表'; progress = 0.75;
        const chats = await run(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.script, '-Action', 'Chats', '-Limit', '100'], 3 * 60_000);
        const parsed = lastJson(chats.out) as { chats?: Array<{ id: string; name: string }> } | undefined;
        if (!parsed?.chats?.length) throw new Error(`没能读到聊天列表（微信是否正在运行并已登录？）：\n${chats.out.trim().slice(-600) || '（没有输出）'}`);

        step = '写入配置'; progress = 0.9;
        // 群聊 trigger 一律 'all'：老大要的就是「不 @ 也接」。私聊不需要 trigger。
        const list = parsed.chats.map(chat => chat.id.endsWith('@chatroom')
          ? { id: chat.id, name: chat.name, trigger: 'all' as const }
          : { id: chat.id, name: chat.name });
        writeFileSync(paths.config, JSON.stringify({
          account: found.account, selfId: found.selfId, dbDir: found.dbDir, moduleFile: paths.moduleFile,
          pageSize: 50, pollSeconds: 1, contextMessages: 8, chats: list,
        } satisfies AdapterConfig, null, 2), 'utf8');
        detected = { ...found, chats: list.length };
        note(`配置已写入：${paths.config}（${list.length} 个聊天，群聊都是不 @ 也接）`);

        step = '连接微信'; progress = 0.97;
        deps.onInstalled?.();
        phase = 'ready'; step = '装好了'; progress = 1;
        note('一键安装完成。');
      } catch (cause) {
        phase = 'failed';
        error = cause instanceof Error ? cause.message : String(cause);
        step = '安装失败';
        note(`失败：${error}`);
        throw cause;
      } finally {
        finishedAt = new Date().toISOString();
        running = undefined;
      }
    })();
    return running;
  }

  return {
    paths,
    status(): WechatInstallStatus {
      return { phase, step, progress, log: [...log], ready: ready(), ...(error ? { error } : {}), ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}), ...(detected ? { detected } : {}) };
    },
    /** 面板按钮：已经在装就等它装完，装完返回状态。 */
    install(): Promise<void> { return install(); },
    get busy(): boolean { return running !== undefined; },
  };
}
export type WechatInstaller = ReturnType<typeof createWechatInstaller>;
