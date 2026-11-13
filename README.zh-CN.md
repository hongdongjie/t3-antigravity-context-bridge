# t3-antigravity-context-bridge

[English](./README.md) | 简体中文

零第三方依赖的 Node.js 标准输入输出（stdio）包装脚本，将官方 **Antigravity CLI（`agy`）** 会话数据库中的上下文用量转换为标准 ACP `usage_update` 事件，直接显示在 **[T3 Code](https://github.com/pingdotgg/t3code)** 自带的 **Context** 面板中。

## 解决什么问题

T3 Code 右侧详情面板原生支持显示 ACP 提供商上报的 `usage_update`（已用 Token、总上下文上限与进度条）。

官方 Antigravity CLI（`agy acp`）在每次模型调用后会将上下文统计写入本机 SQLite 会话数据库（`~/.gemini/antigravity-cli/conversations/<sessionId>.db`），但目前尚未在 ACP 协议流中主动发送 `usage_update` 通知。

`bridge.mjs` 作为透明中间层运行在 T3 Code 与本机 `agy` 之间：

- **双向无损透传**：原样转发全部 JSON-RPC / ACP 通信（登录认证、客户端身份、模型参数、工具调用与权限审批均保持原状）。
- **只读提取上下文快照**：每秒以只读模式检查当前会话对应的 `<sessionId>.db`，解析最近一条 `gen_metadata` 中的已用 Token 与上下文上限，仅在数值变化时补发标准 `usage_update`。
- **原生事件自动避让**：若后续官方 `agy` 版本开始原生发送 `usage_update`，桥接器会自动停止该会话的补充上报。
- **零侵入、零依赖**：不安装任何 `npm` 依赖包，不修改 T3 Code 安装包（`server.asar`），也不修改 `agy` 可执行文件。

## 环境要求

- **Node.js `>= 22.5.0`**（使用 Node 内置的 `node:sqlite` 模块）
- 已安装 **[T3 Code](https://github.com/pingdotgg/t3code)**，并在 *Settings → Providers* 中添加了 **Antigravity CLI**（`antigravity-cli`）
- 本机已安装官方 **Antigravity CLI**（`agy` / `agy.exe`）

## 快速接入

### 方式一：运行自动配置脚本（推荐）

1. 克隆或下载本仓库到本地固定目录：

   ```bash
   git clone https://github.com/hongdongjie/t3-antigravity-context-bridge.git
   cd t3-antigravity-context-bridge
   ```

2. 执行配置脚本（首次运行会自动将 `~/.t3/userdata/settings.json` 备份为同目录下的 `settings.before-context-bridge.json`，并在原有 `antigravity-cli` 启动命令外包一层 `bridge.mjs`）：

   ```bash
   node --no-warnings setup.mjs
   ```

3. 重载 T3 Code 或新建对话，点击右上角 **Toggle thread details panel** 打开详情栏，发送首条消息产生模型调用后即可看到 **Context** 实时进度。

如需随时恢复为直连官方 `agy`，运行：

```bash
node --no-warnings setup.mjs --uninstall
```

### 方式二：手动配置

在 `~/.t3/userdata/settings.json`（或 T3 Code 的 **Settings → Providers → Antigravity CLI** 界面）中，将启动命令改为 `node` 调用 `bridge.mjs` 并传入本机 `agy` 路径：

```json
{
  "providerInstances": {
    "antigravity-cli": {
      "driver": "acpRegistry",
      "enabled": true,
      "config": {
        "source": "local",
        "commandPath": "C:\\Program Files\\nodejs\\node.exe",
        "commandArgs": [
          "--no-warnings",
          "D:\\tools\\t3-antigravity-context-bridge\\bridge.mjs",
          "C:\\Users\\<你的用户名>\\AppData\\Local\\agy\\bin\\agy.exe",
          "acp",
          "--process-per-session"
        ]
      }
    }
  }
}
```

> **Windows 路径提示**：若你的 `agy.exe` 位于受沙箱重定向影响的目录（导致桌面端启动报 `ENOENT`），可将官方 `agy.exe` 复制到普通磁盘目录后再填入上述路径。

## 可选环境变量

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `ANTIGRAVITY_CONVERSATIONS_DIR` | `~/.gemini/antigravity-cli/conversations` | 自定义 Antigravity 会话数据库目录时可覆盖。 |
| `T3_SETTINGS_PATH` | `~/.t3/userdata/settings.json` | 运行 `setup.mjs` 时可指定自定义 T3 配置文件路径。 |

## 运行测试

```bash
npm test
```

## 兼容性与说明

- 已在 **Antigravity CLI `1.5.6`** 与 **T3 Code `0.1.9` / `0.1.10-nightly`** 实机验证通过。
- **容错降级**：`context.mjs` 依据 `agy 1.5.6` 内部 `gen_metadata` 的 Protobuf 字段路径（`1 → 9 → 10`）读取上下文数字；若首轮尚未生成数据库、数据库繁忙或未来 CLI 调整了内部字段格式，脚本会自动跳过用量补充，不影响正常对话。
- **隐私安全**：不读取聊天正文、提示词、登录凭据或密钥，仅在 `stderr` 打印发生变化的数字比例。
- **T3 上游已知小细节**：在 T3 Code `0.1.9`–`0.1.10-nightly` 中，对话过程与恢复会话时的 Context 面板均实时刷新；单轮回答彻底结束后晚 1 秒到达的那次尾包快照，在当前窗口内正常显示，落盘持久化需等待 T3 上游为 `usage_update` 补上 `sessionScoped` 标记。

## 开源协议

基于 [MIT](./LICENSE) 协议按原样（AS-IS）分享，供社区参考与自用。
