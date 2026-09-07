# 小红书舆情监控助手

一个面向品牌舆情监控的 Chrome Manifest V3 扩展与 Windows 本地 Bridge。扩展读取当前小红书页面已加载的 DOM，采集帖子、评论、图片和视频，并幂等写入本地 UTF-8 CSV 与 SQLite。

公开版版本：`0.34.0`

## 公开版说明

- 仓库不包含任何具体品牌名称、产品词、账号词、本机目录、Cookie、API Key 或业务数据。
- 首次安装后，请在本机配置自己的品牌词库；私有词库与运行数据均被 `.gitignore` 排除。
- 所有采集结果默认只保存在本机，Bridge 仅监听 `127.0.0.1:17881`。
- 扩展不申请 Cookie、`webRequest` 等权限，也不调用小红书隐藏接口。

## 主要功能

- 当前页面帖子核对与增量扫描。
- 帖子正文、一级/二级评论、图片与视频素材采集。
- CSV / SQLite 幂等写入、严格按笔记 ID 去重。
- 已拉取帖子评论增量同步与全库巡检。
- 数据体检、同步变更中心、重点帖子观察名单与近 7 天周报。
- 可选 DeepSeek：品牌相关性判断、正文与评论总结、评论回复建议。
- 侧边栏与详情页磁吸 Process 面板。

## 环境要求

- Windows 10/11
- Chrome 114+
- Python 3.10+

## 直接 Clone 与安装

```powershell
git clone https://github.com/TianLongLuo/xhs-monitor-assistant.git
cd xhs-monitor-assistant
pip install -r bridge/requirements.txt
```

1. 打开 `chrome://extensions` 并启用“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择仓库中的 `extension` 目录。
3. 双击 `setup.cmd`，按向导完成 Native Messaging 注册。
4. 回到扩展管理页点击“重新加载”，然后刷新已打开的小红书页面。

详细安装与故障排查见 [使用说明.md](使用说明.md)。

## 配置品牌词库

安装向导会根据示例在本机生成：

```text
bridge/data/relevance_keywords.json
```

示例格式：

```json
{
  "brand": ["品牌名", "品牌别名"],
  "products": ["产品名 A", "产品名 B"],
  "accounts": ["官方账号名"]
}
```

也可以编辑 `extension/relevance.js` 中的公开占位词，或通过本地 Bridge 维护私有词库。

## 目录结构

```text
extension/                         Chrome 扩展
bridge/
  server.py                       本地 HTTP Bridge
  native_host.py                  Native Messaging 入口
  build_native_host.ps1           构建 Native Host
  install_native_host.ps1         注册扩展 ID
  uninstall_native_host.ps1       移除注册
  relevance_keywords.example.json 词库示例
data/                              运行时生成，不提交
setup.ps1 / setup.cmd              一键安装向导
使用说明.md
```

## 手动安装 Native Host

```powershell
powershell -ExecutionPolicy Bypass -File bridge/build_native_host.ps1
powershell -ExecutionPolicy Bypass -File bridge/install_native_host.ps1 -ExtensionId "你的32位插件ID"
```

如需导入已有笔记 CSV：

```powershell
powershell -ExecutionPolicy Bypass -File bridge/install_native_host.ps1 \
  -ExtensionId "你的32位插件ID" \
  -SeedCsv (Join-Path $PWD "data/notes.csv")
```

评论 CSV 会在同目录自动创建。旧版 `-SeedXlsx` 可用于一次性迁移。

## 本地数据与隐私

以下内容默认不进入 Git：

- `bridge/data/`
- SQLite 数据库
- 笔记与评论 CSV
- 素材目录
- AI 设置与加密后的 API Key
- 本机 Native Messaging 清单
- 私有品牌词库

## 常用本地 API

```text
GET  /api/health
GET  /api/stats
GET  /api/notes
GET  /api/comments
GET  /api/relevance
POST /api/scan
POST /api/pull
POST /api/comments/upsert
POST /api/ai/test
POST /api/ai/analyze
POST /api/data-health/repair-relations
```

## 卸载 Native Host

```powershell
powershell -ExecutionPolicy Bypass -File bridge/uninstall_native_host.ps1
```

## 0.34.0：本地语义检索与数据总览

帖子与评论数据库新增语义检索、四个快捷主题、原文证据及历史删除状态。普通关键词搜索保持默认；快捷主题仅填入查询，点击“搜索”或按 Enter 才提交，切换表或刷新后不会自动执行语义查询。

### 安装可选的本地模型

基础安装仍使用 `bridge/requirements.txt` 与原 Native Host 安装流程。语义检索另需 Python 3.10+（建议 3.11）及其可用的 PyTorch 环境。在仓库根目录使用同一个 Python 执行：

```powershell
python -m pip install -r bridge/requirements-semantic.txt
python bridge/setup_semantic.py
```

安装器下载固定修订的公开模型至 `bridge/models/` 并在 `bridge/semantic_runtime.json` 写入本机解释器路径。它们由本机生成，均不提交。运行时离线编码、不额外开放端口；Native Host 不打包 Torch，通过管道调用 `bridge/semantic_worker.py`。迁移电脑或 Python 环境后重新安装，不复制别人的运行时配置。完整流程见 [本地语义检索说明](bridge/SEMANTIC_SEARCH.md)。

升级时重新构建并注册 Native Host，重新加载扩展。旧后端未返回 `semantic.mode=embedding` 时，前端明确要求升级并重启 0.34.0，不把关键词命中冒充语义结果。模型、exe、CSV、数据库、索引与缓存均不在源码包内。

### 使用与分数解释

- 一致性校验通过后，选择数据库，打开“语义检索”，输入查询或选择“差评 / 强硬销售 / 价格差异 / 过敏”，然后提交。
- 默认综合相关度阈值 0.50，最多 200 条；界面按后端实际返回值显示阈值与上限。这是截断后的命中数，不是全库命中总量。
- 综合排序分以 0–100 刻度显示，不是百分比或置信度；原始 cosine 在分数的悬停提示中单独显示。快捷主题结合已有情绪标签重排，自定义查询使用向量分数。系统不据此新增情绪标签或认定产品致敏。
- 证据明确区分“帖子正文 / 评论 / 已删除评论”。引用历史已删除评论不表示评论仍在线。
- 语义模式暂停手动排序与楼层合并，保留原偏好；草稿未提交时清空选择并禁用删除，旧表格有明确提示。

### 可复现的源码回归

需要基础 Python 依赖和 Node.js 20+；合成测试不需要模型、业务数据或已启动的 Bridge。

```powershell
node --test extension/tests/*.test.cjs
node extension/tests/semantic-overview.test.cjs
python -B -m unittest discover -s bridge -p test_semantic_search.py -v
python -B bridge/verify_release.py
```

`semantic-overview.test.cjs` 包含 17 项前端检查，使用相对源码路径和内存 DOM/mock，无机器路径或真实评论。`verify_release.py` 在临时目录创建源码快照并安装 Python I/O 隔离守卫，运行后端及前端回归；其日志和运行时绝对路径仅留在本机输出目录，不上传。真实模型质量与本机部署另行验收。

本公开源码以品牌中性公开 main 为基础；品牌、产品、账号词均需用户在本机配置。测试中的可疑平台 ID 已替换为合成标识，不包含业务导出、原始评论快照或模型权重。
