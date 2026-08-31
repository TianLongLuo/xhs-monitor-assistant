# 小红书舆情监控助手

一个面向品牌舆情监控的 Chrome Manifest V3 扩展与 Windows 本地 Bridge。扩展读取当前小红书页面已加载的 DOM，采集帖子、评论、图片和视频，并幂等写入本地 UTF-8 CSV 与 SQLite。

公开版版本：`0.25.3`

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
  -SeedCsv "D:\path\to\小红书_笔记总表.csv"
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

## v0.25.2：语义分析字段与评论存续状态

- 接纳笔记/评论 CSV 的 `语义分析次数`、`分析结论是否差评`、`差评类型`、`差评子类型`，并与 SQLite 保持一致。
- 评论 CSV 新增 `评论状态`，值固定为 `存在` 或 `已删除`；历史评论初始化为 `存在`。
- 完整评论同步不再物理删除消失评论，而是保留正文和语义字段并标记 `已删除`；重新出现时恢复为 `存在`。
- 只有评论已完整展开的 `likely_complete` 快照才允许标记删除，部分加载不会误判。
- SQLite 与素材 `comments.json` 同步保存评论状态和核验时间，数据体检核对 ID、状态和语义字段。

## v0.25.3：帖子存续状态与非破坏性下架处理

- 笔记 CSV 新增 `帖子状态`，固定为 `存在` 或 `已删除`；SQLite 同步保存状态、删除时间与最近核验时间。
- 双重证据确认帖子删除或下架时，只更新状态，不删除帖子行、评论、分析记录或素材目录。
- 新帖子继续按笔记 ID 追加；已删除帖子重新成功打开或拉取后恢复为 `存在`。
- 批量同步默认跳过已标记删除的帖子，人工选择时仍可重新核验。
- 数据体检同时核对笔记 CSV、SQLite 与素材 `note.json` 的帖子状态。
