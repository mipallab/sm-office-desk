use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::state::write_private_file;

const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueuedCaptureMeta {
    pub session_id: String,
    pub capture_type: String,
    pub capture_status: String,
    pub request_id: Option<String>,
    pub monitor_count: u32,
    pub width: u32,
    pub height: u32,
    pub captured_at_client_monotonic_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedCapture {
    pub meta: QueuedCaptureMeta,
    pub webp_bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct EncryptedQueue {
    queue_dir: PathBuf,
    key_path: PathBuf,
}

impl EncryptedQueue {
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        let queue_dir = app_data_dir.join("offline_queue");
        let key_path = app_data_dir.join("queue.key");
        fs::create_dir_all(&queue_dir).map_err(|e| format!("Failed to create queue dir: {e}"))?;
        let queue = Self {
            queue_dir,
            key_path,
        };
        let _ = queue.load_or_create_key()?;
        Ok(queue)
    }

    fn load_or_create_key(&self) -> Result<[u8; KEY_LEN], String> {
        if let Ok(existing) = fs::read(&self.key_path) {
            if existing.len() == KEY_LEN {
                let mut key = [0u8; KEY_LEN];
                key.copy_from_slice(&existing);
                return Ok(key);
            }
        }
        let mut key = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut key);
        write_private_file(&self.key_path, &key)?;
        Ok(key)
    }

    pub fn enqueue(&self, item: &QueuedCapture) -> Result<PathBuf, String> {
        let key_bytes = self.load_or_create_key()?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));

        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let meta_json = serde_json::to_vec(&item.meta)
            .map_err(|e| format!("Failed to serialize queued capture meta: {e}"))?;
        let meta_len = u32::try_from(meta_json.len())
            .map_err(|_| "Queued capture metadata too large".to_string())?;

        let mut plaintext = Vec::with_capacity(4 + meta_json.len() + item.webp_bytes.len());
        plaintext.extend_from_slice(&meta_len.to_be_bytes());
        plaintext.extend_from_slice(&meta_json);
        plaintext.extend_from_slice(&item.webp_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plaintext.as_ref())
            .map_err(|e| format!("AES-GCM encryption failed: {e}"))?;

        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);

        let ts_ms = chrono::Utc::now().timestamp_millis().max(0);
        let filename = format!("{:016}_{}.enc", ts_ms, Uuid::new_v4());
        let file_path = self.queue_dir.join(filename);
        write_private_file(&file_path, &blob)?;
        Ok(file_path)
    }

    pub fn list_pending(&self) -> Result<Vec<PathBuf>, String> {
        let entries = fs::read_dir(&self.queue_dir)
            .map_err(|e| format!("Failed to read offline queue directory: {e}"))?;
        let mut files: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("enc"))
            .collect();
        files.sort();
        Ok(files)
    }

    pub fn count(&self) -> usize {
        self.list_pending().map(|v| v.len()).unwrap_or(0)
    }

    pub fn read_item(&self, path: &Path) -> Result<QueuedCapture, String> {
        let blob = fs::read(path).map_err(|e| format!("Failed to read queued file: {e}"))?;
        if blob.len() <= NONCE_LEN {
            return Err("Corrupted queued file: too short".to_string());
        }
        let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);

        let key_bytes = self.load_or_create_key()?;
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        let nonce = Nonce::from_slice(nonce_bytes);

        let plaintext = cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| "Failed to decrypt queued capture (AES-GCM tag mismatch)".to_string())?;

        if plaintext.len() < 4 {
            return Err("Corrupted queued payload header".to_string());
        }
        let meta_len = u32::from_be_bytes([plaintext[0], plaintext[1], plaintext[2], plaintext[3]]) as usize;
        if plaintext.len() < 4 + meta_len {
            return Err("Corrupted queued payload length".to_string());
        }
        let meta_bytes = &plaintext[4..4 + meta_len];
        let webp_bytes = plaintext[4 + meta_len..].to_vec();

        let meta: QueuedCaptureMeta = serde_json::from_slice(meta_bytes)
            .map_err(|e| format!("Invalid queued metadata JSON: {e}"))?;

        Ok(QueuedCapture { meta, webp_bytes })
    }

    pub fn remove_item(&self, path: &Path) -> Result<(), String> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Failed to delete queued item: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_queue_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sm_office_test_{}_{}", name, Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn aes_gcm_queue_encrypt_decrypt_round_trip_and_wipe() {
        let dir = temp_queue_dir("roundtrip");
        let queue = EncryptedQueue::new(&dir).unwrap();

        let item = QueuedCapture {
            meta: QueuedCaptureMeta {
                session_id: Uuid::new_v4().to_string(),
                capture_type: "random".to_string(),
                capture_status: "ok".to_string(),
                request_id: None,
                monitor_count: 2,
                width: 1600,
                height: 900,
                captured_at_client_monotonic_ms: 42_000,
            },
            webp_bytes: b"RIFF\x24\x00\x00\x00WEBPVP8 fakebytes".to_vec(),
        };

        let path = queue.enqueue(&item).unwrap();
        assert_eq!(queue.count(), 1);

        // Ensure ciphertext on disk does not leak plaintext magic bytes or session_id
        let raw_on_disk = fs::read(&path).unwrap();
        assert!(!raw_on_disk.windows(4).any(|w| w == b"RIFF"));
        assert!(!raw_on_disk
            .windows(item.meta.session_id.len())
            .any(|w| w == item.meta.session_id.as_bytes()));

        let decoded = queue.read_item(&path).unwrap();
        assert_eq!(decoded, item);

        queue.remove_item(&path).unwrap();
        assert_eq!(queue.count(), 0);
        assert!(!path.exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn aes_gcm_queue_rejects_tampered_ciphertext() {
        let dir = temp_queue_dir("tamper");
        let queue = EncryptedQueue::new(&dir).unwrap();

        let item = QueuedCapture {
            meta: QueuedCaptureMeta {
                session_id: Uuid::new_v4().to_string(),
                capture_type: "on_demand".to_string(),
                capture_status: "ok".to_string(),
                request_id: Some(Uuid::new_v4().to_string()),
                monitor_count: 1,
                width: 1440,
                height: 900,
                captured_at_client_monotonic_ms: 1234,
            },
            webp_bytes: b"RIFF\x10\x00\x00\x00WEBPVP8 ".to_vec(),
        };

        let path = queue.enqueue(&item).unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        fs::write(&path, bytes).unwrap();

        let err = queue.read_item(&path).unwrap_err();
        assert!(err.contains("AES-GCM"));

        let _ = fs::remove_dir_all(&dir);
    }
}
