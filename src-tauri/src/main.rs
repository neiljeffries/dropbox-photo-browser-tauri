#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

    /// Snapshot the current data and serialize + write to disk on a background thread.
    fn persist_async(self: &Arc<Self>) {
        let data_snapshot = {
            let data = self.data.lock().unwrap();
            data.clone()
        };
        let path = self.path.clone();
        std::thread::spawn(move || {
            if let Ok(json) = serde_json::to_string(&data_snapshot) {
                fs::write(&path, json).ok();
            }
        });
    }
}

#[tauri::command]
fn store_get(key: String, store: State<'_, Arc<AppStore>>) -> Option<Value> {
    let data = store.data.lock().unwrap();
    data.get(&key).cloned()
}

#[tauri::command]
fn store_get_batch(keys: Vec<String>, store: State<'_, Arc<AppStore>>) -> HashMap<String, Value> {
    let data = store.data.lock().unwrap();
    let mut result = HashMap::new();
    for k in keys {
        if let Some(v) = data.get(&k) {
            result.insert(k, v.clone());
        }
    }
    result
}

#[tauri::command]
fn store_set(key: String, value: Value, store: State<'_, Arc<AppStore>>) {
    {
        let mut data = store.data.lock().unwrap();
        data.insert(key, value);
    }
    store.inner().persist_async();
}

#[tauri::command]
fn store_set_batch(entries: HashMap<String, Value>, store: State<'_, Arc<AppStore>>) {
    {
        let mut data = store.data.lock().unwrap();
        for (k, v) in entries {
            data.insert(k, v);
        }
    }
    store.inner().persist_async();
}

#[tauri::command]
fn store_remove(keys: Vec<String>, store: State<'_, Arc<AppStore>>) {
    {
        let mut data = store.data.lock().unwrap();
        for k in &keys {
            data.remove(k);
        }
    }
    store.inner().persist_async();
}

#[tauri::command]
fn store_keys(store: State<'_, Arc<AppStore>>) -> Vec<String> {
    let data = store.data.lock().unwrap();
    data.keys().cloned().collect()
}

/// Accept a key + pre-serialized JSON string so the frontend can offload
/// JSON.stringify to a Web Worker and keep the UI thread free.
#[tauri::command]
fn store_set_raw(key: String, json: String, store: State<'_, Arc<AppStore>>) -> Result<(), String> {
    let value: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    {
        let mut data = store.data.lock().unwrap();
        data.insert(key, value);
    }
    store.inner().persist_async();
    Ok(())
}

#[tauri::command]
fn store_clear_cache(prefix: String, thumb_key: String, store: State<'_, Arc<AppStore>>) {
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
    store.inner().persist_async();
}

#[tauri::command]
fn store_get_all(store: State<'_, Arc<AppStore>>) -> HashMap<String, Value> {
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

#[tauri::command]
async fn download_single_file(
    dropbox_path: String,
    filename: String,
    access_token: String,
) -> Result<bool, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_file_name(&filename)
        .save_file()
        .await;
    let save_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(false),
    };
    let client = reqwest::Client::new();
    let res = client
        .post("https://content.dropboxapi.com/2/files/download")
        .header("Authorization", format!("Bearer {}", access_token))
        .header(
            "Dropbox-API-Arg",
            serde_json::json!({ "path": dropbox_path }).to_string(),
        )
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("Dropbox API error: {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("Read failed: {}", e))?;
    tokio::fs::write(&save_path, &bytes)
        .await
        .map_err(|e| format!("Save failed: {}", e))?;
    Ok(true)
}

#[tauri::command]
async fn download_files_zip(
    dropbox_paths: Vec<String>,
    filenames: Vec<String>,
    access_token: String,
    zip_name: String,
) -> Result<bool, String> {
    use std::io::Write;

    let dialog = rfd::AsyncFileDialog::new()
        .set_file_name(&zip_name)
        .add_filter("ZIP Archive", &["zip"])
        .save_file()
        .await;
    let save_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(false),
    };

    let file = std::fs::File::create(&save_path)
        .map_err(|e| format!("Cannot create file: {}", e))?;
    let mut zip_writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    let client = reqwest::Client::new();

    // Deduplicate filenames
    let mut name_counts: HashMap<String, usize> = HashMap::new();
    let mut unique_names: Vec<String> = Vec::with_capacity(filenames.len());
    for name in &filenames {
        let count = name_counts.entry(name.to_lowercase()).or_insert(0);
        if *count == 0 {
            unique_names.push(name.clone());
        } else {
            let dot_pos = name.rfind('.');
            let unique = if let Some(pos) = dot_pos {
                format!("{} ({}){}", &name[..pos], count, &name[pos..])
            } else {
                format!("{} ({})", name, count)
            };
            unique_names.push(unique);
        }
        *count += 1;
    }

    for (i, dbx_path) in dropbox_paths.iter().enumerate() {
        let fname = &unique_names[i];
        let res = client
            .post("https://content.dropboxapi.com/2/files/download")
            .header("Authorization", format!("Bearer {}", &access_token))
            .header(
                "Dropbox-API-Arg",
                serde_json::json!({ "path": dbx_path }).to_string(),
            )
            .send()
            .await
            .map_err(|e| format!("Download failed for {}: {}", fname, e))?;
        if !res.status().is_success() {
            drop(zip_writer);
            std::fs::remove_file(&save_path).ok();
            return Err(format!("Dropbox error for {}: {}", fname, res.status()));
        }
        let bytes = res
            .bytes()
            .await
            .map_err(|e| format!("Read failed for {}: {}", fname, e))?;
        zip_writer
            .start_file(fname, options)
            .map_err(|e| format!("Zip error: {}", e))?;
        zip_writer
            .write_all(&bytes)
            .map_err(|e| format!("Zip write error: {}", e))?;
    }

    zip_writer
        .finish()
        .map_err(|e| format!("Zip finish error: {}", e))?;
    Ok(true)
}

#[tauri::command]
async fn export_data(json_data: String) -> Result<bool, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .set_file_name("dropbox-photo-browser-backup.json")
        .add_filter("JSON Backup", &["json"])
        .save_file()
        .await;
    let save_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(false),
    };
    tokio::fs::write(&save_path, json_data.as_bytes())
        .await
        .map_err(|e| format!("Export failed: {}", e))?;
    Ok(true)
}

#[tauri::command]
async fn import_data() -> Result<Option<String>, String> {
    let dialog = rfd::AsyncFileDialog::new()
        .add_filter("JSON Backup", &["json"])
        .pick_file()
        .await;
    let file_path = match dialog {
        Some(handle) => handle.path().to_path_buf(),
        None => return Ok(None),
    };
    let contents = tokio::fs::read_to_string(&file_path)
        .await
        .map_err(|e| format!("Import read failed: {}", e))?;
    Ok(Some(contents))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(AppStore::new()))
        .invoke_handler(tauri::generate_handler![
            store_get,
            store_get_batch,
            store_set,
            store_set_batch,
            store_set_raw,
            store_remove,
            store_keys,
            store_clear_cache,
            store_get_all,
            oauth_listen,
            download_single_file,
            download_files_zip,
            export_data,
            import_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
