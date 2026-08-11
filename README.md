# 小红书舆情监控助手

Chrome Manifest V3 扩展 + 本地 Native Messaging Bridge。扩展读取当前页面已经加载的 DOM，将帖子、评论和图片写入本地 Excel / SQLite，并可调用 AI 进行情绪分析。

当前版本：`0.14.0`

## 特性

- 当前页面 DOM 读取，不申请 Cookie 权限，不调用小红书隐藏接口。
- 帖子正文、评论、图片素材幂等写入。
- 新用户首次拉取时自动创建标准 Excel。
- 本地私有品牌、产品、账号词库。
- AI 测试连接、自动分析、流式进度条、百分比与完成通知。
- 侧边栏可缩小为吸附在浏览器右侧的圆形悬浮球。
- Bridge 仅监听 `127.0.0.1:17881`。

## 快速开始

前置环境：Windows、Chrome、Python 3.10+。

```powershell
pip install -r bridge/requirements.txt
```

1. 打开 `chrome://extensions`，开启开发者模式。
2. 点击“加载已解压的扩展程序”，选择 `extension/`。
3. 双击 `setup.cmd`。向导会尝试自动识别扩展 ID；必要时按提示粘贴扩展卡片上的 32 位 ID。
4. 在扩展管理页点击“重新加载”，并刷新已打开的小红书页面。

完整步骤见 [使用说明.md](使用说明.md)。

## 监控词库

安装向导会从示例生成本机文件：

```text
bridge/data/relevance_keywords.json
```

格式：

```json
{
  "brand": ["品牌名", "品牌别名"],
  "products": ["产品名 A", "产品名 B"],
  "accounts": ["官方账号名"]
}
```

该文件、数据库、AI 设置、Excel 和素材均被 `.gitignore` 排除。

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
data/                              Excel 与素材（运行时生成，不入库）
setup.ps1 / setup.cmd              一键连接向导
使用说明.md
小红书舆情监控助手_PRD.md
```

## 手动安装

```powershell
powershell -ExecutionPolicy Bypass -File bridge/build_native_host.ps1
powershell -ExecutionPolicy Bypass -File bridge/install_native_host.ps1 -ExtensionId "你的32位插件ID"
```

已有总表：

```powershell
powershell -ExecutionPolicy Bypass -File bridge/install_native_host.ps1 `
  -ExtensionId "你的32位插件ID" `
  -SeedXlsx "D:\路径\小红书笔记评论总表.xlsx"
```

## 本地 API

主要端点：

```text
GET  /api/health
GET  /api/stats
GET  /api/relevance
GET  /api/notes
GET  /api/comments
GET  /api/ai/status
GET  /api/ai/jobs
POST /api/scan
POST /api/pull
POST /api/comments/upsert
POST /api/ai/test
POST /api/ai/analyze
POST /api/review
```

## 安全与隐私

- 扩展权限不包含 `cookies`、`webRequest`。
- 页面脚本只操作可见 DOM。
- 图片使用页面提供的 CDN URL 下载，不附带浏览器 Cookie。
- 用户数据、密钥、私有词库、构建产物和本机注册清单不会提交到仓库。

## 卸载 Bridge 注册

```powershell
powershell -ExecutionPolicy Bypass -File bridge/uninstall_native_host.ps1
```
