# Round-3 audit（依据《DSH_Trading_Mode 修改案3.md》§9）

- 审计日期：2026-10-10（Asia/Shanghai）
- 审计对象：`dsh-trading-mode` 0.7.0（工作树）
- 审计材料：本机已安装的 DSH（`app.asar` 二进制扫描）、插件源码全文（`lib/`、`tests/`、`.github/`）、`npm pack --dry-run` 清单、`npm run verify:install` 实测、离线套件实测
- 结论先行：修改案3 的**安全判定（P0-b）成立且必须修**；**安装路径（P0-a）的"路径 B"与 DSH 自带指引冲突，不采用**；其余 P0/P1 条目部分成立，本轮按其要求逐项落地。

## 1. 判定表（修改案3 声明 → 实测）

| # | 修改案3 的声明 | 实测结论 | 证据 |
| --- | --- | --- | --- |
| P0-a1 | README 的 `npm install` 只装 devDependencies，不是"注册插件" | **成立** | `package.json:44-60` 只有测试/校验脚本；devDeps 仅 react/react-dom/zod |
| P0-a2 | `git clone <本仓库 URL>` 是占位符，没有真实下载位置 | **成立** | 仓库未建、无远程 URL；README 安装章第 0 步为占位符 |
| P0-a3 | 需先查宿主是否支持 GitHub URL / npm 包名 / 版本锁定 | **部分成立（机制存在，本机不可端到端验证）** | DSH 自带插件开发指引只承诺 **absolute package directory**；`plugin_manager` 结果 schema 含 `registries: (string\|null)[]`、`failedAt: "registry"\|"spec-host"`、`not-found`、`no-matching-version`、`integrity`、`incompatible: [{name,version,runtimeVersion,peers}]` → 说明存在 registry/spec-host 解析、版本匹配、完整性校验与 peer 兼容检查。本插件未发布到任何 registry，故该路径**无从实测**，按"未验证"处理 |
| P0-a4 | 路径 B（仓库自带 Node CLI 写 profile）可作为兜底 | **不采用：与宿主指引冲突** | DSH 自带指引原文："**Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the profile directory: `install_bundle` performs those steps**"，且每次工作区外写入需单独审批。自写 profile 安装器会重复宿主机制并绕过其完整性/peer 检查 |
| P0-b | `connection` 缺失时 API 应默认拒绝，现状不是 | **成立：现状 fail open** | `lib/trading/api.js:245-266` 有三处 `return undefined`（无 `connection`、无 `requestRejection` 方法、调用抛错），只有入站配额兜底 |
| P0-b2 | 宿主是否真的提供同源围栏 | **是（已证实）** | `app.asar` 内 `ConnectionService` 实现：`requestRejection(request){ if (!isTrustedApiRequest(request, this.trustedHosts)) return 403; return this.browserAuth.isAuthenticated(request) ? void 0 : 401; }`，另有 `admit(request)` → `{ peer: this.operator }` / `{ rejection }`。→ fail closed 在正常 DSH 上安全 |
| P0-c1 | 发布物清单需确认无缓存/个人路径/profile 状态/密钥 | **部分成立（已有检查，需固化）** | `npm pack --dry-run` = 65 files / 1 025 589 bytes；`repo.test.mjs` 有卫生扫描；离"从最终工件做冒烟"还差一步 |
| P0-c2 | CI 应在干净环境 `npm ci` + `test:release` 并保留结果 | **不成立：无 lockfile，CI 无法 `npm ci`，且从未运行** | `.github/workflows/ci.yml:22` 自述"no lockfile, so there is no `npm ci` step"；无远程仓库 ⇒ 该 workflow 从未在 GitHub 上运行，不能当作跨平台证据 |
| P0-d | 逐源合规需记录条款链接/复用范围/第三方客户端许可 | **部分成立** | `docs/DATA_COMPLIANCE.md` 有 9 家审计表 + 逐源发布决策 + TradingView 节，但缺**条款 URL 列**、**再利用范围**、**第三方开源客户端是否被允许**与 **MIT 范围声明** |
| P1⑤ | freshness 的 `live` 可能被读成"实时授权" | **成立** | `lib/trading/sessions.js:88` `note: 'live'`；`lib/trading/ai.js:604` `grade = 'live'`；`lib/client.js:1266` 判 `!== 'live'`；`lib/trading/config.js:509 liveMaxAgeMs` |
| P1⑦ | 匿名 User ID 缺失时可能所有人共用一个 ID | **成立** | `lib/index.js:229-239 resolveUserId()` 失败即回落 `DEFAULT_USER`；`lib/trading/config.js:556 DEFAULT_USER = 'local'`；`lib/trading/api.js:119-126 safeUserId()` 同样回落 `'local'` ⇒ 同进程内所有浏览器共用一个存储桶 |
| P1⑨ | Node `>=20` 是声明而非实测结论 | **成立** | 仅 Node v24.15.0 + DSH 0.2.0-rc.2 实测；CI 矩阵 20/22 未运行 |
| P1⑩ | 日股能力不足不应与其它市场并列 | **成立（README 已有部分标注，需再收紧）** | `MARKET_DATA_CONFIG.JP = ['eastmoney','tencent']`，无独立目录/指数源 |

## 2. 采用方案与理由

1. **安装路径（P0-a）：路径 A + 只读检测 + 工件冒烟。** README 只给已实测的写法 —— 拿到目录后 `plugin_manager({action:"install_bundle", target:"<绝对目录>"})`；profile 由"当前运行的 DSH"决定，不手改 profile。仓库另提供两个**只读/工作区外**脚本：`npm run verify:install`（检测当前 profile 是否已装本插件、版本是否一致、客户端 bundle 是否加载）与 `npm run release:artifact`（打包 → SHA-256 → 在临时目录安装**该工件**并加载，验证升级/卸载）。远程安装（npm/GitHub）在发布并实测前**不写进文档**。
2. **围栏（P0-b）：默认 fail closed。** 宿主围栏缺失或抛错 → `503 HOST_SECURITY_UNAVAILABLE`；仅保留一个不触上游、不含用户数据/路径/配置的 `GET /api/trading/health`；本机调试例外必须显式开启（`security.allowUnfencedLoopback: true`）、只对回环地址生效、启动时高亮告警、默认关闭。
3. **身份（P1⑦）：不再静默共用 `local`。** 身份解析顺序：宿主 `@deepseek-ai/dsh-anonymous-user-id` → 显式配置的具名本地桶（`identity.localBucket`）→ **无身份**。无身份时读市场数据仍可用，但所有**写**用户数据（自选/偏好）与按用户计量的路径返回 `503 NO_IDENTITY`，并把 `identity` 来源暴露在 `/status`。
4. **时效措辞（P1⑤）：`live` → `fresh`。** 内部 grade/note 改名，UI 字典同步；"无实时授权不显示实时"由客户端与测试共同保证。
5. **发布物（P0-c）：lockfile + `npm ci` + 工件冒烟 + 结果留存。** 新增 `package-lock.json`、CI 步骤改为 `npm ci`、新增 `npm run release:artifact`，CI 上传门禁输出。
6. **合规（P0-d）：只写真链接。** 未能核实的条款写 `not verified` + 检索词 + 日期，不猜测 URL；补再利用范围与第三方开源客户端列，并声明 MIT 只覆盖本项目源码。

## 3. 本轮不做的事

- 不新增交易功能、不新增市场（修改案3 明确禁止）。
- 不改动 README 以外的产品定位；不动 provider 端点与缓存 TTL 的既有取值。
- 不发布到任何 registry、不创建远程仓库（需要用户侧动作）。
- 不生成"界面截图"占位图或 AI 宣传图；截图为真实截图政策 + 采集清单。

## 4. 无法在本机验证、必须在用户侧完成的事项

1. 公开下载位置（GitHub/registry）与远程安装路径的端到端验证 —— 需要真实仓库与发布。
2. 干净机器/全新 profile 的 3–5 步安装验收（`docs/RELEASE_CHECKLIST.md` §7）。
3. CI 的首次真实运行（Node 20/22 矩阵、`npm ci`、工件冒烟）。
4. 九家上游条款的人工核实（本审计只做"是否已记录 + 是否有链接"的结构检查，不做法律判断）。
5. 真实界面截图与 2–3 名外部试用者反馈。

## 5. 实施回填（收尾时按实际交付修正）

- 上文 §2 里预写的脚本名 `npm run release:artifact` 最终实现为 **`npm run smoke:artifact`**（`scripts/smoke-artifact.mjs`）。
  它**不安装、不加载** tarball：打包到系统临时目录后读 tar 头与校验和、核对必需成员、扫描机器路径、
  对打包的 `lib/**/*.js` 跑 `node --check`，末行打印 `SHIPPABLE` 与 tarball `sha256`。
  「在临时 profile 里安装该工件」这一步没有自动化，保留为手工步骤（`docs/RELEASE_CHECKLIST.md` §6/§7）。
- `npm ci` 必须带 `--legacy-peer-deps`（`@deepseek-ai/*` peer 只存在于 DSH 运行时，公共 registry 上没有 packument）。
- 离线套件 10 → **13**（新增 `fence` / `identity` / `release-scripts`），实测 `13 passed, 0 failed, 0 skipped`。
