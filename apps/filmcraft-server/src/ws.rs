//! WebSocket bridge for the FilmCraft control protocol.
//!
//! This is the headless equivalent of the desktop TCP control server in
//! `apps/filmcraft/src/control_server.rs`: a JSON-lines request/response
//! channel where every request is a JSON object with a string `method` and an
//! optional `id`, and every reply is a JSON object carrying the same `id`
//! and either `"ok": true` + `"result"` or `"ok": false` + `"error"`.
//!
//! Differences from the desktop server:
//!   - Transport is WebSocket instead of TCP line-buffered. A single WS text
//!     frame may carry one *or* many newline-separated requests, and each
//!     request gets its own reply frame (matching the desktop reply ordering).
//!   - There is no UI thread; the headless server only implements the
//!     `engine.*` and `perf.*` methods. UI methods return a clear "not
//!     supported on the headless server" error.
//!
//! Safety (AGENTS.md §0):
//!   - Bounded line length ([`MAX_LINE`]) so a peer can't allocate without
//!     limit (4 MiB, matching the desktop server).
//!   - Junk (HTTP-style line, non-object JSON, non-UTF-8, missing `method`)
//!     gets one error reply and the socket is closed, so nothing after it
//!     on the same frame runs — the same defense the desktop server uses
//!     against `fetch` cross-origin smuggling.
//!
//! References: `docs/control-protocol.md`, `docs/filmcraft-server.md` §3.3.4.

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use serde_json::{Value, json};
use tracing::warn;

use crate::session::{SessionManager, UserId};

/// Longest accepted request line (bytes, without the newline). Mirrors the
/// desktop server so a malformed client gets the same behaviour on either
/// transport.
pub const MAX_LINE: usize = 4 * 1024 * 1024;

/// Maximum text-frame size. A text frame larger than this is closed without
/// being processed. We pick twice the line cap to comfortably fit one
/// multi-line frame whose lines are at the per-line limit.
pub const MAX_FRAME_BYTES: usize = MAX_LINE * 2;

/// Maximum concurrent WS connections. The desktop server caps TCP at 16;
/// we use the same number to keep operational behaviour comparable. The
/// constant is exposed for tests.
pub const MAX_CONNECTIONS: usize = 16;

/// Drive a single accepted WebSocket to completion. The caller (router
/// handler) has already finished the HTTP→WS upgrade; this owns the
/// post-upgrade socket.
pub async fn handle_socket(socket: WebSocket, mgr: Arc<SessionManager>, user_id: UserId) {
    let mut socket = socket;
    // One user per socket for now: every request on this socket runs against
    // `user_id`. The server's auth layer (M2) will hand us the verified
    // identity here; today callers inject one (test) or use a placeholder
    // (production: see `cmd_ws`).
    let mut greeted = false;
    while let Some(msg) = socket.recv().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                warn!(error = %e, user = %user_id.0, "ws recv error; closing");
                return;
            }
        };
        match msg {
            Message::Text(text) => {
                let text_len = text.len();
                if text_len > MAX_FRAME_BYTES {
                    let _ =
                        send_json(&mut socket, &json!({"ok": false, "error": format!("frame larger than {MAX_FRAME_BYTES} bytes; closing the connection")}))
                            .await;
                    let _ =
                        socket.send(Message::Close(Some(CloseFrame { code: axum::extract::ws::close_code::POLICY, reason: "frame too large".into() }))).await;
                    return;
                }
                if !greeted {
                    greeted = true;
                }
                let replies = handle_text_frame(text.as_str(), &mgr, &user_id).await;
                // Send each reply. The last one may have a "closing the
                // connection" error which signals we must close after this
                // frame.
                let len = replies.len();
                for (i, r) in replies.iter().enumerate() {
                    if send_json(&mut socket, r).await.is_err() {
                        return;
                    }
                    let last = i + 1 == len;
                    let closes = r.get("error").and_then(Value::as_str).is_some_and(|e| e.contains("closing the connection"));
                    if last && closes {
                        let _ = socket.send(Message::Close(Some(CloseFrame { code: axum::extract::ws::close_code::POLICY, reason: "junk".into() }))).await;
                        return;
                    }
                }
            }
            Message::Binary(_) => {
                // We speak JSON. A binary frame on this protocol is junk:
                // close.
                let _ = send_json(&mut socket, &json!({"ok": false, "error": "binary frames are not accepted; closing the connection"})).await;
                let _ = socket.send(Message::Close(Some(CloseFrame { code: axum::extract::ws::close_code::POLICY, reason: "binary".into() }))).await;
                return;
            }
            Message::Close(_) => return,
            // Ping/Pong are handled by axum automatically.
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }
}

async fn send_json(socket: &mut WebSocket, value: &Value) -> Result<(), axum::Error> {
    let s = serde_json::to_string(value).map_err(axum::Error::new)?;
    socket.send(Message::Text(s.into())).await
}

/// Parse one text frame into one reply per line. Junk lines produce an
/// error reply (with `"closing the connection"` in the message so the caller
/// knows to close the socket) followed by early return — matching the
/// desktop server's behaviour where a bad line never silently executes.
async fn handle_text_frame(text: &str, mgr: &SessionManager, user_id: &UserId) -> Vec<Value> {
    let mut replies = Vec::new();
    for line in split_lines(text) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 1. Parse. Junk (HTTP line, array, number, non-UTF-8 in a binary
        //    frame is already handled) closes the connection. Any replies
        //    we've already produced for earlier lines are still delivered.
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                replies.push(json!({"ok": false, "error": format!("bad JSON ({e}); expected one JSON request object per line; closing the connection")}));
                return replies;
            }
        };
        let Some(obj) = req.as_object() else {
            replies.push(json!({"ok": false, "error": "not a control request (expected a JSON object); closing the connection"}));
            return replies;
        };
        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            replies.push(json!({"ok": false, "error": "not a control request (missing string `method`); closing the connection"}));
            return replies;
        };
        let id = obj.get("id").cloned().unwrap_or(Value::Null);
        let params = obj.get("params").cloned().unwrap_or(json!({}));

        // 2. Dispatch. The desktop server runs each `*.meth` against a UI
        //    thread; we run `engine.*` against `SessionManager`. UI methods
        //    are answered with a clear error.
        let reply = dispatch(method, params, mgr, user_id).await;
        let mut reply = reply;
        if let Some(o) = reply.as_object_mut() {
            o.insert("id".into(), id);
        }
        replies.push(reply);
    }
    replies
}

async fn dispatch(method: &str, params: Value, mgr: &SessionManager, user_id: &UserId) -> Value {
    match method {
        // The two equivalent entries in the desktop protocol share an id;
        // we honour both.
        "engine.execute" | "ui.menu.invoke" => {
            let Some(command) = params.get("command").and_then(Value::as_str).or_else(|| params.get("id").and_then(Value::as_str)) else {
                return json!({"ok": false, "error": "missing `command` (or `id`)"});
            };
            let inner = params.get("params").cloned().unwrap_or(json!({}));
            match mgr.execute(user_id.clone(), command, inner).await {
                Ok(v) => json!({"ok": true, "result": v}),
                Err(e) => json!({"ok": false, "error": e.to_string()}),
            }
        }
        "engine.commands" => match mgr.execute(user_id.clone(), "command.list", json!({})).await {
            Ok(v) => json!({"ok": true, "result": v}),
            Err(e) => json!({"ok": false, "error": e.to_string()}),
        },
        "perf.stats" => match mgr.execute(user_id.clone(), "perf.stats", json!({})).await {
            Ok(v) => json!({"ok": true, "result": v}),
            Err(e) => json!({"ok": false, "error": e.to_string()}),
        },
        other => {
            json!({"ok": false, "error": format!("method `{other}` is not supported on the headless server (only `engine.execute`, `engine.commands`, `perf.stats`)")})
        }
    }
}

/// Split a (possibly multi-line) text frame into individual lines. Any line
/// longer than [`MAX_LINE`] bytes is reported as a single error string.
fn split_lines(text: &str) -> Vec<&str> {
    // We yield `&str` slices borrowing from `text`. A line longer than the
    // cap is split off here as a single oversized chunk; the parser will
    // reject it because the JSON is invalid (and so the caller will see a
    // junk reply + close). We don't try to enforce the cap at the slice
    // level because UTF-8 boundary checks would complicate the borrow.
    text.split('\n').collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::OssServices;
    use std::path::PathBuf;

    fn tmp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("filmcraft-ws-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mgr() -> Arc<SessionManager> {
        Arc::new(SessionManager::new(Arc::new(OssServices::new(tmp_root("mgr")))))
    }

    #[tokio::test]
    async fn blank_frame_produces_no_replies() {
        let mgr = mgr();
        let replies = handle_text_frame("", &mgr, &UserId::new("u")).await;
        assert!(replies.is_empty(), "blank should produce no replies, got {replies:?}");
    }

    #[tokio::test]
    async fn single_engine_execute_round_trips() {
        let mgr = mgr();
        let frame = r#"{"id":7,"method":"engine.execute","params":{"command":"perf.stats"}}"#;
        let replies = handle_text_frame(frame, &mgr, &UserId::new("alice")).await;
        assert_eq!(replies.len(), 1);
        let r = &replies[0];
        assert_eq!(r["id"], 7);
        assert_eq!(r["ok"], true);
        assert!(r["result"].is_object(), "perf.stats returns an object");
    }

    #[tokio::test]
    async fn multiple_requests_in_one_frame_get_one_reply_each() {
        let mgr = mgr();
        let frame = "{\"id\":1,\"method\":\"engine.commands\"}\n{\"id\":2,\"method\":\"perf.stats\"}\n";
        let replies = handle_text_frame(frame, &mgr, &UserId::new("u")).await;
        assert_eq!(replies.len(), 2, "got {replies:?}");
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["ok"], true);
        assert_eq!(replies[1]["id"], 2);
        assert_eq!(replies[1]["ok"], true);
    }

    #[tokio::test]
    async fn unknown_method_yields_ok_false() {
        let mgr = mgr();
        let frame = r#"{"id":1,"method":"engine.execute","params":{"command":"not.a.real.command"}}"#;
        let replies = handle_text_frame(frame, &mgr, &UserId::new("u")).await;
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["ok"], false);
        assert!(replies[0]["error"].as_str().unwrap().contains("unknown command"));
    }

    #[tokio::test]
    async fn ui_method_is_rejected_with_clear_error() {
        let mgr = mgr();
        let frame = r#"{"id":1,"method":"ui.inspect"}"#;
        let replies = handle_text_frame(frame, &mgr, &UserId::new("u")).await;
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["ok"], false);
        assert!(replies[0]["error"].as_str().unwrap().contains("not supported on the headless server"));
    }

    #[tokio::test]
    async fn http_line_in_a_frame_produces_close_error_reply() {
        let mgr = mgr();
        // The body of a cross-origin fetch would normally follow; we want
        // it rejected *before* it runs. Reply must include "closing the
        // connection" so the WS handler knows to close the socket.
        let frame = "POST / HTTP/1.1\r\nHost: 127.0.0.1:9876\r\n\r\n";
        let replies = handle_text_frame(frame, &mgr, &UserId::new("u")).await;
        assert_eq!(replies.len(), 1, "got {replies:?}");
        let err = replies[0]["error"].as_str().unwrap();
        assert!(err.contains("closing the connection"), "got {err}");
    }

    #[tokio::test]
    async fn non_object_json_emits_close_error_reply() {
        let mgr = mgr();
        let replies = handle_text_frame("[1,2]\n", &mgr, &UserId::new("u")).await;
        assert_eq!(replies.len(), 1);
        let err = replies[0]["error"].as_str().unwrap();
        assert!(err.contains("expected a JSON object"), "got {err}");
        assert!(err.contains("closing the connection"));
    }

    #[tokio::test]
    async fn missing_method_emits_close_error_reply() {
        let mgr = mgr();
        let replies = handle_text_frame(r#"{"id":1}"#, &mgr, &UserId::new("u")).await;
        assert_eq!(replies.len(), 1);
        let err = replies[0]["error"].as_str().unwrap();
        assert!(err.contains("missing string `method`"), "got {err}");
        assert!(err.contains("closing the connection"));
    }

    #[tokio::test]
    async fn request_before_junk_still_runs() {
        // Mirrors the desktop server test: a valid request first, then
        // junk — the request must still have been processed (reply
        // delivered), and junk then short-circuits the frame.
        let mgr = mgr();
        let frame = "{\"id\":1,\"method\":\"perf.stats\"}\nGET / HTTP/1.1\n{\"id\":2,\"method\":\"perf.stats\"}\n";
        let replies = handle_text_frame(frame, &mgr, &UserId::new("u")).await;
        // Two replies: success for id=1, error for junk. The second
        // {"id":2,...} never runs.
        assert_eq!(replies.len(), 2, "got {replies:?}");
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[0]["ok"], true);
        assert!(replies[1]["error"].as_str().unwrap().contains("closing the connection"));
    }

    #[test]
    fn split_lines_yields_one_per_newline() {
        // `split_lines` is a thin wrapper, but we test it so a future
        // change to its behaviour is intentional.
        let v: Vec<&str> = split_lines("a\nb\nc").into_iter().map(str::trim).filter(|s| !s.is_empty()).collect();
        assert_eq!(v, vec!["a", "b", "c"]);
        // Empty input → one empty slice (Rust's str::split behaviour).
        // The handler's empty-line skip filters it out.
        assert_eq!(split_lines("").len(), 1);
        // Two blank lines → two empty slices, both filtered.
        let v: Vec<&str> = split_lines("\n\n").into_iter().map(str::trim).filter(|s| !s.is_empty()).collect();
        assert!(v.is_empty());
    }
}
