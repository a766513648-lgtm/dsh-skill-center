# @suifengshiqu/skill-center

[English](README.md) · **简体中文**

**技能中心（Skill Center）** 给 DSH 的 Web 客户端增加一个页面：查看 DSH 能从你自己的目录里加载的全部技能、阅读某一个、开关它、新建一个、按链接安装一个，以及把技能删除到可恢复的回收站。

这是一个第三方 DSH 插件，不是 DeepSeek 官方产品。以 [MIT 许可证](LICENSE) 发布。

![技能中心面板，悬浮在输入框之上](docs/shots/list.png)

## 界面截图

| | |
| --- | --- |
| ![技能列表](docs/shots/list.png) | ![新建技能](docs/shots/create.png) |
| **列表**——DSH 能加载的每个技能，附开关、来源与问题提示。上方那一行用来粘贴链接。 | **新建**——名称、简介和正文，写入你选定的位置。 |
| ![回收站](docs/shots/trash.png) | ![删除确认](docs/shots/confirm.png) |
| **回收站**——删掉了什么、原来在哪，以及一个按钮把它放回去。 | **删除**——确认框明确写着技能会进回收站，因为"可恢复的删除"和"抹掉"是两回事。 |

截图是用**实际发布的浏览器产物**渲染在宿主自己的 `Modal` 样式表之上得到的，所以布局、配色和滚动条都与真实应用一致，只是去掉了周围的应用程序窗口。`scripts/dev/render-shots.mjs` 可以重新生成，深浅两种主题都支持。

## 出现在哪里

两个入口，共用同一份状态，打开的是同一个页面：

- **设置 → 技能中心**——作为设置分区，和其余配置放在一起。
- **输入框里的「技能」按钮**，位于权限芯片旁边的那一行。它以弹窗打开页面，适合在处理任务途中快速开关某个技能。

这个按钮位于 `conversation.input.left`。那是插件唯一可以扩展的输入框位置：权限芯片（`conversation.input.permission`）和模型选择器（`conversation.input.model`）是**单占席**，已被各自的插件占用，因此无法插在它们中间。这个按钮也无法深链到自己的设置分区——`openSection` 是设置外壳内部的——所以它直接打开页面。

两个入口都跟随宿主的主题：

![同一个面板在浅色主题下](docs/shots/list-light.png)

## 它能做什么

- **列出** `$DSH_HOME/skills`（默认 `~/.dsh/skills`）、profile 通过 `customSkillDirs` 添加的目录，以及当前项目的 `<project>/.dsh/skills` 中的所有技能。
- **查看详情**：简介、路径、frontmatter 块与指令正文。
- **搜索**名称或简介，并可隐藏已关闭的技能。
- **开关技能**且不丢失内容：文件里的其他一切，包括你自己写的 frontmatter 键，都原样保留。
- **新建技能**：填写名称、简介和正文。
- **按链接安装技能**——GitHub 仓库、仓库内的 `/tree/` 路径、`.zip`，或单个 `SKILL.md`。
- **把技能删除到回收站**，并可从回收站恢复。
- **选择新技能的写入位置**——位置控件列出 profile 提供的全部目录，宿主不接受其他任何路径。
- **报告宿主会静默跳过的问题**，例如缺少 `description`，或名称不是 kebab-case。
- 跟随宿主的浅色或深色主题。

### 新技能写到哪

可选位置来自**宿主**而非面板：`GET /roots` 返回 profile 配置的 `customSkillDirs`，其后是默认的 `$DSH_HOME/skills`。浏览器提供的正是这份清单，而 `POST /create` 与 `POST /install` 会拒绝清单之外的目录——所以"选择写入位置"不会变成"写到任何地方"。只有一个位置时，控件显示为一行文字；有多个时，每个位置一个按钮，因为**路径本身就是这个控件的意义**。

### 删除被允许触及的范围

删除用户自己写的东西是这里唯一的破坏性操作，因此它被严格限定：

- **只删 DSH 自己的技能。** 回收站覆盖全局根目录（DSH 主目录与任何 `customSkillDirs`）。项目根目录——`<project>/.dsh/skills`，受版本控制管理——**永不触碰**：技能中心可以开关这样的技能，但不会把它从仓库中移走。
- **只删 DSH 确实能加载的技能。** frontmatter 有问题的技能可能是被误读了，这是**不动它**的理由，而不是移动它的理由。
- **绝不穿过链接。** 符号链接，或 Windows 的 junction（`lstat` 把它报告为普通目录），都会因为解析后的路径与请求的路径不一致而被拒绝。
- **绝不是单纯抹掉。** 目录包被**移动**到 `~/.dsh/skill-center/trash`，并记录它来自哪里，面板可以逐字节放回。清空回收站是另一个需要确认的操作。
- **绝不半途而废。** 所有校验都在任何移动之前完成，无法记录的移动会被回滚。由于 `rename` 不能跨卷，失败的移动会退化为"复制后删除"——**先复制**，所以失败时原文件仍在。

### 按链接安装会做什么、不会做什么

下载内容被当作**敌意输入**处理：条目路径不得逃出目标目录；一个技能包必须有 `SKILL.md`，且名称能被 DSH 接受、简介是 DSH 要求的；已存在的名称会被拒绝而非覆盖；上述检查全部通过之前**不写入任何内容**。加密压缩包与 Zip64 会被拒绝。指向本机的链接（`localhost`、`127.0.0.1`、`.local`）不会被抓取，单次下载上限为 8 MB 与 800 个条目。

### 会被识别的目录结构

与宿主自己的文件系统提供方**完全一致**：一个技能是目录包 `<名称>/SKILL.md`，或平铺文件 `<名称>.md`，且位于**技能根目录的顶层**。嵌套的 `**/SKILL.md` 是**故意不识别**的。

从 GitHub 下载安装时会碰到这一点：仓库 ZIP 解压后是一个文件夹，把**那个**文件夹整体复制进 `~/.dsh/skills`，会让每个技能包都多出一层，DSH 和本面板都找不到。要把技能包文件夹本身放进技能根目录。

## 它不做什么

- 不处理其他 Agent 的目录（Claude Code、Codex、Cursor……）。
- 不做 Git 仓库管理，没有技能市场，不自动更新。
- 不创建或导入技能（除了上面的按链接安装）。
- 不读取或写入上述根目录之外的任何东西。

## 关闭技能的原理

技能中心把 DSH 文件系统提供方**本来就认识**的两个开关写进技能自己的 frontmatter：

```yaml
---
name: my-skill
description: What it is for.
disable-model-invocation: true
user-invocable: false
---
```

重新开启时会**精确删除这两个键**，逐字节还原文档。由于这些开关就在文件里：

- 状态**能跨重启保留**，且对任何其他工具可见；
- 技能会从模型清单和 `/` 菜单中消失，但**仍留在磁盘上**；
- 写入中断**不会留下半截文档**——文件是原子替换的。

frontmatter 无法解析的技能会被列出并附上诊断，且开关被禁用，因此技能中心**绝不重写它不理解的文档**。

## 环境要求

- 带 Web 客户端的 DeepSeek Harness（针对 `0.2.0-rc.2` 测试）。
- Node.js `^22.19.0 || >=24.0.0`。

## 安装

从 npm 安装，机器上只需要有 DSH：

```powershell
dsh plugin --profile <你的 profile> add @suifengshiqu/skill-center
```

从源码安装（如果你想改动它）：

```powershell
git clone https://github.com/a766513648-lgtm/dsh-skill-center.git
cd dsh-skill-center
npm install
npm run verify                   # 类型检查、构建、测试
dsh plugin --profile <你的 profile> add .
```

或从你自己打的包安装：

```powershell
npm pack
dsh plugin --profile <你的 profile> add .\suifengshiqu-skill-center-0.1.0.tgz
```

然后**重启 DSH**——宿主那一半只在启动时加载一次，仅刷新页面不够——再打开**设置 → 技能中心**。

> **用 git 地址直接安装是行不通的**：pnpm 默认拒绝运行依赖的构建脚本，而 npm 路线之所以可行，正是因为发布的包里已经带有构建好的 `lib/`。请使用 registry，或自行克隆构建。

> 客户端那一半以 immutable 缓存头提供，其 URL 取决于包的修改时间。因此重装同一版本后，浏览器里可能仍是旧页面；强制刷新（`Ctrl+Shift+R`）或完全重启应用即可取到新的。

## 开发

```
src/
  index.ts              宿主半边：浏览器 API + 开关闸门提供方
  contract.ts           两半共用的请求/响应类型
  core/parse.ts         frontmatter 读取与诊断
  core/scan.ts          发现每一个技能根目录
  core/store.ts         持久化的开关状态（原子 JSON）
  core/toggle.ts        frontmatter 改写
  core/trash.ts         删除与恢复，及其边界守卫
  core/zip.ts           极简 ZIP 读取器（stored 与 deflate 条目）
  core/install.ts       从网址安装技能
  client/index.ts       浏览器半边：注册设置页与按钮
  client/store.ts       面板状态与宿主调用
  client/SkillCenterSection.tsx   页面本体
  client/scrollStyles.ts          列表滚动条样式表
  client/locales.ts     英文与简体中文文案
scripts/
  build.mjs             转译并打包两半
  test.mjs              在单个进程里跑全部测试
  dev/                  有用但不参与构建的工具
    probe-host.mjs      在桩上下文里挂载宿主半边，报告它调用了什么
    probe-app.mjs       在真实的 cordis 应用上挂载插件
    variant.mjs         在浏览器半边的真实版与最小版之间切换
    reinstall.ps1       一步完成构建、打包并安装到 DSH profile
    check-install.mjs   把已安装副本与本地构建做哈希比对
    check-install-live.mts  用真实公开网址安装，验证现实而非桩件
    run-one.mjs         用同一套转译器运行单个 `.mts` 探针
    render-shots.mjs    渲染 README 用的界面截图（深浅两主题）
    set-about.mjs       设置仓库的 About 描述与 topics
    strip-bom.mjs       清除文本文件里的 UTF-8 BOM
    ci-failures.mjs     打印最近一次 CI 失败的断言
test/                   单元、构建与端到端测试
variants/               `variant.mjs` 切换的两个浏览器半边源码
```

`lib/` 是生成产物；改动 `src/` 之后执行 `npm run build`。

`.npmrc` 与本机相关，不纳入版本库；`.npmrc.example` 说明它包含什么、何时需要。

### 向其他插件的插槽投稿

`settings.section` 与 `conversation.input.left` 由**其他插件**声明，不是本插件。直接调用 `slots.register` 会与声明方竞争：谁先激活，谁就抛 `slot "settings.section" is not declared (a parent entry's children table must declare it)`。这个失败是**间歇性**的（取决于激活顺序），而客户端插件加载器只把它报告为 `<name>: failed`，原因只进浏览器控制台。务必经由 `slots.inject`——它会等待声明出现、在声明变化时重跑，并在声明方消失时撤下贡献：

```ts
ctx.slots.inject('settings.section', () =>
  ctx.slots.register({ name: 'settings.section', id: 'skill-center', /* … */ }, SkillCenterSection),
);
```

间歇性恰恰是最糟的部分：本插件若碰巧在设置外壳之后激活就一切正常，而客户端插件加载器对失败条目只报 `<name>: failed`，不给原因——原因进了浏览器控制台。现在有两道防线：

- 浏览器半边是**防御式**的：每一步都被守卫，失败会 POST 到
  `/api/skill-center/client-report`，由宿主写入 stderr，于是桌面日志里能看到真实消息；
- `test/clientBundle.test.mts` 断言该贡献经由 `slots.inject`，并且它的 `slots` 桩件**不会急切执行回调**——急切执行的桩件恰好会掩盖这个竞态。

### 诊断"插件不激活"

加载失败的插件几乎不留痕迹：桌面只报告 *"N entries did not activate"*，附带一句 `<name>: failed`，完整原因从不进日志。这些工具可以回答它：

```powershell
node scripts/dev/probe-host.mjs <lib/index.js 路径>   # apply() 会抛错吗？它调用了什么？
node scripts/dev/probe-app.mjs  <lib/index.js 路径>   # 插件能在真实 cordis 应用上挂载吗？
node scripts/dev/variant.mjs minimal                  # 换成只报告"是否加载成功"的极简页面
```

`probe-host.mjs` 抓 API 误用；`probe-app.mjs` 抓模块形状与挂载语义问题；`minimal` 变体把"客户端模块机制无法加载这个包"与"页面自身失败"区分开。`variants/` 保存两个浏览器半边，`scripts/dev/reinstall.ps1 -Variant minimal` 会构建、打包并安装其中一个。

### 为什么构建不使用打包器

本项目的开发沙箱拒绝带管道 stdio 的 `spawn`，而那正是 esbuild 的 JavaScript API 启动其原生服务的方式。因此构建使用**进程内的 TypeScript 编译器**，把每个模块转译为 CommonJS 并产出：

- `lib/index.js`——宿主用的单个 CommonJS 文件，并由 `lib/package.json` 标注该目录，使包自身的 `"type": "module"` 不会让 Node 把它当作 ESM 解析；
- `lib/client.js`——Web 客户端模块系统格式的单个惰性工厂，内含模块表，宿主共享库经由外壳的 import map 解析。

### 产物必须遵守的两条规则

两条都是踩坑后学到的，且都由 `test/build.test.mts` 强制：

1. **不得在运行时 `require` 宿主包。** 插件是独立安装的，宿主的包不在它的解析路径上。一行仅为类型增强而加的副作用 `import '@deepseek-ai/dsh-host-webserver'` 会在打包后存活，让整个插件导入失败——设置里**一个页面都不会出现**。仅为类型而存在的导入必须写成 `import type`，TypeScript 会把它擦除。
2. **浏览器半边只能 require `dsh.client.external` 中声明的库。** 其他任何东西要么被打进包里（第二份 React，会让 hooks 失效），要么解析为 `undefined`。

### 日志

宿主半边在**启动时向 stderr 写一行**，除此之外只在失败时输出（带堆栈）。那一行是关键：加载器对激活失败的插件只报 `<name>: failed`，别无其他，没有这行，坏掉的挂载就是隐形的。浏览器半边通过 `/api/skill-center/client-report` 把自身的失败报给宿主，进入同一份日志；成功时它什么都不说。

## 许可证

MIT。
