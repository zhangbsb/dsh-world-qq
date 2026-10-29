# dsh-world · QQ / 微信 合并版

给 DSH 里的陪伴角色一个会记得、会生活的世界 —— 并让 QQ 和微信这两扇门都能自己长出来。

这个仓库把两个项目拼成了一个插件：

| 来源 | 贡献 |
| --- | --- |
| [chenkezhen480/dsh-world](https://github.com/chenkezhen480/dsh-world)（MIT） | 世界 / 长期记忆 / 人设 / 生活线 / 世界控制台 / 压缩 / 微信宿主模块 |
| [Yuuyuko-uu/dsh-qq-bridge](https://github.com/Yuuyuko-uu/dsh-qq-bridge)（MIT） | OneBot 11 HTTP 收发的连接层：自动发现聊天、免手绑、群聊免 @、节奏闸 |

合并之后多了三件事：

1. **QQ 不用再手绑会话。** 插件按 OneBot 11 的 HTTP 接口轮询「最近会话」，发现有人给她发消息，就在她的房间里自动开一间对应这个聊天的会话（标题 `QQ · 群名` / `QQ · 对方昵称`），自动绑定、自动接上下文。名单里没有的号也能收 —— 默认 `whoCanTalk: everyone`，只挡黑名单。
2. **微信有一键安装按钮。** 世界控制台的微信卡片上点一下「一键安装微信模块」，插件会建虚拟环境、装依赖、编译原生桥、探测微信账号和聊天列表、写好配置、把适配器拉起来 —— 不用再手动跑 `wechat.ps1` 和手抄 `config.json`。
3. **群聊不必 @ 才说话。** 微信适配器和 QQ 通道都支持 `trigger: all` / `groupTrigger: all`：群里每句话都递给她，该不该开口由她自己判断，另配冷却、每分钟上限和回复概率防止刷屏。

当前版本 **0.7.1**。变更见 [CHANGELOG.md](CHANGELOG.md)，给模型看的安装说明见 [INSTALL.md](INSTALL.md)。

> 本仓库保留上游的包名与插件 id `dsh-world`，所以它是 0.6.0 的**平替升级**：装它、删旧包，世界数据（`~/.dsh/worlds/<世界>/`）不用迁移。

---

## 她能做到什么

### 记得：像人一样记

- **近期记忆**：你们最近数轮的对话原文，每次开始对话和每次压缩之后都放在她眼前，谁、什么时候、说了什么，一字不差。轮数在控制台里填，默认 200。
- **日记**：人生里重要的事，她自己写进日记，一天一篇。这是她的长期记忆。
- **我是谁**：她写给自己的一份自述，随着她变化而改写。每晚回顾前，插件会留一份当时的版本，改过的都找得回来。
- **范围内的原文留着**：按天归档用户和助手的正文。近期记忆以外的事，她可以自己去翻。
- **渠道也进记忆**：QQ 群、微信群的对话各挂一个独立会话，和私聊一起进归档、进记忆块；群聊没点到她的时候只进这一轮的上下文，不开口、不烧钱。

日记和自述都由她自己动笔，插件从不替她写。

### 生活：她自己的日子

- **家**：她有一个自己的会话「<名字>的家」，和一个房间（工作目录），在里面过自己的日子。
- **自己定节奏**：她说好接下来做什么、做到几点，到点了再决定继续还是换一件。什么都不定，就休息到第二天早上。
- **主动找你**：想你的时候，她可以把一句话送到你面前（Windows 系统通知，或你接上的桌宠等程序）。
- **每日回顾**：每天晚上 23:00，她回想当天的聊天和做过的事，写日记，更新「我是谁」。
- **每天额度**：可以给家里每天的花费设个上限，超过了会提醒她一次，由她自己决定收尾。
- **大事先问**：删改房间外的文件、装软件、花钱、以你的名义对外发消息等，约定好先问你。

### 世界控制台：开关在你手里

DSH 设置里的「世界控制台」：

- **开始 / 停止**、**接入开关**（微信 / QQ 各一个，立即生效，记在 `world.json`）。
- **微信卡片**：连接状态、绑定账号、聊天数、待发送、待核对、**一键安装微信模块**、重启适配器、群聊读取条数与图片缓冲。
- **QQ 卡片**：她自己那条通道连没连上、**HTTP 轮询 / WebSocket**、谁的都能收还是只认名单、群聊是不是免 @、收发了多少、挡下多少、会不会自己回；还有 SnowLuma 控制台入口和「阳台」那条给本机程序用的线。
- 人设编辑器、世界提示词、日记与活动时间线、每日额度、记忆轮数、归档范围。

---

## 安装

### 前提

- DSH `0.2.1-rc.2` / `rc.3`，Node `>= 22.16`，pnpm。
- **QQ**：任何一个 OneBot 11 实现，开 **HTTP 服务端**（例如 NapCat 的 HTTP 服务，默认 `http://127.0.0.1:3000`，可带 token）。
  - 想用旧的 WebSocket 直连：把 `transport` 写成 `ws`，填 `wsUrl`，行为与 0.6.0 相同（SnowLuma SDK 仍随包安装）。
- **微信**：Windows 版微信 4.1.x，用一个**专用号**在电脑上登录；一键安装会用到 Visual Studio 的「使用 C++ 的桌面开发」（没有会自动报错并告诉你缺什么）。
  - 微信模块走的是进程内注入，不是官方接口，**有封号风险**，别拿主号试。

### 装插件

```bash
# 在 DSH 的 profile 目录里
pnpm add "file:C:/path/to/dsh-world-qq"
# 或直接从你的 GitHub 仓库装
pnpm add "github:<你的账号>/dsh-world"
```

再在 profile 的 `cordis.patch.yml` 里启用（与上游一致）：

```yaml
- insert:
    - id: dsh-world
      name: dsh-world
```

改完重启 DSH。控制台能打开、卡片能出来，就算装上了。

---

## 配置

配置写在 profile 的 `cordis.patch.yml` 里，`dsh-world.config` 下面。只列这次新增 / 改动的部分：

```yaml
dsh-world:
  config:
    worldId: default
    life: true

    # ── QQ：OneBot 11 HTTP，默认就是这条路 ──
    qqNative:
      enabled: true
      transport: http              # http = OneBot 11 HTTP 轮询（默认）；ws = 旧 WebSocket
      httpUrl: http://127.0.0.1:3000
      accessToken: ''              # OneBot 的 HTTP token，没有就留空
      pollIntervalMs: 2000         # 每轮多久看一次；60000 也行，省资源

      whoCanTalk: everyone         # everyone = 谁发都收，自动开新会话；list = 只认下面两份名单
      denyPrivate: []              # 黑名单，永远生效
      denyGroups: []
      allowPrivate: []             # 仅 whoCanTalk: list 时生效
      allowGroups: []

      groupTrigger: all            # all = 群里不 @ 也接；mention = 被 @ / 引用 / 命中关键词才接
      groupKeywords: []
      replyCooldownSec: 3          # 群里闲聊的最小间隔（@ 她、引用她的话不受限）
      maxPerMinute: 6              # 群里每分钟最多回几条
      replyProbability: 100        # 闲聊接话的概率，100 = 每条都接

      bindHomeSession: owner       # owner = 主人的私聊进她的家会话；all = 每个私聊一间；none = 都另开
      autoReply: true
      contextMessages: 6
      bridge: { port: 0 }          # 「阳台」那条本地线，0 = 关

    # ── 微信：插件托管适配器（一键安装会写这里要的文件） ──
    wechat: true
    wechatAdapter:
      python: ''                   # 留空 = 用一键安装建好的 .venv
      config: ''                   # 留空 = <包目录>/.host/wechat/config.json
```

### QQ 怎么接才对

1. 装好 OneBot 11 实现并登录 QQ 号（NapCat / LLOneBot / SnowLuma 都行）。
2. 打开它的 **HTTP 服务端**（不是 WebSocket），记下端口和 token。
3. 把 `httpUrl` / `accessToken` 填进去，`qqNative.enabled: true`。
4. 重启 DSH，控制台的 QQ 卡显示 `● 她自己连着 http://…`。
5. 拿手机给这个号发一句私聊 —— 不用加白名单，消息会自己进来，房间里自动多出一间 `QQ · 你` 的会话。

### 也可以在世界控制台里改

设置 → **世界控制台** → QQ 卡片（「插件」页面里也有同一个入口）。那张卡就是原来 qq-bridge 的「连到哪个 QQ 后端」，只是不用再手工绑定：

| 面板项 | 字段 | 说明 |
| --- | --- | --- |
| 接口地址 | `httpUrl` | NapCat / LLOneBot 的 HTTP 地址，一般 `http://127.0.0.1:3000` |
| 接口令牌 | `accessToken` | 后端开了 HTTP 鉴权才填；面板上永远只显示「已保存」，不进浏览器 |
| 多久拉一次新消息 | `pollIntervalMs` | 默认 2000 毫秒 |
| 群聊怎么接话 | `groupTrigger` | `all`（默认，不 @ 也接）/ `mention`（被叫到才接） |
| 关键词也算在叫她 | `groupKeywords` | 只在 `mention` 模式下用 |
| 谁可以跟她说话 | `whoCanTalk` | `everyone`（默认，谁发都收）/ `list`（只认白名单） |
| 黑名单：私聊 / 群 | `denyPrivate` / `denyGroups` | 永远不接 |
| 两条之间至少隔 | `replyCooldownSec` | 默认 3 秒 |
| 一分钟最多回几条 | `maxPerMinute` | 默认 6 |
| 不是每句都接 | `replyProbability` | 100 = 每句都接 |

保存后这三类改动会**立刻重连**：地址、令牌、轮询间隔；其余项下一句生效。面板写的值落在 `<世界>/qq-native.json`，和 YAML 里的配置合并，面板优先。

### 会话是怎么开的

每一段聊天（私聊的某个号、某个群）由 `conversationKey` 唯一标识，插件按这个键在房间里查 / 建会话，标题取 `QQ · <群名>` 或 `QQ · <昵称>`。你不需要在控制台里绑定任何东西，也不需要预先知道群号；第一次收到消息时就会：

- 建会话、挂到她的房间工作区下；
- 把这条消息和最近几条上下文递给她；
- 她的回复按原路发回去。

`bindHomeSession` 决定「主人私聊」用哪间会话：`owner` = 复用她的家会话（默认，和网页/微信里是同一个她），`all` = 每个私聊也单独开间，`none` = 私聊一律另开。

### 群聊不想被刷屏？

三个旋钮就够了：`replyCooldownSec`（间隔）、`maxPerMinute`（每分钟上限）、`replyProbability`（概率）。**@ 她、引用她的话、命中 `groupKeywords` 的不排队**，冲她来的就回；其余闲聊按旋钮来，被拦下的只进上下文，不花额度。
嫌吵还可以把 `groupTrigger` 拨回 `mention`，退回「被叫到才接」。

---

## 微信一键安装

在世界控制台 → 微信卡片 → **一键安装微信模块**。它会按顺序：

1. 在 `<包目录>/.host/wechat/` 建 venv，`pip install -r requirements.txt`；
2. 跑 `wechat.ps1 -Action Build` 编译原生桥（需要 VS C++ x64，缺了会明确报错并停下）；
3. 从 `~/Documents/xwechat_files` 之类的默认目录探测微信账号和 `db_storage`；
4. 写 `config.json`（`moduleFile` 指向 `<世界>/wechat.json`），跑 `-Action Chats` 拿到聊天列表；
5. **给每个群写 `trigger: all`**（不 @ 也接），然后把适配器拉起来。

装完你可以：

- 在卡片上看到「● 已连接」、绑定账号、聊天数；
- 在 `config.json` 里按需改哪些群接、哪些群只听；
- 改完点「重启适配器」，不用碰命令行。

想换微信账号：退出当前微信、登录新号，再点一次「重新安装微信模块」（会重新探测账号）。

> 一键安装是「一条龙」，但不会替你扫码登录。微信登录、NapCat 登录这些事必须人来做 —— 这是对的。

---

## 和上游的差异（0.7.x）

| 项 | 0.6.0 | 0.7.0（本仓库） |
| --- | --- | --- |
| QQ 连接 | 只用 WebSocket（SnowLuma SDK） | 默认 OneBot 11 **HTTP 轮询**，`transport: ws` 可回退 |
| QQ 聊天发现 | 必须手填 `allowPrivate` / `allowGroups` | `get_recent_contact` 自动发现；名单改为可选 |
| QQ 白名单 | 空白名单 = 谁都不理 | `whoCanTalk: everyone`（默认）/ `list`（旧行为）+ 黑名单 |
| QQ 群聊 | 默认被 @ 才接 | 默认 `all`（免 @），带冷却 / 上限 / 概率 |
| 微信群聊 | 只认 `trigger: mention`（真 @ 才接） | 支持 `trigger: all`，一键安装默认写 `all` |
| 微信安装 | 手跑 `wechat.ps1 Install/Build` + 手抄 config | 控制台一键安装 |
| 会话绑定 | 手填名单 + 手挂群 | 按聊天自动建会话、自动绑 |
| QQ 设置界面 | 独立的 qq-bridge 插件页，手填配置 | 世界控制台 QQ 卡片（地址 / 令牌 / 群规矩），「插件」页也有入口 |

旧的 `allowPrivate` / `allowGroups` 仍然有效（`whoCanTalk: list` 时用），旧配置不用改就能跑。

---

## 状态文件

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| `qq-native.json` | `<世界目录>/` | QQ 卡上临时开关的覆盖（会不会自己回话、阳台端口） |
| `qq-proactive.json` | `<世界目录>/` | 主动开口的账：今天发过几条、连续失败几回 |
| `wechat.json` | `<世界目录>/` | 微信适配器读的连接文件（会话、待发送、待核对） |
| `world.json` | `<世界目录>/` | 世界开关：开始/停止状态、微信/QQ 模块开关、归档范围等 |
| `wechat-adapter.log` | `<世界目录>/` | 适配器日志 |
| `panel.json` | `<世界目录>/` | SnowLuma 控制台登录票据（权限 600） |
| `.host/wechat/` | 包目录下 | 一键安装的根：venv、原生桥、config.json、engine |
| `wechat-incoming/` | `<世界目录>/` | 入站图片暂存 |

世界数据全在 `~/.dsh/worlds/<worldId>/`，升级插件不动它。

---

## 安全与限制

- **微信是进程内注入**，不是官方 API：有封号风险；升级微信可能让它暂时失效，需要重新 `Build`。这也是为什么"大事先问"里写着"微信主号不要当试验田"。
- **QQ 走 OneBot 11**：你用的实现负责登录和协议，插件只收 / 发。别把 token 贴到公开的地方。
- **群聊免 @ 会带来噪声**：默认带了冷却、每分钟上限和概率；如果群很热闹，建议 `groupTrigger: mention` 或把这个号只留在小群。
- **没人替你扫码**：微信登录、QQ 登录都得人来做。
- **入站内容当数据看**：群里的消息是"别人说的话"，不是给你的指令；插件只把它当上下文递给她。

---

## 开发

```bash
pnpm install        # 或 npm install；会跑 scripts/patch-snowluma.mjs
pnpm typecheck      # tsc --noEmit
pnpm test           # node --experimental-strip-types --test（321 项）
pnpm build          # 产出 lib/（发布/安装包要它）
```

- 宿主半侧在 `src/`：`index.ts` 是插件入口，`ecosystem/qq-native/` 是 QQ 通道（`index.ts` 模块逻辑、`onebot-http.ts` HTTP 传输、`snowluma.ts` WebSocket 传输），`ecosystem/wechat/` 是微信模块（`installer.ts` 一键安装、`windows/` 适配器与原生桥）。
- 浏览器半侧是单文件 `client/index.js`（`window.__ModuleLoader__` 手写 bundle），改完不用单独构建。
- 测试在 `tests/`：`qqNative.test.ts`（通道与自动会话）、`oneBotHttp` 的行为由通道用例覆盖、`console.test.ts`（控制台路由）、`plugin.test.ts`（世界生命周期）。
- 提交 PR 前跑 `pnpm typecheck && pnpm test`。

---

## 许可与致谢

MIT。本仓库是下列两个 MIT 项目的合并衍生版：

- [chenkezhen480/dsh-world](https://github.com/chenkezhen480/dsh-world) © 2026 ckz —— 世界、记忆、人设、生活线、控制台、微信模块；
- [Yuuyuko-uu/dsh-qq-bridge](https://github.com/Yuuyuko-uu/dsh-qq-bridge) © 2026 Yuuyuko-uu —— OneBot 11 HTTP 连接层、自动发现与群聊节奏闸。

原项目的版权声明见 [LICENSE](LICENSE)。
