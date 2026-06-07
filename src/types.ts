// Types for Sync Queue and Sync Metadata
export interface QueueItem {
  action: "upload" | "delete";
  path: string;
  timestamp: number;
  isBinary: boolean;
}

export interface SyncMetadata {
  lastSyncTime: number;
  lastSyncedUrl?: string;
  files: Record<string, {
    mtime: number;
    hash: string;
  }>;
}

export interface SupabaseSyncSettings {
  supabaseUrl: string;
  supabaseKey: string;
  syncOnSave: boolean;
  syncDelay: number; // auto-sync debounce delay in seconds
  syncInterval: number; // auto-sync interval in seconds (0 to 60)
  vaultId: string;
  deviceName: string;
  softDeleteTTL: number;
}

export interface RemoteFile {
  path: string;
  updated_at: string;
  hash: string;
  is_binary: boolean;
  deleted_at: string | null;
  content?: string | null;
}

export interface SyncDevice {
  vault_id: string;
  device_name: string;
  platform: string;
  last_sync_at: string | null;
}

export const DEFAULT_SETTINGS: SupabaseSyncSettings = {
  supabaseUrl: "",
  supabaseKey: "",
  syncOnSave: true,
  syncDelay: 2,
  syncInterval: 0,
  vaultId: "",
  deviceName: "",
  softDeleteTTL: 30
};
