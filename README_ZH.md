# 🛡️ MTProto Deep Checker

一个强大的 **Telegram MTProto 代理** 验证工具，通过执行真实协议握手来检测代理。与简单的 TCP 检查器不同，此工具尝试通过代理获取实际的服务器配置，确保 100% 的连接性。

![界面截图](images/screenshot.png)

## 🌟 功能特点

* **深度检测:** 使用 `help.getNearestDC` / `help.GetConfig` 请求验证代理能否实际传输 Telegram 数据。
* **Go 后端:** 基于 `gotd/td` 构建 — 快速、稳定、单二进制文件。
* **智能过滤:** 自动检测并移除无效密钥、垃圾链接和错误端口。
* **现代界面:** 漂亮的暗色模式界面，支持实时日志和进度条。
* **文件上传:** 从 .txt、.csv 或 .list 文件导入代理列表。
* **导出结果:** 将可用代理下载为 TXT 或 JSON 格式。
* **多语言支持:** 支持中文、英文、波斯语和俄语。
* **无需登录:** 使用公开测试密钥，无需使用手机号登录。
* **暂停/继续:** 可随时暂停检查，继续时不会重复检查已完成的代理。

## 🚀 安装

### 方式 1 — 下载 .exe (Windows)

从 [Releases](../../releases) 下载 `MTProto-Checker.exe`。双击运行。

> 浏览器将自动打开 `http://localhost:3000`。

### 方式 2 — 从源码运行（推荐）

#### 前置要求
需要安装 **Go 1.18+**。[在此下载](https://go.dev/dl/)。

#### 步骤
```bash
git clone https://github.com/rahgozar94725/MTProto-Checker.git
cd MTProto-Checker
go build -o mtproto-checker.exe .
.\mtproto-checker.exe
```

> 二进制文件：~21MB，无需 Node.js。

## 📖 使用方法

1.  **获取代理:** 复制您的 MTProto 代理列表。
    > **提示:** 您可以在[此仓库](https://github.com/SoliSpirit/mtproto)找到大量免费代理。
2.  **粘贴链接:** 将它们粘贴到 **"输入列表"** 框中（支持 `tg://` 或 `https://t.me/proxy` 格式）。
3.  **开始检查:** 点击 **"开始检查"** 按钮。
4.  **等待:** 工具将先过滤无效格式，然后批量测试连接。
5.  **复制结果:** 可用代理将显示在右侧面板中。点击 **"复制"** 保存到剪贴板。

## ⚙️ 工作原理

许多代理能响应 TCP 连接，但无法加密/解密 Telegram 数据包（虚假代理）。
此工具执行以下操作：
1.  **解析与清理:** 修复损坏的链接（例如 `.&port` 输入错误）。
2.  **验证密钥:** 拒绝过长（垃圾填充）或无效的密钥。
3.  **建立连接:** 通过代理建立安全的 MTProto 连接。
4.  **调用 API:** 向 Telegram 数据中心发送 `help.getNearestDC` 请求。
5.  **结果:** 如果服务器回复，则代理标记为 **可用** 并显示延迟。

## 🛠 依赖

### Go 后端（推荐）
* [gotd/td](https://github.com/gotd/td) - 支持原生 MTProxy 的 MTProto API 客户端
* 无需外部依赖 — 单二进制文件

## ☕ 支持

如果您觉得此工具有用，可以支持开发：

<a href="https://nowpayments.io/donation?api_key=d824db3b-fcf7-4ebb-8e3d-297c23cfeee2" target="_blank" rel="noreferrer noopener">
    <img src="https://nowpayments.io/images/embeds/donation-button-black.svg" alt="Crypto donation button by NOWPayments">
</a>

## 📝 许可证

本项目为开源项目，基于 [MIT 许可证](LICENSE)。

---
[Read in English](README.md) | [На русском](README_RU.md) | [中文](README_ZH.md) | [فارسی](README_FA.md)
