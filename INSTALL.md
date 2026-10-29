# 交给她的安装说明（0.7.1 合并版）

这份文件不是给人看的，是给 **DSH 里的陪伴角色**看的：谁把仓库地址发过来，谁就照着这份说明，把 `dsh-world` 装进 DSH、把 QQ 和微信接上，最后让 QQ / 微信里的她和人说话。

0.7.1 先说清两条边界：

- **QQ 走 OneBot 11 的 HTTP 接口**（和 `dsh-qq-bridge` 同一条路）。插件自己轮询、自己收发，不需要第二个桥进程；你只需要一个登录着 QQ 号的 OneBot 实现（NapCat / LLOneBot / SnowLuma 都行）把 **HTTP 服务端**开出来。旧配置里的 `wsUrl` 不是必填了。
- **微信有「一键安装」**：控制台里点一下，剩下的（建 venv、装依赖、编原生桥、探账号、写配置、起适配器）插件自己做。只有**扫码 / 登录**这一步永远是人做的。

一句话说清边界：**登录账号这一步只有人能做，其余步骤你自己做。**

---

## 第零步：先摸清四件事

| 要知道的 | 怎么查 |
|---|---|
| `DSH_HOME` | Windows 默认 `C:\Users\<用户名>\.dsh`；看目录里有没有 `profiles`、`worlds` |
| 用哪个 profile | 列 `<DSH_HOME>/profiles/` 下的目录，挑 `package.json` 里 `dependencies` 有你正在跑的那些插件的那个 |
| node 版本 | `node -v`，必须 ≥ 22.16（dsh-world 的要求） |
| pnpm 在哪 | 先试 `pnpm -v`；没有就用 DSH 自带的：`<DSH 安装目录>\resources\runtime\x64\primary-runtime\dependencies\pnpm\bin\pnpm.cjs`，用 `node <那个 pnpm.cjs> <命令>` 调用 |

---

## 第一步：装插件

两种方式，挑一种：

**A. 本地目录（推荐给「我就是源码」的场景）**

```powershell
cd <profile 目录>
node <pnpm.cjs> add "file:C:/path/to/dsh-world-qq" --config.confirmModulesPurge=false
```

**B. 从 GitHub 装**

```powershell
cd <profile 目录>
node <pnpm.cjs> add "github:<账号>/<仓库>"
```

装完检查三件事：

1. `<profile>/node_modules/dsh-world/package.json` 里 `"version"` 是 `0.7.1`；
2. `<profile>/node_modules/dsh-world/lib/ecosystem/qq-native/onebot-http.js` 存在（有它才是合并版）；
3. `<profile>/cordis.patch.yml` 里有一段：

```yaml
- insert:
    - id: dsh-world
      name: dsh-world
```

改完重启 DSH。**世界数据在 `~/.dsh/worlds/<worldId>/`，升级插件不动它。**

---

## 第二步：把配置写好

配置在 profile 的 `cordis.patch.yml`，`dsh-world.config` 下面。**先照抄这一段**，真值第三步再填：

```yaml
dsh-world:
  config:
    worldId: default
    life: true

    qqNative:
      enabled: true
      transport: http
      httpUrl: http://127.0.0.1:3000   # OneBot 的 HTTP 服务地址（不是 WS）
      accessToken: ''                  # 有 token 就填，没有留空
      pollIntervalMs: 2000

      whoCanTalk: everyone             # 谁发都收，自动开新会话
      denyPrivate: []
      denyGroups: []
      allowPrivate: []                 # 只有 whoCanTalk: list 时用
      allowGroups: []

      groupTrigger: all                # 群里不 @ 也接
      groupKeywords: []
      replyCooldownSec: 3
      maxPerMinute: 6
      replyProbability: 100

      bindHomeSession: owner
      autoReply: true
      contextMessages: 6
      bridge: { port: 0 }

    wechat: true
    wechatAdapter:
      python: ''
      config: ''
```

> 先不要手填微信的 python / config —— 一键安装会写它们该指向的东西。

---

## 第三步：接 QQ（人做登录，你做验证）

### 3.1 人那边

1. 装一个 OneBot 11 实现并登录 QQ 号（NapCat 最简单）；
2. 在它的设置里开 **HTTP 服务端**，记下端口（NapCat 默认 `3000`）和 token（没有就空着）；
3. 把端口 / token 告诉你。

> `wsUrl` 还能用：`transport: ws` + `wsUrl` 就是 0.6.0 的老路（SnowLuma 的 WebSocket 服务端）。两条路任选，不用都开。

### 3.2 你这边

1. 把 `httpUrl` / `accessToken` 填好，重启 DSH——或者不碰 YAML，在世界控制台 → QQ 卡片上填同样几项（面板优先，地址 / 令牌 / 轮询间隔保存即重连）；
2. 打开 `/dsh-world/qq/native`，应返回 JSON：`transport: 'http'`、`connected: true`、`url` 是你填的地址；
3. 让手机给这个号发一句私聊 —— **不需要任何白名单**，消息应该自己进来；
4. 打开 `/dsh-world/console/snapshot`，`native.conversations` 应大于 0；世界房间目录下会多出一间 `QQ · <昵称>` 的会话；
5. 她回一句话，手机上能收到，`native.sent` 加一。

群聊验证：随便拉个群，把她拉进去，发一句话 —— 不用 @。她该接就接，`groupTrigger: all` 生效。嫌吵就把 `replyCooldownSec` / `maxPerMinute` 调小上限，或把 `groupTrigger` 拨回 `mention`。

---

## 第四步：微信一键安装

在世界控制台 → 微信卡片 → 点「一键安装微信模块」。它会：

1. 在 `<包目录>/.host/wechat/` 建 venv 并装依赖；
2. 编译原生桥（需要 VS C++ x64，缺了会停下并报错）；
3. 探测微信账号（默认 `~/Documents/xwechat_files`，可用环境变量 `DSH_WORLD_WECHAT_DBDIR` 指别处）；
4. 写 `config.json`、跑 `-Action Chats` 拿聊天列表，**给每个群写 `trigger: all`**；
5. 把适配器拉起来。

进度在卡片上实时显示（步骤 + 百分比 + 最近三行日志）。装完状态是「● 已连接」。

**还是得人做的一件事**：微信本身要在这台电脑上登录（专用号，别用主号）。

装完再检查：

- `<包目录>/.host/wechat/.venv/Scripts/python.exe` 存在；
- `<包目录>/.host/wechat/config.json` 里 `moduleFile` 指向 `<世界目录>/wechat.json`；
- 控制台微信卡片：「● 已连接」+ 绑定账号 + 聊天数。

---

## 第五步：总验证

| 检查 | 命令 / 位置 | 期望 |
|---|---|---|
| 插件加载 | `http://127.0.0.1:<DSH 端口>/dsh-world/console/snapshot` | 有 `worldId`、`life`、`native` |
| QQ 通了 | `/dsh-world/qq/native` | `connected: true`，`transport: 'http'` |
| QQ 自动会话 | 上面同一份 JSON | `conversations` 涨，房间目录出现 `QQ · …` 会话 |
| 微信群聊免 @ | 微信群里不 @ 发一句 | 她接话（或按冷却 / 概率偶尔不接） |
| 微信一键安装 | 控制台微信卡片 | 按钮可用、状态「● 已连接」 |
| 模块开关 | 「接入」卡片 | 关 QQ → 断开、QQ 卡收起来；再开 → 回来 |

---

## 排错

| 现象 | 原因 / 办法 |
|---|---|
| QQ 卡写「HTTP 请求失败」 | `httpUrl` 是 OneBot 的 **HTTP** 端口，不是 WebSocket；确认那服务真在跑（浏览器 / curl 打一下 `http://127.0.0.1:3000/get_login_info`） |
| QQ 卡 `connected: false`，`lastError` 401 | `accessToken` 不对；看 OneBot 那边的 HTTP 配置 |
| 私聊发了没反应 | 看 `blocked` 有没有涨：涨了说明被 `denyPrivate` 挡了；没涨看 `lastEventAt` 有没有动（没动说明没收到，查轮询地址） |
| 群里不接话 | `groupTrigger` 是不是 `mention`；`replyProbability` 是不是小于 100 被掷骰子挡了；`maxPerMinute` 是不是到顶了 |
| 群里太吵 | 调小句数 / 提高冷却 / 拨回 `mention` |
| 微信群聊只回 @ | 那个群在 `config.json` 里还是旧值；重跑一键安装（会统一写 `all`）或手改 `trigger: all` 后重启适配器 |
| 一键安装卡在 Build | 没装 VS「使用 C++ 的桌面开发」；装完再点一次 |
| 一键安装探测不到微信账号 | 微信没登录 / 不是 4.1.x；用 `DSH_WORLD_WECHAT_DBDIR` 指到 `xwechat_files` 那个目录 |
| 收不到微信消息 | 适配器日志 `<世界目录>/wechat-adapter.log` 最后 30 行；卡片上「适配器已断开」就先点重启 |

---

## 收尾

对拿这台机器的人说一句：

> 装好了。以后重启电脑只要两件事：DSH 起来（QQ 通道和微信适配器跟着生活线一起起）、OneBot / 微信自己重连。除非换号，否则不用再扫码、不用再手绑会话。

然后把这一次做了什么、卡在哪一步、最后怎么过的，写进你自己的笔记里 —— 下次升级再摸一遍时，能省一半时间。
