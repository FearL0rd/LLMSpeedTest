use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use sysinfo::System;
use tauri::ipc::Channel;

/// OpenAI-compatible streaming request configuration.
///
/// Field names use camelCase on the wire so the frontend can pass its
/// TypeScript config object directly to `invoke("stream_completion", ...)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfig {
    pub endpoint: String,
    pub api_key: Option<String>,
    pub model: String,
    pub system_prompt: Option<String>,
    pub prompt: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub min_tokens: Option<u32>,
    pub ignore_eos: Option<bool>,
    pub include_usage: Option<bool>,
}

/// Streams a chat completion from any OpenAI-compatible endpoint.
///
/// Each SSE `data:` payload is forwarded to the frontend as a raw JSON string
/// via the provided channel; the TypeScript metrics engine owns all parsing so
/// there is a single source of truth for metric extraction.
///
/// Kept crate-private: `pub` commands trigger an E0255 macro re-import
/// conflict in the tauri command macro expansion on this toolchain.
#[tauri::command]
async fn stream_completion(config: StreamConfig, on_chunk: Channel<String>) -> Result<(), String> {
    let url = normalize_endpoint(&config.endpoint);

    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = config.system_prompt.as_deref() {
        if !sys.trim().is_empty() {
            messages.push(serde_json::json!({ "role": "system", "content": sys }));
        }
    }
    messages.push(serde_json::json!({ "role": "user", "content": config.prompt }));

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true
    });
    if let Some(t) = config.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = config.max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }
    if let Some(m) = config.min_tokens {
        body["min_tokens"] = serde_json::json!(m);
    }
    if let Some(e) = config.ignore_eos {
        body["ignore_eos"] = serde_json::json!(e);
    }
    if config.include_usage.unwrap_or(true) {
        body["stream_options"] = serde_json::json!({ "include_usage": true });
    }

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .json(&body)
        .header("accept", "application/json");
    if let Some(key) = config.api_key.as_deref() {
        if !key.trim().is_empty() {
            req = req.bearer_auth(key);
        }
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate(&text, 500)));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|e| format!("Stream error: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(nl) = buffer.find('\n') {
            let line = buffer[..nl].trim().to_string();
            buffer.drain(..=nl);

            let Some(payload) = parse_sse_data(&line) else {
                continue;
            };
            if payload == "[DONE]" {
                return Ok(());
            }
            // Only forward valid JSON objects; ignore comments/keep-alives.
            if serde_json::from_str::<Value>(&payload).is_ok() {
                let _ = on_chunk.send(payload);
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Endpoint probing: the OpenAI protocol carries no hardware info, so we probe
// well-known engine-specific paths (same port, plain HTTP) to identify the
// engine and its loaded models / VRAM footprint. Detection itself happens in
// the frontend over these raw results, keeping it unit-testable.
// ---------------------------------------------------------------------------

const PROBE_PATHS: &[&str] = &[
    "/api/version",
    "/api/ps",
    "/version",
    "/props",
    "/get_server_info",
    "/api/v0/models",
    "/v1/models",
    "/metrics",
];

const PROBE_BODY_LIMIT: usize = 40_000;
const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    path: String,
    /// HTTP status, or 0 when unreachable/timed out.
    status: u16,
    body: Option<String>,
}

#[tauri::command]
async fn probe_endpoint(endpoint: String, api_key: Option<String>) -> Result<Vec<ProbeResult>, String> {
    let base = base_url(&endpoint);
    let client = reqwest::Client::new();

    let futures = PROBE_PATHS.iter().map(|path| {
        let url = format!("{base}{path}");
        let mut req = client.get(&url).timeout(PROBE_TIMEOUT);
        if let Some(key) = api_key.as_deref() {
            if !key.trim().is_empty() {
                req = req.bearer_auth(key);
            }
        }
        async move {
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = if status == 200 {
                        resp.text().await.ok().map(|t| truncate(&t, PROBE_BODY_LIMIT))
                    } else {
                        None
                    };
                    ProbeResult {
                        path: (*path).to_string(),
                        status,
                        body,
                    }
                }
                Err(_) => ProbeResult {
                    path: (*path).to_string(),
                    status: 0,
                    body: None,
                },
            }
        }
    });

    Ok(futures_util::future::join_all(futures).await)
}

/// Strip the OpenAI path suffixes to get the server origin for probing.
fn base_url(endpoint: &str) -> String {
    let mut base = endpoint.trim().trim_end_matches('/').to_string();
    if base.ends_with("/chat/completions") {
        base.truncate(base.len() - "/chat/completions".len());
    }
    if base.ends_with("/v1") {
        base.truncate(base.len() - "/v1".len());
    }
    base.trim_end_matches('/').to_string()
}

// ---------------------------------------------------------------------------
// Local hardware info: auto-fill only applies when the endpoint is served by
// this same machine; for remote endpoints the user labels hardware manually.
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    os: Option<String>,
    cpu: Option<String>,
    cores_physical: Option<u32>,
    cores_logical: u32,
    total_memory_bytes: u64,
    gpus: Vec<String>,
    disks: Vec<DiskInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskInfo {
    name: String,
    mount_point: String,
    /// "SSD" | "HDD" | "Unknown" (as reported by the OS).
    kind: String,
    total_bytes: u64,
    available_bytes: u64,
}

#[tauri::command]
async fn get_system_info() -> Result<SystemInfo, String> {
    // sysinfo calls are blocking but fast; keep them off the async executor.
    let info = tokio::task::spawn_blocking(move || {
        let sys = sysinfo::System::new_all();
        let cpus = sys.cpus();
        let cpu = cpus
            .first()
            .map(|c| c.brand().trim().to_string())
            .filter(|s| !s.is_empty());
        let cores_logical = cpus.len() as u32;
        let cores_physical = sys.physical_core_count().map(|n| n as u32);
        let total_memory_bytes = sys.total_memory();
        let os = System::long_os_version();
        let gpus = detect_gpus();
        let disks = detect_disks();

        SystemInfo {
            os,
            cpu,
            cores_physical,
            cores_logical,
            total_memory_bytes,
            gpus,
            disks,
        }
    })
    .await
    .map_err(|e| format!("system info task failed: {e}"))?;

    Ok(info)
}

fn detect_disks() -> Vec<DiskInfo> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<DiskInfo> = disks
        .list()
        .iter()
        .map(|d| DiskInfo {
            name: d.name().to_string_lossy().to_string(),
            mount_point: d.mount_point().to_string_lossy().to_string(),
            kind: match d.kind() {
                sysinfo::DiskKind::SSD => "SSD".to_string(),
                sysinfo::DiskKind::HDD => "HDD".to_string(),
                _ => "Unknown".to_string(),
            },
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
        })
        // Skip pseudo/loop mounts and empty entries.
        .filter(|d| d.total_bytes > 0 && !d.name.starts_with("/dev/loop"))
        .collect();

    // Keep only the largest mount per physical disk name.
    out.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
    let mut seen = std::collections::HashSet::new();
    out.retain(|d| seen.insert(d.name.clone()));

    if out.is_empty() {
        out = detect_disks_fallback();
    }
    out
}

/// Linux fallback: parse /proc/mounts for real filesystems and statvfs them.
/// Used when the sysinfo disk list comes back empty.
#[cfg(target_os = "linux")]
fn detect_disks_fallback() -> Vec<DiskInfo> {
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return Vec::new();
    };
    const REAL_FS: &[&str] = &[
        "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "ntfs3",
        "ntfs", "vfat", "exfat",
    ];

    let mut out: Vec<DiskInfo> = Vec::new();
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(dev), Some(mnt), Some(fstype)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !REAL_FS.contains(&fstype) || !dev.starts_with("/dev/") {
            continue;
        }
        let Ok(cpath) = std::ffi::CString::new(mnt.as_bytes()) else {
            continue;
        };
        let mut stat = unsafe { std::mem::zeroed::<libc::statvfs>() };
        // SAFETY: cpath outlives the call; stat is a valid, fully-owned buffer.
        if unsafe { libc::statvfs(cpath.as_ptr(), &mut stat) } != 0 {
            continue;
        }
        let frsize = stat.f_frsize.max(stat.f_bsize) as u64;
        out.push(DiskInfo {
            name: dev.to_string(),
            mount_point: mnt.to_string(),
            kind: "Unknown".to_string(),
            total_bytes: stat.f_blocks * frsize,
            available_bytes: stat.f_bavail * frsize,
        });
    }

    out.sort_by(|a, b| b.total_bytes.cmp(&a.total_bytes));
    let mut seen = std::collections::HashSet::new();
    out.retain(|d| seen.insert(d.name.clone()));
    out
}

#[cfg(not(target_os = "linux"))]
fn detect_disks_fallback() -> Vec<DiskInfo> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn detect_gpus() -> Vec<String> {
    #[derive(serde::Deserialize)]
    #[allow(non_snake_case)]
    struct VideoController {
        Name: Option<String>,
    }

    let com = match wmi::COMLibrary::new() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let conn = match wmi::WMIConnection::new(com) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let list: Vec<VideoController> = conn
        .raw_query("SELECT Name FROM Win32_VideoController")
        .unwrap_or_default();
    let mut names: Vec<String> = list
        .into_iter()
        .filter_map(|v| v.Name)
        .filter(|n| !n.trim().is_empty())
        .collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(not(target_os = "windows"))]
fn detect_gpus() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        // pciutils is preinstalled on nearly every desktop/server distro.
        if let Ok(out) = std::process::Command::new("lspci").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut gpus: Vec<String> = text
                .lines()
                .filter(|l| {
                    l.contains("VGA compatible controller")
                        || l.contains("3D controller")
                        || l.contains("Display controller")
                })
                .filter_map(|l| l.split_once(": ").map(|(_, name)| clean_gpu_name(name)))
                .filter(|s| !s.is_empty())
                .collect();
            gpus.sort();
            gpus.dedup();
            if !gpus.is_empty() {
                return gpus;
            }
        }

        // Fallback: scan the PCI bus via sysfs (no external tools needed).
        let sysfs = scan_pci_gpus_sysfs();
        if !sysfs.is_empty() {
            return sysfs;
        }

        // Last resort: NVIDIA proprietary driver proc interface.
        if let Ok(entries) = std::fs::read_dir("/proc/driver/nvidia/gpus") {
            let mut gpus: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| std::fs::read_to_string(e.path().join("information")).ok())
                .filter_map(|info| {
                    info.lines()
                        .find(|l| l.starts_with("Model:"))
                        .map(|l| l.trim_start_matches("Model:").trim().to_string())
                })
                .collect();
            gpus.sort();
            gpus.dedup();
            return gpus;
        }
    }
    Vec::new()
}

/// lspci reports e.g. "NVIDIA Corporation GP106 [GeForce GTX 1060 3GB] (rev a1)".
/// Prefer the bracketed marketing name and drop the revision suffix.
#[cfg(target_os = "linux")]
fn clean_gpu_name(raw: &str) -> String {
    let name = raw.trim();
    let name = name.split(" (rev").next().unwrap_or(name).trim();
    match (name.find('['), name.rfind(']')) {
        (Some(open), Some(close)) if close > open => name[open + 1..close].trim().to_string(),
        _ => name.to_string(),
    }
}

/// Scan /sys/bus/pci/devices for display-class devices (VGA 0x030000,
/// 3D 0x030200, display 0x038000) without needing lspci installed.
#[cfg(target_os = "linux")]
fn scan_pci_gpus_sysfs() -> Vec<String> {
    fn vendor_name(vendor: &str) -> &'static str {
        match vendor {
            "0x1002" | "0x1022" => "AMD",
            "0x10de" => "NVIDIA",
            "0x8086" => "Intel",
            "0x15ad" => "VMware",
            "0x1234" => "QEMU",
            _ => "GPU",
        }
    }

    let Ok(entries) = std::fs::read_dir("/sys/bus/pci/devices") else {
        return Vec::new();
    };
    let mut gpus: Vec<String> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(class) = std::fs::read_to_string(path.join("class")) else {
            continue;
        };
        let class = class.trim();
        if !matches!(class, "0x030000" | "0x030200" | "0x038000") {
            continue;
        }
        let vendor = std::fs::read_to_string(path.join("vendor"))
            .map(|v| v.trim().to_lowercase())
            .unwrap_or_default();
        let device = std::fs::read_to_string(path.join("device"))
            .map(|v| v.trim().trim_start_matches("0x").to_lowercase())
            .unwrap_or_default();
        // Prefer a real product name when the kernel exposes one.
        let label = std::fs::read_to_string(path.join("label"))
            .map(|l| l.trim().to_string())
            .ok()
            .filter(|l| !l.is_empty());
        match label {
            Some(name) => gpus.push(name),
            None => {
                let vendor_short = vendor.trim_start_matches("0x").to_string();
                let id = if device.is_empty() {
                    String::new()
                } else {
                    format!(" ({vendor_short}:{device})")
                };
                gpus.push(format!("{} GPU{id}", vendor_name(&vendor)));
            }
        }
    }
    gpus.sort();
    gpus.dedup();
    gpus
}

// ---------------------------------------------------------------------------

fn parse_sse_data(line: &str) -> Option<String> {
    let rest = line.strip_prefix("data:")?.trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

/// Accepts a bare host, a `/v1` base, or a full `/chat/completions` path.
fn normalize_endpoint(endpoint: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            stream_completion,
            probe_endpoint,
            get_system_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}