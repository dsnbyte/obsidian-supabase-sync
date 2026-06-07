import {
  Plugin,
  TAbstractFile,
  Notice,
  Platform
} from "obsidian";
import { SupabaseClient } from "@supabase/supabase-js";
import type { QueueItem, SyncMetadata, SupabaseSyncSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import {
  initSupabaseClient as _initSupabaseClient,
  clearInitClientDebounceTimer,
  checkAuth as _checkAuth,
  signIn as _signIn,
  signOut as _signOut,
  registerDevice as _registerDevice,
  updateDeviceLastSync as _updateDeviceLastSync
} from "./supabase-client";
import {
  runSync as _runSync,
  triggerDebouncedSync as _triggerDebouncedSync,
  startIntervalSync as _startIntervalSync,
  stopIntervalSync as _stopIntervalSync
} from "./sync-engine";
import {
  handleFileChange as _handleFileChange,
  handleFileRename as _handleFileRename
} from "./file-operations";
import {
  loadSyncQueue as _loadSyncQueue,
  saveSyncQueue as _saveSyncQueue,
  loadSyncMetadata as _loadSyncMetadata,
  saveSyncMetadata as _saveSyncMetadata
} from "./state";
import { showConfirm } from "./modals";
import { SupabaseSyncSettingTab } from "./settings-tab";


export default class SupabaseSyncPlugin extends Plugin {
  settings!: SupabaseSyncSettings;
  supabase: SupabaseClient | null = null;
  syncQueue: QueueItem[] = [];
  syncMetadata: SyncMetadata = { lastSyncTime: 0, files: {} };
  statusBarItem!: HTMLElement;
  isSyncing = false;
  debounceTimer: number | null = null;

  // Authentication and Device tracking states
  currentUserId: string | null = null;
  currentUserEmail: string | null = null;
  deviceId: string | null = null;

  // --- Path Getters ---

  get configDir(): string {
    return this.app.vault.configDir;
  }

  get pluginDir(): string {
    return `${this.configDir}/plugins/obsidian-supabase-sync`;
  }

  get syncQueuePath(): string {
    return `${this.pluginDir}/sync-queue.json`;
  }

  get syncMetadataPath(): string {
    return `${this.pluginDir}/sync-metadata.json`;
  }

  // --- Plugin Lifecycle ---

  async onload() {
    console.log("Loading Supabase Vault Sync Plugin...");

    // Load configurations and metadata
    await this.loadSettings();
    await this.loadSyncQueue();
    await this.loadSyncMetadata();

    // Create Settings Tab
    this.addSettingTab(new SupabaseSyncSettingTab(this.app, this));

    // Create Status Bar Item
    this.statusBarItem = this.addStatusBarItem();

    // Initialize Supabase Client
    await this.initSupabaseClient();

    // Create Ribbon Icon for quick sync
    this.addRibbonIcon("refresh-cw", "Sync Obsidian to Supabase", async () => {
      new Notice("Starting sync...");
      await this.runSync();
    });

    // Add manual sync command
    this.addCommand({
      id: "sync-now",
      name: "Sync Vault with Supabase Now",
      callback: () => {
        void this.runSync();
      }
    });

    // Add command to clear sync metadata (re-sync all)
    this.addCommand({
      id: "clear-sync-metadata",
      name: "Reset Sync Metadata (Re-sync all files)",
      callback: async () => {
        this.syncMetadata = {
          lastSyncTime: 0,
          lastSyncedUrl: this.settings.supabaseUrl,
          files: {}
        };
        await this.saveSyncMetadata();
        new Notice("Sync metadata reset! The next sync will scan and upload/update all files.");
      }
    });

    // Register file change listeners
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.handleFileChange(file, "upload"))
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.handleFileChange(file, "upload"))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.handleFileChange(file, "delete"))
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.handleFileRename(file, oldPath))
    );

    // Trigger initial sync on startup
    if (this.supabase && this.currentUserId && this.settings.vaultId) {
      window.setTimeout(() => {
        void this.runSync();
      }, 5000); // Delay slightly to allow vault index to settle
    }

    // Start interval sync if configured
    this.startIntervalSync();
  }

  onunload() {
    console.log("Unloading Supabase Vault Sync Plugin...");
    clearInitClientDebounceTimer();
    this.stopIntervalSync();
  }

  // --- Settings ---

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SupabaseSyncSettings>);

    // Auto-detect Device Name if not set
    if (!this.settings.deviceName) {
      let defaultName = "";
      if (Platform.isDesktop) {
        try {
          defaultName = (typeof process !== "undefined" && process.env)
            ? (process.env.COMPUTERNAME || process.env.HOSTNAME || "")
            : "";
        } catch (e) {
          console.warn("Failed to read hostname:", e);
        }
      }
      if (!defaultName) {
        const platformStr = Platform.isDesktop ? "Desktop" : Platform.isMobile ? "Mobile" : "Tablet";
        defaultName = `Obsidian (${platformStr})`;
      }
      this.settings.deviceName = defaultName;
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.initSupabaseClient(1000); // Debounce by 1 second to handle active typing
  }

  // --- Status & UI Update ---

  updateStatusBar(status: string) {
    this.statusBarItem.setText(`Supabase Sync: ${status}`);
  }

  updateStatusBarBasedOnState() {
    if (!this.supabase) {
      this.updateStatusBar("Configuration Required");
    } else if (!this.currentUserId) {
      this.updateStatusBar("Login Required");
    } else if (!this.settings.vaultId) {
      this.updateStatusBar("Vault ID Required");
    } else {
      this.updateStatusBar("Ready");
    }
  }

  // --- Vault ID Management ---

  async updateVaultId(newVaultId: string): Promise<boolean> {
    const oldVaultId = this.settings.vaultId;
    if (oldVaultId === newVaultId) return true;

    let shouldMigrate = true;

    if (this.supabase && this.currentUserId) {
      try {
        // 1. Check if there are already vault files with the new Vault ID in DB
        const { data: newFiles, error: newError } = await this.supabase
          .from("obsidian_vault_files")
          .select("path")
          .eq("user_id", this.currentUserId)
          .eq("vault_id", newVaultId)
          .limit(1);

        if (newError) throw newError;

        if (newFiles && newFiles.length > 0) {
          const confirmMix = await showConfirm(
            this.app,
            `A vault with the ID "${newVaultId}" already exists in the database. If you proceed, synchronization will switch to the new vault ID, and your local notes will merge with the database. The old vault ID's remote data will not be changed. Are you sure you want to proceed?`
          );
          if (!confirmMix) {
            return false;
          }
          // Do not migrate/rename old vault ID in DB when switching to an existing vault
          shouldMigrate = false;
        } else {
          // 2. Check if there are vault files with the old Vault ID in DB to migrate/rename
          if (oldVaultId) {
            const { data: oldFiles, error: oldError } = await this.supabase
              .from("obsidian_vault_files")
              .select("path")
              .eq("user_id", this.currentUserId)
              .eq("vault_id", oldVaultId)
              .limit(1);

            if (oldError) throw oldError;

            if (oldFiles && oldFiles.length > 0) {
              // 3. Check if any OTHER device (besides this one) has ever synced to the old vault.
              //    A device that has synced at least once will have last_sync_at NOT NULL.
              //    If such a device exists, we must NOT rename/migrate vault_id in DB to avoid
              //    breaking other devices still pointing to the old vault ID.
              const { data: otherSyncedDevices, error: devCheckError } = await this.supabase
                .from("obsidian_sync_devices")
                .select("id")
                .eq("user_id", this.currentUserId)
                .eq("vault_id", oldVaultId)
                .not("id", "eq", this.deviceId ?? "")
                .not("last_sync_at", "is", null)
                .limit(1);

              if (devCheckError) throw devCheckError;

              const otherDevicesHaveSynced = otherSyncedDevices && otherSyncedDevices.length > 0;

              if (otherDevicesHaveSynced) {
                // Other devices have synced to this vault — migrating vault_id would break them.
                // Instead, switch to a fresh sync under the new vault ID.
                const confirmFreshSync = await showConfirm(
                  this.app,
                  `Other devices have already synced to vault "${oldVaultId}". Renaming the vault ID in the database would break their sync. Instead, a fresh sync will be started under the new vault ID "${newVaultId}". Your local notes will be uploaded to the new vault. Are you sure you want to proceed?`
                );
                if (!confirmFreshSync) {
                  return false;
                }
                // Do not migrate — just switch vault ID and let the next sync handle it
                shouldMigrate = false;
              } else {
                // No other device has synced — safe to rename vault_id in DB
                const confirmRename = await showConfirm(
                  this.app,
                  `The vault ID in the database will be renamed from "${oldVaultId}" to "${newVaultId}". Are you sure you want to proceed?`
                );
                if (!confirmRename) {
                  return false;
                }
                shouldMigrate = true;
              }
            } else {
              shouldMigrate = false;
            }
          } else {
            shouldMigrate = false;
          }
        }
      } catch (e) {
        console.error("Failed to check existing vault files in database:", e);
        const errorMsg = e instanceof Error ? e.message : String(e);
        new Notice(`Failed to check existing vault files: ${errorMsg}. Action aborted.`);
        return false;
      }
    }

    if (shouldMigrate && this.supabase && this.currentUserId && oldVaultId) {
      try {
        console.log(`Migrating database files from vault ID "${oldVaultId}" to "${newVaultId}"...`);

        // Update vault_id in obsidian_vault_files
        const { error: filesError } = await this.supabase
          .from("obsidian_vault_files")
          .update({ vault_id: newVaultId })
          .eq("user_id", this.currentUserId)
          .eq("vault_id", oldVaultId);

        if (filesError) throw filesError;

        // Update vault_id in obsidian_sync_devices
        const { error: devicesError } = await this.supabase
          .from("obsidian_sync_devices")
          .update({ vault_id: newVaultId })
          .eq("user_id", this.currentUserId)
          .eq("vault_id", oldVaultId);

        if (devicesError) {
          console.warn("Could not update obsidian_sync_devices vault_id:", devicesError);
        }

        new Notice(`Migrated remote vault data to new ID: ${newVaultId}`);
      } catch (e) {
        console.error("Failed to migrate vault ID in remote database:", e);
        new Notice("Warning: Failed to update vault ID in database. Saved locally, but remote files could not be migrated.");
      }
    }

    this.settings.vaultId = newVaultId;
    await this.saveSettings();

    // Re-register device under new vault_id
    if (this.supabase && this.currentUserId) {
      await this.registerDevice();
    }

    // Clear sync metadata lastSyncedUrl or trigger a resync to realign
    this.syncMetadata.lastSyncTime = 0;
    await this.saveSyncMetadata();

    return true;
  }

  // --- Delegated Methods: Supabase Client & Auth ---

  async initSupabaseClient(debounceMs = 0) {
    return _initSupabaseClient(this, debounceMs);
  }

  async checkAuth() {
    return _checkAuth(this);
  }

  async signIn(email: string, password: string) {
    return _signIn(this, email, password);
  }

  async signOut() {
    return _signOut(this);
  }

  async registerDevice() {
    return _registerDevice(this);
  }

  async updateDeviceLastSync() {
    return _updateDeviceLastSync(this);
  }

  // --- Delegated Methods: State Persistence ---

  async loadSyncQueue() {
    return _loadSyncQueue(this);
  }

  async saveSyncQueue() {
    return _saveSyncQueue(this);
  }

  async loadSyncMetadata() {
    return _loadSyncMetadata(this);
  }

  async saveSyncMetadata() {
    return _saveSyncMetadata(this);
  }

  // --- Delegated Methods: Sync Engine ---

  async runSync() {
    return _runSync(this);
  }

  triggerDebouncedSync() {
    return _triggerDebouncedSync(this);
  }

  startIntervalSync() {
    return _startIntervalSync(this);
  }

  stopIntervalSync() {
    return _stopIntervalSync();
  }

  // --- Delegated Methods: File Operations ---

  async handleFileChange(file: TAbstractFile, action: "upload" | "delete") {
    return _handleFileChange(this, file, action);
  }

  async handleFileRename(file: TAbstractFile, oldPath: string) {
    return _handleFileRename(this, file, oldPath);
  }

  // --- UI Helpers ---

  async showConfirm(message: string): Promise<boolean> {
    return showConfirm(this.app, message);
  }
}
