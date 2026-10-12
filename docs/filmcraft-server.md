# FilmCraft Server — 评估、需求与实施计划

> **目标**: 把 FilmCraft(纯 Rust 自研非编,Premiere Pro 级)从桌面/CLI/MCP 改造成"云端多用户 Web 视频剪辑平台",基于阿里云 Function Compute / SAE 部署,媒体落 OSS,支持百炼 AI 助手。

**文档状态**: 评估完成,需求确认,实施计划待启动。
**最后更新**: 2026-10-08

---

## 0. 摘要

FilmCraft 现已具备改造成 Web 服务所需的全部基础设施:`engine::Services` trait 抽象了所有 I/O,`Session::execute(id, params)` 是 650+ 命令的唯一入口,控制协议已经是"传输无关"的 `ControlRequest` 结构。改造本质是"再加一个 transport(从 TCP 换成 WebSocket),再实现一个 Services 把本地磁盘换成 OSS"。

**最大风险**: FC 实例最长 5 分钟(突发)/ 1 小时(配置),长视频导出会被超时砍死。建议主服务跑 SAE(常驻容器),长任务(导出/转码)切片后丢给 FC workers。

**M1 目标**: 跑通"浏览器上传 → 服务端导入 → 简单编辑 → 导出 H.264"完整链路,1 个熟手 6 周可完成。

---

## 1. 项目现状评估

### 1.1 FilmCraft 已有能力

| 能力 | 状态 | 文件/位置 |
|---|---|---|
| 650+ 引擎命令 | ✅ 完整 | `crates/engine/src/commands.rs` |
| H.264/HEVC/ProRes/AV1 编解码 | ✅ 自研,纯 Rust | `crates/h264`, `crates/hevc`, `crates/prores`, `crates/av1` |
| MP4/MOV/Matroska/MXF 容器 | ✅ | `crates/isobmff`, `crates/matroska`, `crates/mxf` |
| 时间线/修剪/关键帧 | ✅ | `crates/edit`, `crates/engine/src/trim.rs` |
| 调色(Lumetri 全套) | ✅ | `crates/engine/src/color.rs` |
| 音频混音 + EBU R128 响度 | ✅ | `crates/audio-dsp`, `crates/engine/src/mixer.rs` |
| GPU 合成(wgpu) | ✅ | `crates/render`, `crates/gpu` |
| FCPXML/OTIO/AAF/EDL/OMF 交换 | ✅ | `crates/interchange` |
| `.fcproj` 工程文件 | ✅ | `crates/format` |
| 控制协议(JSON Lines) | ✅ | `apps/filmcraft/src/control_server.rs` |
| MCP server | ✅ | `apps/filmcraft-cli --mcp` |
| 自动保存 + 崩溃恢复 | ✅ | `crates/engine/src/autosave.rs` |

### 1.2 改造需要的能力(缺口)

| 缺口 | 现状 | 改造方案 |
|---|---|---|
| HTTP/WebSocket 服务 | ❌ 仅有 TCP 控制端口 | 新增 `cloud/filmcraft-server` crate(axum) |
| 对象存储抽象 | ❌ 默认 `FsServices` 直接 `std::fs` | 实现 `OssServices` 套 `engine::Services` |
| 多用户隔离 | ❌ 桌面单用户 | `SessionManager` 按 `user_id` 分实例 |
| 工程版本/协作 | ❌ 桌面单文件 | `.fcproj` 写 OSS,加版本号和 lock 机制 |
| 流式预览 | ⚠️ 渲染单帧有,流没有 | FC worker 跑代理转码,浏览器 `<video>` 播 |
| AI 对话入口 | ❌ 无 | Sidecar 调阿里云百炼 Function Calling |
| 埋点 | ❌ 无 | `TracingSession` 包装 `execute`,异步写 OSS/SLS |
| 部署到阿里云 | ❌ 桌面二进制 | SAE/FC + Dockerfile/容器镜像 |

### 1.3 关键架构发现

#### 1.3.1 `engine::Services` 是天然的"插拔点"

文件: `crates/engine/src/lib.rs:95`

```rust
pub trait Services: Send + Sync {
    fn read_file(&self, path: &str) -> std::io::Result<Vec<u8>>;
    fn write_file(&self, path: &str, data: &[u8]) -> std::io::Result<()>;
    fn file_size(&self, path: &str) -> std::io::Result<u64>;
    fn read_range(&self, path: &str, offset: u64, len: usize) -> std::io::Result<Vec<u8>>;
    fn reader(&self, _path: &str) -> Option<std::io::Result<filmcraft_media::SharedReader>>;
    fn list_dir(&self, _dir: &str) -> Option<std::io::Result<Vec<String>>>;
    fn file_loader(&self) -> Option<filmcraft_media::sequence::FrameLoader>;
    fn export_in_memory(&self) -> bool;
    // ...
}
```

**所有文件 I/O 走这个 trait**。只要实现一个 `OssServices` 把 path 解析成 OSS key,引擎完全无感地从"读本地磁盘"切换到"读 OSS"。原生有 `FsServices` 直接参考(`lib.rs:147`)。

**`reader()` 返回 `SharedReader` 是关键** —— 媒体按需 range 读,不能整个文件读进内存。OSS 的 HTTP Range 请求天然支持。

#### 1.3.2 `Session::execute(id, params)` 是唯一命令入口

文件: `crates/engine/src/lib.rs:616`

```rust
pub fn execute(&mut self, id: &str, params: Value) -> Result<Value>
```

650+ 命令全在这里 dispatch。`&mut self` 但内部状态是 `Arc<Project>`,所以 Session 可以锁外克隆、锁内执行,天然适合多线程。

#### 1.3.3 控制协议已经是"传输无关"

文件: `crates/ui-egui/src/control.rs:33`

```rust
pub struct ControlRequest {
    pub method: String,
    pub params: Value,
    pub reply: Sender<Value>,
}
```

桌面 app 用 TCP,MCP 用 stdio,**我们用 WebSocket 完全等价**。`apps/filmcraft/src/control_server.rs` 的 167 行是现成模板,只把 `TcpStream` 换成 `WebSocket` 即可。

**注意**: `ui.screenshot`、`ui.elements` 等 UI 命令依赖 egui Context(截图/取 UI 元素矩形)。我们是无头服务,这些命令不可用或要降级。核心 `engine.*` 命令完整可用,覆盖剪辑 95% 用例。

#### 1.3.4 已有 `--bridge` 模式

`filmcraft-cli --bridge 127.0.0.1:9876` 可以桥接已运行 app 的控制端口。意味着 MCP 不用改,只要 Web 服务起在 9876,外部 MCP 客户端直接接。

---

## 2. 需求(已与产品方确认)

### 2.1 用户场景

| 场景 | 描述 |
|---|---|
| 单人远程剪辑 | 用户在浏览器里打开工程,上传视频,拖时间线,导出 |
| 团队协作 | 多账号分时处理同一工程(Git 模式,不是 Google Docs 实时) |
| AI 助手 | 用户在 Web UI 里输入"把第 3 段调亮一点",AI 通过百炼翻译成引擎命令 |
| 本地互通 | 下载 `.fcproj` 或 FCPXML/AAF,在本地 Premiere 继续编辑 |
| 多人共用 | 部署在阿里云,多个用户账号共用一份基础设施 |

### 2.2 功能需求

| # | 需求 | 优先级 |
|---|---|---|
| F1 | 浏览器上传视频/图片/音频到 OSS,自动识别编码 | P0 |
| F2 | 浏览器列出工程、打开、新建、删除 | P0 |
| F3 | 浏览器时间线展示(基本查看、播放,不能拖) | P0 (M1) |
| F4 | 浏览器拖时间线、修剪、加转场、加关键帧 | P1 (M2) |
| F5 | 浏览器调色(Lumetri) | P2 (M3) |
| F6 | 浏览器混音 | P2 (M3) |
| F7 | 浏览器流式预览(代理 mp4 `<video>`) | P1 (M2) |
| F8 | 浏览器导出 H.264/ProRes 到 OSS,生成下载链接 | P0 (M1) |
| F9 | 工程版本管理(打开/保存/历史) | P0 (M1) |
| F10 | 多用户账号 + 权限(只读/编辑/所有者) | P0 (M1) |
| F11 | AI 对话(百炼 Function Calling → 引擎命令) | P2 (M3) |
| F12 | 导出 `.fcproj` 到本地,本地可继续编辑(回 FilmCraft Web) | P1 (M2) |
| F13 | 导出 FCPXML/AAF(给本地 Premiere/Avid 打开) | P2 (M3) |
| F14 | 全埋点(用户行为/命令/性能) | P0 (M1) |
| F15 | 长任务切片导出(>5 分钟视频) | P0 (M1, 决定部署形态后细化) |

### 2.3 非功能需求

| # | 需求 | 指标 |
|---|---|---|
| N1 | 冷启动可接受 | 主服务 ≤ 1 分钟(用户接受) |
| N2 | 多人并发 | 50 个同时在线用户(初期) |
| N3 | 媒体总量 | 单用户 100GB 媒体库,1GB 单文件 |
| N4 | 导出时长 | 1 小时 1080p 视频 ≤ 30 分钟(FC worker 切片) |
| N5 | 隐私 | 媒体不进公网 OSS,走内网 endpoint;参数 hash 化存储 |
| N6 | 可用性 | 99%(单实例 SAE + OSS,不跨 AZ) |
| N7 | 不崩溃 | 严格遵循 AGENTS.md §0(无 `unwrap`/`expect`/`panic`/`unsafe`) |

### 2.4 范围外(M1 明确不做)

- 视频内容理解(那是 VLM 的活,不是 NLE 的活)
- 实时协作(Google Docs 模式,需要 CRDT/OT,M1 用 Git 模式分时)
- 插件宿主(VST3/Audio Units/OpenFX,ROADMAP 优先级低)
- 相机 RAW、HEVC/AV1 软件导出(ROADMAP 标记未完成)
- 计费系统(M1 不商业化,但埋点要留好,后期可加)
- 桌面应用继续维护(产品方说"独立团队支持",不冲突,M1 也不动桌面)

---

## 3. 架构设计

### 3.1 总体架构

> **路由归属(M1.7+)**:`/` 由 React SPA(`cloud/filmcraft-web-ui/dist/index.html`)的 fallback 接管;API doc 本身在 `GET /api/v1`,所有 API 端点都在 `/api/v1/*` 命名空间下,**没有** 任何裸 `/health` 之类的路径(老 M1.3 `/health` 已下架)。健康探针用 `GET /api/v1/health`(同时也是 docker HEALTHCHECK 的目标)。

```
                       ┌──────────────────────┐
                       │    浏览器 Web UI     │
                       │  React + Vite + WS   │
                       └──────────┬───────────┘
                                  │ WSS (长连接)
                                  ▼
                       ┌──────────────────────┐
                       │  filmcraft-server    │  ← SAE 常驻(主)
                       │  (axum + tokio)      │     init ~ 1 分钟
                       │  ┌────────────────┐  │
                       │  │ SessionManager │  │
                       │  │  (多用户)       │  │
                       │  └────────┬───────┘  │
                       │  ┌────────▼───────┐  │
                       │  │  Wrapped       │  │
                       │  │  Session       │  │
                       │  │ (引擎 + 埋点)  │  │
                       │  └────────────────┘  │
                       └────────┬─────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
   ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
   │  AI Sidecar     │ │  FC Workers     │ │ 阿里云百炼 API  │
   │  (SAE/ECS)      │ │  - 代理转码      │ │ Qwen/Qwen-VL    │
   │  Function       │ │  - 缩略图        │ └─────────────────┘
   │  Calling 桥     │ │  - 导出切片      │
   └────────┬────────┘ └────────┬────────┘
            │                  │
            └────────┬─────────┘
                     ▼
            ┌─────────────────────┐
            │  阿里云 OSS          │
            │  - 媒体 (原始)       │
            │  - 媒体 (代理 mp4)   │
            │  - 工程 (.fcproj)   │
            │  - 导出 (成品)       │
            │  - 埋点 (JSONL)     │
            └─────────────────────┘
```

### 3.2 部署拓扑

| 组件 | 阿里云产品 | 形态 | 冷启动 |
|---|---|---|---|
| `filmcraft-server` (主) | **SAE**(Serverless App Engine) | 常驻容器,弹性伸缩 | ~ 60s,预留实例可消除 |
| AI Sidecar | SAE | 常驻 | ~ 30s |
| FC Workers (转码/导出) | **Function Compute** | 事件触发,无状态 | ~ 1s |
| 媒体/工程/导出 | **OSS** | 对象存储 | N/A |
| 埋点 | OSS + SLS | 异步写 | N/A |
| 任务队列 | 阿里云 MNS / 自建 Redis | 短任务分发 | N/A |

**为什么不用 FC 做主服务**:
- FC 突发型实例最长 5 分钟,配置型最长 1 小时(贵)
- 4K 1 小时视频导出 + 转码 + 切片合并,任何 FC 实例都超时
- SAE 是常驻容器但有弹性,冷启动 < 1 分钟,**最匹配"主服务常驻、任务分发"模型**
- 后期用户量大了可以迁到 ECS,代码不变

### 3.3 关键模块设计

#### 3.3.1 `cloud/filmcraft-server` crate

```
cloud/filmcraft-server/
├── Cargo.toml
├── src/
│   ├── main.rs                 # tokio 启动入口
│   ├── server.rs               # axum 路由组装
│   ├── state.rs                # AppState (SessionManager, OssServices, Config)
│   ├── session.rs              # SessionManager 多用户
│   ├── services.rs             # OssServices: engine::Services
│   ├── ws.rs                   # WebSocket 桥接控制协议
│   ├── api/
│   │   ├── mod.rs
│   │   ├── upload.rs           # POST /api/upload
│   │   ├── project.rs          # 工程 CRUD + 版本
│   │   ├── export.rs           # POST /api/export (触发 FC worker)
│   │   ├── media.rs            # GET /api/media/{id}/stream
│   │   └── chat.rs             # POST /api/chat (AI)
│   ├── tracing_session.rs      # 埋点包装
│   ├── fc_dispatch.rs          # 调用 FC workers
│   └── error.rs                # 统一错误类型
```

#### 3.3.2 `OssServices`

```rust
// src/services.rs
pub struct OssServices {
    op: opendal::Operator,  // S3 协议对接 OSS
    bucket: String,
}

impl engine::Services for OssServices {
    fn read_file(&self, path: &str) -> io::Result<Vec<u8>> {
        let key = self.resolve_key(path);
        self.op.read(&key).map_err(io::Error::other)
    }
    fn write_file(&self, path: &str, data: &[u8]) -> io::Result<()> {
        let key = self.resolve_key(path);
        // OSS 不支持原子写: 写临时对象 + rename
        // 但工程文件小,可以简单覆盖
        self.op.write(&key, data.to_vec()).map_err(io::Error::other)
    }
    fn read_range(&self, path: &str, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        let key = self.resolve_key(path);
        // opendal 支持 range read,转成 OSS 的 HTTP Range
        self.op.read_with(&key).range(offset..offset+len as u64)
            .call().map_err(io::Error::other)
    }
    fn file_size(&self, path: &str) -> io::Result<u64> {
        let key = self.resolve_key(path);
        self.op.stat(&key).map(|m| m.content_length()).map_err(io::Error::other)
    }
    fn reader(&self, path: &str) -> Option<io::Result<SharedReader>> {
        // 返回 OSS range reader,媒体解码器按需 range 读
        // (具体 API 看 filmcraft_media::SharedReader 定义)
        Some(...)
    }
}

impl OssServices {
    fn resolve_key(&self, path: &str) -> String {
        // path 形如 "oss://filmcraft/users/{u}/projects/{p}/media/{m}.mp4"
        // 或简化的 "users/{u}/media/{m}.mp4"
        // 全部视作 OSS key
        path.trim_start_matches("oss://").to_string()
    }
}
```

#### 3.3.3 `SessionManager`

```rust
// src/session.rs
pub struct SessionManager {
    sessions: tokio::sync::RwLock<HashMap<UserId, Arc<tokio::sync::Mutex<Session>>>>,
    services: Arc<OssServices>,
    config: Arc<Config>,
}

impl SessionManager {
    pub async fn get_or_create(&self, user_id: UserId) -> Result<Arc<Mutex<Session>>> {
        // 命中: 返回已有 Session
        // 未命中: 创建新 Session,加载用户最近工程,启动埋点
        todo!()
    }

    pub async fn save_project(&self, user_id: UserId, project_id: ProjectId)
        -> Result<Revision>
    {
        // 1. 拿到 Session,clone Arc<Project>
        // 2. 序列化为 .fcproj (已有 crates/format)
        // 3. 写 OSS: oss://filmcraft/users/{u}/projects/{p}/current.fcproj
        // 4. 也保留历史: oss://.../history/{rev}.fcproj
        // 5. 更新 meta.json 的 latest_rev 和 last_edited_at
        todo!()
    }

    pub async fn load_project(&self, user_id: UserId, project_id: ProjectId)
        -> Result<()>
    {
        // 1. 从 OSS 读 current.fcproj
        // 2. Session.load() 重放
        // 3. 检查 meta.json 是否有别人 lock
        // 4. 如果 lock 了,报错"工程被其他用户编辑中"
        todo!()
    }
}
```

#### 3.3.4 WebSocket 桥接

```rust
// src/ws.rs (核心逻辑)
use axum::extract::ws::{WebSocket, Message};
use engine::Session;
use ui_egui::ControlRequest;

pub async fn handle_socket(socket: WebSocket, session: Arc<Mutex<Session>>) {
    let (mut tx, mut rx) = socket.split();
    let (req_tx, mut req_rx) = tokio::sync::mpsc::channel::<ControlRequest>(64);

    // task 1: 把 Session 处理完的 reply 发回客户端
    tokio::spawn(async move {
        while let Some(reply) = req_rx.recv().await {
            let json = serde_json::to_string(&reply).unwrap_or_default();
            if tx.send(Message::Text(json)).await.is_err() { break; }
        }
    });

    // task 2: 主循环读 WS 消息,转 ControlRequest
    while let Some(msg) = rx.next().await {
        let Ok(msg) = msg else { break };
        let Message::Text(text) = msg else { continue };
        // 解析 JSON Lines
        let line: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => { /* 错误 + 关连接 */ continue; }
        };
        let method = line["method"].as_str().unwrap_or("").to_string();
        let params = line["params"].clone();

        // 关键: 把 session.move_to_ui_thread() 改为 session.lock().await
        // 然后调 session.execute(method, params)
        let session = session.clone();
        let req_tx = req_tx.clone();
        tokio::spawn(async move {
            let mut s = session.lock().await;
            let r = match s.execute(&method, params) {
                Ok(v) => serde_json::json!({"ok": true, "result": v}),
                Err(e) => serde_json::json!({"ok": false, "error": e.to_string()}),
            };
            // 实际不用 ControlRequest,直接发 reply
            // (这是简化版本,生产用 ControlRequest 同样的 channel 模式)
            let _ = req_tx.send(/* reply */).await;
        });
    }
}
```

**简化点**: 原 `ControlRequest` 是同步 `std::sync::mpsc`,Web 服务用 tokio 异步版本。语义不变,只是改 transport。

#### 3.3.5 分时协作(Git 模式)

```rust
// OSS 工程结构
oss://filmcraft/{user_id}/projects/{project_id}/
  current.fcproj           # 最新版本(总是最新)
  history/{rev}.fcproj     # 历史版本(只增不删)
  meta.json                # { latest_rev, locked_by, locked_at, last_edited_at }

// meta.json 流程
// 1. 打开工程: 读 current.fcproj + meta.json
//    如果 locked_by != self, 警告"工程被 {user} 编辑中,只读打开?"
// 2. 申请编辑权: 调 atomic_lock(用户 ID), 成功则成为 locked_by
// 3. 编辑: 实时改当前 Session (in-memory)
// 4. 保存: 写新版本号 rev+1, 写 history/{rev+1}.fcproj,
//          更新 current.fcproj, 更新 meta.json {latest_rev: rev+1, locked_by: null}
// 5. 别人打开: 看到最新 rev = rev+1, 不是自己之前的 rev, 提示合并
//    (M1 不做自动合并, 用户手动处理; M2+ 加 diff 工具)
```

**无 CRDT、无 OT、简单的悲观锁**。参考 git 的工作流。

#### 3.3.6 流式预览(M2 范围,M1 不做)

```
[上传素材]
    → 触发 FC worker "代理转码"
    → 读 OSS 原始媒体
    → 用 filmcraft-h264enc 编码 720p H.264 (低码率)
    → 写 OSS: oss://.../proxies/{media_id}.mp4

[浏览器播放]
    → <video src="/api/media/{id}/stream?type=proxy">
    → 服务端转 OSS 签名 URL (15 分钟有效)
    → 浏览器直接流式播放 OSS

[工程修改]
    → Session.execute 修改工程
    → 后台检查哪些时间线段被改, 重转那段的代理
    → M1 简化为"整工程重转",M2 加段级增量
```

**M1 不做代理流**。M1 浏览器用 `<img>` 显示单帧(调 `engine.render_frame(time)` 拿 JPEG),或者干脆先显示原始媒体(用 OSS 签名 URL 直链)。能播就行,体验后面优化。

#### 3.3.7 百炼 AI Sidecar(M3 范围)

```
[Web UI chat]
  → POST /api/chat { messages: [{role: "user", content: "把第3段调亮"}] }
  → 主服务转给 Sidecar
  → Sidecar:
      1. 调百炼 ChatCompletion (function_calling=true)
      2. 百炼返回 tool_calls: [{name: "engine.execute", args: {command: "lumetri.setSection", params: {section: "basic", on: true}}}]
      3. Sidecar 通过 WebSocket 发给主服务 (或直接调内部 API)
      4. 主服务执行, 返回结果
      5. Sidecar 再调百炼拿自然语言回复 "已开启基础调色,你想调曝光吗?"
  → 主服务把对话历史 + 命令结果发回 Web UI
```

**M1 Sidecar 不做**。M1 只在 Web UI 加 chat 输入框 + 占位"AI 助手开发中"。

#### 3.3.8 埋点

```rust
// src/tracing_session.rs
pub struct TracingSession {
    inner: Session,
    user_id: Uuid,
    trace_tx: tokio::sync::mpsc::Sender<TraceEvent>,
}

impl TracingSession {
    pub fn execute(&mut self, id: &str, params: Value) -> Result<Value> {
        let t0 = Instant::now();
        let r = self.inner.execute(id, params.clone());
        let latency_ms = t0.elapsed().as_millis() as u32;
        let event = TraceEvent {
            user_id: self.user_id,
            command: id.to_string(),
            params_hash: hash(&params),  // 不存明文
            latency_ms,
            success: r.is_ok(),
            error: r.as_ref().err().map(|e| e.to_string()),
            timestamp: Utc::now(),
        };
        // 异步发,失败不影响主流程
        let _ = self.trace_tx.try_send(event);
        r
    }
}

// TraceEvent 批量写 OSS JSONL 或推阿里云 SLS
```

**埋点维度**:
- 引擎层: (user, command, params_hash, latency, success)
- UI 层: (user, action, target_id, timestamp)
- 性能: (CPU, memory, active_sessions, oss_throughput)

---

## 4. OSS 路径规划

```
oss://filmcraft-{env}/                                # bucket
├── users/{user_id}/
│   ├── profile.json                                 # 用户元数据
│   ├── projects/
│   │   └── {project_id}/
│   │       ├── current.fcproj                       # 最新工程文件
│   │       ├── history/
│   │       │   ├── {rev_1}.fcproj
│   │       │   ├── {rev_2}.fcproj
│   │       │   └── ...
│   │       ├── meta.json                            # { latest_rev, locked_by, ... }
│   │       ├── media/
│   │       │   ├── {media_id}.mp4                   # 原始素材
│   │       │   ├── {media_id}.wav
│   │       │   └── ...
│   │       ├── proxies/                             # 代理(M2)
│   │       │   ├── {media_id}.mp4
│   │       │   └── ...
│   │       ├── exports/
│   │       │   ├── {export_id}.mp4                  # 导出产物
│   │       │   └── ...
│   │       └── thumbnails/
│   │           ├── {media_id}.jpg
│   │           └── ...
│   └── preferences.json                             # 用户偏好
└── _system/
    ├── traces/{date}.jsonl                          # 埋点
    ├── jobs/{job_id}.json                           # 长任务状态
    └── exports-tmp/{job_id}/                        # 导出中间产物
```

**安全**:
- Bucket 私有,所有访问走签名 URL(15 分钟有效)
- Web 服务用 RAM Role 获取 OSS 访问凭证(不写代码里)
- 跨用户访问:Web 服务按 `user_id` 路径前缀做权限校验

---

## 5. 实施计划(M1 详细)

### 5.1 M1 范围

**M1 目标**: 跑通"浏览器上传 → 服务端导入 → 命令执行 → 导出 H.264"完整链路,1 个熟手 6 周完成。

**包含**:
- F1 上传、F2 工程 CRUD、F3 基本时间线展示、F8 导出、F9 版本管理、F10 多用户、F14 埋点、F15 长任务切片
- 部署:SAE 主 + FC workers

**不包含**(放 M2/M3):
- F4 拖时间线、F5 调色、F6 混音、F7 代理流、F11 AI、F12/F13 互通

### 5.2 任务清单

| # | 任务 | 工时 | 依赖 | 验证标准 |
|---|---|---|---|---|
| M1.1 | 部署形态决策(SAE 主 + FC workers) | 0.5d | — | 决策文档 |
| M1.2 | 新建 `cloud/filmcraft-server` crate | 1d | M1.1 | workspace 编译通过,`cargo run -p filmcraft-server` 启动并监听 :8080(Docker 下主机端口映射为 9081) |
| M1.3 | `OssServices` 实现 `engine::Services` | 3d | M1.2 | 单元测试:写一个临时文件到 OSS,通过 `Session::execute("media.import")` 能识别 |
| M1.4 | `SessionManager` 多用户隔离 | 2d | M1.3 | 单元测试:两个用户并发,Session 互不污染;锁外 clone Arc,锁内 execute |
| M1.5 | WebSocket 桥接控制协议 | 3d | M1.4 | 集成测试:WS 发 `engine.execute("engine.commands")`,收到命令列表;`filmcraft-cli --bridge ws://...` 能连 |
| M1.6 | HTTP 上传/下载 API | 2d | M1.4 | 集成测试:POST /api/upload 一个 10MB mp4,GET 列表能看到;GET /api/project/{id}/export 拿到下载链接 |
| M1.7 | 极简 Web UI | 5d | M1.5, M1.6 | 浏览器能: 登录、列工程、创建工程、上传视频、显示媒体库、播放(直链 OSS)、"导出"按钮触发 |
| M1.8 | 工程文件互通 | 2d | M1.6 | 集成测试:Web 导出 `.fcproj` 能在本地 FilmCraft 打开;反之亦然 |
| M1.9 | 埋点系统 | 2d | M1.5 | OSS `_system/traces/` 下有 JSONL;样例数据可解析 |
| M1.10 | 部署 + 冷启动验证 | 3d | M1.7 | SAE 部署,从冷启动到首请求 < 90s;FC worker 转码 1 分钟 mp4 < 30s |
| M1.11 | 端到端 demo | 2d | M1.10 | 录屏:浏览器上传 → 命令编辑 → 导出 → 下载播放 |

**总工时**: ~ 25-30 工作日(5-6 周)。

### 5.3 关键文件改动(预判)

| 文件 | 改动 |
|---|---|
| `Cargo.toml` (workspace) | 加 `cloud/filmcraft-server` 到 members |
| `cloud/filmcraft-server/Cargo.toml` (新) | 依赖: filmcraft-engine, filmcraft-ui-egui, axum, tokio, tower-http, opendal, tracing |
| `crates/engine/src/lib.rs` | **不改** |
| `crates/ui-egui/src/control.rs` | **不改** (用 `ControlRequest` 结构) |
| `apps/filmcraft/src/control_server.rs` | **不改** (作为参考) |
| `cloud/filmcraft-server/src/services.rs` (新) | `OssServices` 实现 `engine::Services` |

**核心承诺**: 不改 engine 任何代码,所有改动在 `cloud/filmcraft-server/` 内。

### 5.4 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| FC worker 转码 1080p 视频超时 | 高 | 按 NAL 切片 + OSS 中间产物;最坏情况降级为 SAE 长跑 worker |
| 冷启动 1 分钟用户不可接受 | 中 | SAE 预留实例保活 1 个,首请求走预留实例;后续按负载弹性 |
| WebSocket 在 SAE 上不稳定 | 中 | 心跳 + 自动重连,服务端 60s 内无心跳断连 |
| OSS 跨区域延迟 | 中 | 选用户就近 region(华东 1 / 华北 2),Web 服务同 region |
| `reader()` 实现复杂 | 中 | 优先 read_range + read_file 全量,reader 留 None(全量读);M2 再优化 |
| `filmcraft-cli --bridge ws://` 不支持 ws 协议 | 低 | 直接用 WebSocket 客户端 SDK,绕开 CLI |
| 百炼 Function Calling 翻译质量差 | 高 (M3) | 选典型指令集做 few-shot;M3 早期做小流量灰度 |

### 5.5 测试策略

按项目传统(AGENTS.md §0.8 强约束"prove it"):

1. **单元测试**: `SessionManager` 并发隔离、`OssServices` 路径解析、埋点 hash
2. **集成测试**: 用 [LocalStack](https://github.com/localstack/localstack) 或 [ossutil](https://help.aliyun.com/document_detail/120075.html) 起本地 OSS 兼容环境,跑完整流程
3. **Fuzz**: `Session::execute` 接受任意 params,确保错误返回 `Result` 而不 panic
4. **端到端**: Web UI + SAE 实际部署,真上传 1 个 mp4 跑通
5. **崩溃回归**: 任何 panic 修复必须带一个失败的合成输入测试

### 5.6 质量门(每次提交)

(项目 CLAUDE.md 强约束)
- `cargo fmt --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`
- `cargo xtask layers` (确保新 crate 不破坏分层)
- `cargo xtask assets` (M1 不加新资产,过)
- `cargo xtask wasm` (M1 不动 wasm,过)
- `cargo xtask ci` (聚合)

---

## 6. 后续里程碑

| 里程碑 | 范围 | 工时 |
|---|---|---|
| **M1** | 上传/工程/导出基础链路 | 5-6 周 |
| **M2** | 时间线拖动 / 修剪 / 关键帧 / 代理流 / 本地互通(FCPXML) | 8-10 周 |
| **M3** | 调色 / 混音 / AI Sidecar(百炼)/ 协作增强 | 8-10 周 |
| **M4** | 性能优化 / 多用户压测 / 商业化埋点 / 计费 | 4-6 周 |

---

## 7. 待确认事项

1. **后端语言**: Rust(沿用 FilmCraft 栈)vs Go(更快开发 vs 失去类型同构)→ **建议 Rust**,原因: 复用 Session 类型、编译期保证、AGENTS.md 的 `unsafe` 规则已建
2. **前端框架**: React(Vite) vs Vue vs Svelte → **建议 React + Vite + Tailwind**,原因: 生态最大,招聘容易,FilmCraft README 没规定
3. **AI 接入时机**: M1 不做,M3 开始 → **确认 M3 启动,不要提前**
4. **桌面应用去留**: 产品方说"独立团队",M1 不动 → **确认**
5. **OSS 区域**: 用户群在哪?决定 bucket region → **需确认**
6. **登录方式**: 阿里云 RAM 用户 vs 自建账号 vs OAuth → **需确认,M1 简化为"用户名 + 临时 token"**

---

## 8. 参考

- [FilmCraft 架构](architecture.md) — 分层、数据模型、命令系统
- [FilmCraft 控制协议](control-protocol.md) — JSON Lines 协议详情
- [FilmCraft ROADMAP](../ROADMAP.md) — 已知缺口、优先级
- [AGENTS.md](../AGENTS.md) — 永不崩溃、纯 Rust、资产合规规则
- [CLAUDE.md](../CLAUDE.md) — 工作约定、质量门

---

## 9. 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-10-08 | 主服务跑 SAE 而非 FC | FC 5 分钟超时不够长视频导出 |
| 2026-10-08 | 不动 engine 任何代码 | 改造在 apps/ 范围内,降低风险 |
| 2026-10-08 | 分时协作(Git 模式)而非实时 | 实现简单、用户量小、符合需求 |
| 2026-10-08 | 工程文件只存 OSS key,不含媒体本体 | 用户下载工程时按需 link 媒体 |
| 2026-10-08 | 埋点异步写 OSS JSONL,不入 SLS | M1 简单优先,M4 接入 SLS |
| 2026-10-08 | AI Sidecar M1 占位,M3 实施 | 验证链路优先,AI 是锦上添花 |
| 2026-10-08 | M1 浏览器播放用 OSS 直链,不做代理 | 流式体验 M2 优化 |
| 2026-10-08 | 本地互通 M1 只 `.fcproj` 进出,FCPXML 放 M2 | `.fcproj` 零成本,FCPXML 有工作量 |
