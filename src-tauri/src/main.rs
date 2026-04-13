#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

struct AppStore {
    data: Mutex<HashMap<String, Value>>,
    path: PathBuf,
}

impl AppStore {
    fn new() -> Self {
        let dir = dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("dropbox-photo-browser");
        fs::create_dir_all(&dir).ok();
        let path = dir.join("store.json");
        let data = if path.exists() {
            let raw = fs::read_to_string(&path).unwrap_or_default();
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            HashMap::new()
        };
        AppStore {
            data: Mutex::new(data),
            path,
        }
    }

    fn persist(&self) {
        let data = self.data.lock().unwrap();
        if let Ok(json) = serde_json::to_string(&*data) {
            fs::write(&self.path, json).ok();
        }
    }
}

#[tauri::command]
fn store_get(key: String, store: State<'_, AppStore>) -> Option<Value> {
    let data = store.data.lock().unwrap();
    data.get(&key).cloned()
}

#[tauri::command]
fn store_set(key: String, value: Value, store: State<'_, AppStore>) {
    {
        let mut data = store.data.lock().unwrap();
        data.insert(key, value);
    }
    store.persist();
}

#[tauri::command]
fn store_remove(keys: Vec<String>, store: State<'_, AppStore>) {
    {
        let mut data = store.data.lock().unwrap();
        for k in &keys {
            data.remove(k);
        }
    }
    store.persist();
}

#[tauri::command]
fn store_keys(store: State<'_, AppStore>) -> Vec<String> {
    let data = store.data.lock().unwrap();
    data.keys().cloned().collect()
}

#[tauri::command]
fn store_clear_cache(prefix: String, thumb_key: String, store: State<'_, AppStore>) {
    {
        let mut data = store.data.lock().unwrap();
        let to_remove: Vec<String> = data
            .keys()
            .filter(|k| k.starts_with(&prefix) || *k == &thumb_key)
            .cloned()
            .collect();
        for k in to_remove {
            data.remove(&k);
        }
    }
    store.persist();
}

#[tauri::command]
fn store_get_all(store: State<'_, AppStore>) -> HashMap<String, Value> {
    let data = store.data.lock().unwrap();
    data.clone()
}

#[tauri::command]
async fn oauth_listen(port: u16) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    let addr = format!("127.0.0.1:{}", port);
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind {}: {}", addr, e))?;

    let (stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Accept failed: {}", e))?;

    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);
    let mut request_line = String::new();
    buf_reader
        .read_line(&mut request_line)
        .await
        .map_err(|e| format!("Read failed: {}", e))?;

    // Extract the path from "GET /callback?code=...&state=... HTTP/1.1"
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .to_string();

    // Send a success page — code flow delivers the code as a query param, no JS needed
    let html = r#"<!DOCTYPE html><html><body>
<p>Authentication successful! You can close this tab and return to the app.</p>
</body></html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    writer.write_all(response.as_bytes()).await.ok();

    Ok(path.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppStore::new())
        .invoke_handler(tauri::generate_handler![
            store_get,
            store_set,
            store_remove,
            store_keys,
            store_clear_cache,
            store_get_all,
            oauth_listen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
