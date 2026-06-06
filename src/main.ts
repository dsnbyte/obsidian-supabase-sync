import {
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TAbstractFile,
  Notice,
  Platform,
  Modal
} from "obsidian";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Types for Sync Queue and Sync Metadata
interface QueueItem {
  action: "upload" | "delete";
  path: string;
  timestamp: number;
  isBinary: boolean;
}

interface SyncMetadata {
  lastSyncTime: number;
  lastSyncedUrl?: string;
  files: Record<string, {
    mtime: number;
    hash: string;
  }>;
}

interface SupabaseSyncSettings {
  supabaseUrl: string;
  supabaseKey: string;
  syncOnSave: boolean;
  syncDelay: number; // auto-sync debounce delay in seconds
  syncInterval: number; // auto-sync interval in seconds (0 to 60)
  vaultId: string;
  deviceName: string;
  softDeleteTTL: number;
}

const DEFAULT_SETTINGS: SupabaseSyncSettings = {
  supabaseUrl: "",
  supabaseKey: "",
  syncOnSave: true,
  syncDelay: 2,
  syncInterval: 0,
  vaultId: "",
  deviceName: "",
  softDeleteTTL: 30
};

// TTL for auto soft-delete cleanup: files soft-deleted longer than this are hard-deleted (Fix D)
const SOFT_DELETE_TTL_DAYS = 30;

export default class SupabaseSyncPlugin extends Plugin {
  settings!: SupabaseSyncSettings;
  supabase: SupabaseClient | null = null;
  private activeSupabaseUrl = "";
  private activeSupabaseKey = "";
  syncQueue: QueueItem[] = [];
  syncMetadata: SyncMetadata = { lastSyncTime: 0, files: {} };
  statusBarItem!: HTMLElement;
  isSyncing = false;
  debounceTimer: number | null = null;
  private initClientDebounceTimer: number | null = null;
  private syncIntervalTimer: number | null = null;

  // Authentication and Device tracking states
  currentUserId: string | null = null;
  currentUserEmail: string | null = null;
  deviceId: string | null = null;

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
        this.runSync();
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
      setTimeout(() => this.runSync(), 5000); // Delay slightly to allow vault index to settle
    }

    // Start interval sync if configured
    this.startIntervalSync();
  }

  onunload() {
    console.log("Unloading Supabase Vault Sync Plugin...");
    if (this.initClientDebounceTimer) {
      window.clearTimeout(this.initClientDebounceTimer);
    }
    this.stopIntervalSync();
  }

  startIntervalSync() {
    this.stopIntervalSync();

    if (this.settings.syncInterval > 0) {
      const intervalMs = this.settings.syncInterval * 1000;
      this.syncIntervalTimer = window.setInterval(() => {
        this.handleIntervalSync();
      }, intervalMs);
    }
  }

  stopIntervalSync() {
    if (this.syncIntervalTimer) {
      window.clearInterval(this.syncIntervalTimer);
      this.syncIntervalTimer = null;
    }
  }

  private handleIntervalSync() {
    // Check if the app is hidden/minimized (very battery-friendly, especially on mobile)
    if (document.hidden) {
      console.log("Supabase Sync: Obsidian is in the background. Skipping interval sync to save battery.");
      return;
    }

    if (!this.supabase || !this.currentUserId || !this.settings.vaultId) {
      return;
    }

    console.log("Supabase Sync: Triggering periodic interval sync...");
    this.runSync();
  }

  // --- Initializers & Settings & Auth & Devices ---

  async initSupabaseClient(debounceMs = 0) {
    if (this.initClientDebounceTimer) {
      window.clearTimeout(this.initClientDebounceTimer);
      this.initClientDebounceTimer = null;
    }

    if (debounceMs > 0) {
      this.initClientDebounceTimer = window.setTimeout(async () => {
        await this.initSupabaseClientImmediate();
      }, debounceMs);
    } else {
      await this.initSupabaseClientImmediate();
    }
  }

  private async initSupabaseClientImmediate() {
    if (this.settings.supabaseUrl && this.settings.supabaseKey) {
      if (
        this.supabase &&
        this.activeSupabaseUrl === this.settings.supabaseUrl &&
        this.activeSupabaseKey === this.settings.supabaseKey
      ) {
        return;
      }
      try {
        this.supabase = createClient(this.settings.supabaseUrl, this.settings.supabaseKey, {
          auth: {
            persistSession: true,
            storageKey: "obsidian-supabase-sync-auth"
          }
        });
        this.activeSupabaseUrl = this.settings.supabaseUrl;
        this.activeSupabaseKey = this.settings.supabaseKey;
        console.log("Supabase client initialized successfully.");
        await this.checkAuth();
      } catch (e) {
        console.error("Failed to initialize Supabase client:", e);
        this.supabase = null;
        this.activeSupabaseUrl = "";
        this.activeSupabaseKey = "";
      }
    } else {
      this.supabase = null;
      this.activeSupabaseUrl = "";
      this.activeSupabaseKey = "";
      this.currentUserId = null;
      this.currentUserEmail = null;
      this.deviceId = null;
    }
    this.updateStatusBarBasedOnState();
  }

  async checkAuth(): Promise<boolean> {
    if (!this.supabase) {
      this.currentUserId = null;
      this.currentUserEmail = null;
      this.deviceId = null;
      return false;
    }
    try {
      const { data: { session }, error } = await this.supabase.auth.getSession();
      if (error) throw error;
      if (session && session.user) {
        this.currentUserId = session.user.id;
        this.currentUserEmail = session.user.email ?? null;
        console.log("Supabase Auth: Session restored for", this.currentUserEmail);

        await this.registerDevice();
        this.updateStatusBarBasedOnState();
        return true;
      } else {
        this.currentUserId = null;
        this.currentUserEmail = null;
        this.deviceId = null;
        this.updateStatusBarBasedOnState();
        return false;
      }
    } catch (e) {
      console.error("Supabase Auth: Failed to check session:", e);
      this.currentUserId = null;
      this.currentUserEmail = null;
      this.deviceId = null;
      this.updateStatusBarBasedOnState();
      return false;
    }
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.supabase) {
      throw new Error("Supabase client is not initialized.");
    }
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) {
      throw error;
    }
    if (data.session && data.session.user) {
      this.currentUserId = data.session.user.id;
      this.currentUserEmail = data.session.user.email ?? null;
      new Notice("Login successful!");

      await this.registerDevice();
      this.updateStatusBarBasedOnState();
    }
  }

  async signOut(): Promise<void> {
    if (!this.supabase) return;
    const { error } = await this.supabase.auth.signOut();
    if (error) {
      console.error("Supabase Auth: Sign out error:", error);
    }
    this.currentUserId = null;
    this.currentUserEmail = null;
    this.deviceId = null;
    new Notice("Logged out successfully.");
    this.updateStatusBarBasedOnState();
    this.stopIntervalSync();
  }

  async registerDevice(): Promise<void> {
    if (!this.supabase || !this.currentUserId || !this.settings.vaultId) {
      return;
    }

    if (!this.settings.deviceName) {
      let defaultName = "";
      if (Platform.isDesktop) {
        try {
          const os = require("os");
          defaultName = os.hostname();
        } catch (e) {
          console.warn("Failed to read hostname:", e);
        }
      }
      if (!defaultName) {
        const platformStr = Platform.isDesktop ? "Desktop" : Platform.isMobile ? "Mobile" : "Tablet";
        defaultName = `Obsidian (${platformStr})`;
      }
      this.settings.deviceName = defaultName;
      await this.saveSettings();
    }

    try {
      const { data, error } = await this.supabase
        .from("obsidian_sync_devices")
        .upsert({
          user_id: this.currentUserId,
          vault_id: this.settings.vaultId,
          device_name: this.settings.deviceName,
          platform: Platform.isDesktop ? "Desktop" : Platform.isMobile ? "Mobile" : "Tablet",
          updated_at: new Date().toISOString()
        }, {
          onConflict: "user_id,vault_id,device_name"
        })
        .select("id")
        .maybeSingle();

      if (error) throw error;
      if (data) {
        this.deviceId = data.id;
        console.log("Device registered with ID:", this.deviceId);
      }
    } catch (e) {
      console.warn("Failed to register device in obsidian_sync_devices:", e);
    }
  }

  async updateDeviceLastSync(): Promise<void> {
    if (!this.supabase || !this.currentUserId || !this.deviceId) {
      return;
    }
    try {
      const { error } = await this.supabase
        .from("obsidian_sync_devices")
        .update({
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", this.deviceId);
      if (error) throw error;
    } catch (e) {
      console.warn("Failed to update device last sync time:", e);
    }
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

  async showConfirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      new ConfirmModal(this.app, message, (result) => {
        resolve(result);
      }).open();
    });
  }

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
          const confirmMix = await this.showConfirm(
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
              const confirmRename = await this.showConfirm(
                `The vault ID in the database will be renamed from "${oldVaultId}" to "${newVaultId}". Are you sure you want to proceed?`
              );
              if (!confirmRename) {
                return false;
              }
              shouldMigrate = true;
            } else {
              shouldMigrate = false;
            }
          } else {
            shouldMigrate = false;
          }
        }
      } catch (e: any) {
        console.error("Failed to check existing vault files in database:", e);
        new Notice(`Failed to check existing vault files: ${e.message || e}. Action aborted.`);
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Auto-detect Device Name if not set
    if (!this.settings.deviceName) {
      let defaultName = "";
      if (Platform.isDesktop) {
        try {
          const os = require("os");
          defaultName = os.hostname();
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

  // --- State Persistence Helpers ---

  async loadSyncQueue() {
    const path = ".obsidian/plugins/obsidian-supabase-sync/sync-queue.json";
    if (await this.app.vault.adapter.exists(path)) {
      try {
        const content = await this.app.vault.adapter.read(path);
        this.syncQueue = JSON.parse(content);
      } catch (e) {
        console.error("Failed to load sync queue:", e);
        this.syncQueue = [];
      }
    }
  }

  async saveSyncQueue() {
    const dir = ".obsidian/plugins/obsidian-supabase-sync";
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const path = `${dir}/sync-queue.json`;
    await this.app.vault.adapter.write(path, JSON.stringify(this.syncQueue, null, 2));
  }

  async loadSyncMetadata() {
    const path = ".obsidian/plugins/obsidian-supabase-sync/sync-metadata.json";
    if (await this.app.vault.adapter.exists(path)) {
      try {
        const content = await this.app.vault.adapter.read(path);
        this.syncMetadata = JSON.parse(content);
        if (!this.syncMetadata.files) {
          this.syncMetadata.files = {};
        }
      } catch (e) {
        console.error("Failed to load sync metadata:", e);
        this.syncMetadata = { lastSyncTime: 0, files: {} };
      }
    }
  }

  async saveSyncMetadata() {
    const dir = ".obsidian/plugins/obsidian-supabase-sync";
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    const path = `${dir}/sync-metadata.json`;
    await this.app.vault.adapter.write(path, JSON.stringify(this.syncMetadata, null, 2));
  }

  // --- Status & UI Update ---

  updateStatusBar(status: string) {
    this.statusBarItem.setText(`Supabase Sync: ${status}`);
  }

  // --- Obsidian Event Handlers ---

  async handleFileChange(file: TAbstractFile, action: "upload" | "delete") {
    // Ignore configuration files, sync state, and files in the .trash directory
    if (
      file.path.startsWith(".obsidian") ||
      file.path.startsWith(".trash") ||
      file.path.includes("/.trash/") ||
      file.path.includes("sync-queue") ||
      file.path.includes("sync-metadata")
    ) {
      return;
    }

    if (file instanceof TFile) {
      const isBinary = file.extension.toLowerCase() !== "md";

      // De-duplicate: remove previous items for this path in the queue
      this.syncQueue = this.syncQueue.filter((item) => item.path !== file.path);

      this.syncQueue.push({
        action,
        path: file.path,
        timestamp: Date.now(),
        isBinary
      });
    } else {
      // It's a folder (TFolder)
      if (action === "delete") {
        console.log(`Folder deleted locally: ${file.path}. Queuing deletions for all tracked files inside.`);
        const folderPrefix = file.path.endsWith("/") ? file.path : `${file.path}/`;

        // Find all tracked files that were inside this folder
        const trackedPaths = Object.keys(this.syncMetadata.files);
        let queueChanged = false;

        for (const path of trackedPaths) {
          if (path.startsWith(folderPrefix)) {
            const isBinary = path.toLowerCase().endsWith(".md") === false;

            // De-duplicate
            this.syncQueue = this.syncQueue.filter((item) => item.path !== path);

            this.syncQueue.push({
              action: "delete",
              path,
              timestamp: Date.now(),
              isBinary
            });
            queueChanged = true;
          }
        }

        if (!queueChanged) {
          return; // No files queued, no need to save/sync
        }
      } else {
        return; // Folders themselves are not upserted, only their files
      }
    }

    await this.saveSyncQueue();

    if (this.settings.syncOnSave) {
      this.triggerDebouncedSync();
    }
  }

  async handleFileRename(file: TAbstractFile, oldPath: string) {
    const isOldIgnored = oldPath.startsWith(".obsidian") || oldPath.startsWith(".trash") || oldPath.includes("/.trash/");
    const isNewIgnored = file.path.startsWith(".obsidian") || file.path.startsWith(".trash") || file.path.includes("/.trash/");

    if (isOldIgnored && isNewIgnored) {
      return;
    }

    if (file instanceof TFile) {
      const oldIsBinary = oldPath.toLowerCase().endsWith(".md") === false;
      const isBinary = file.extension.toLowerCase() !== "md";

      this.syncQueue = this.syncQueue.filter(
        (item) => item.path !== oldPath && item.path !== file.path
      );

      if (!isOldIgnored) {
        this.syncQueue.push({
          action: "delete",
          path: oldPath,
          timestamp: Date.now(),
          isBinary: oldIsBinary
        });
      }

      if (!isNewIgnored) {
        this.syncQueue.push({
          action: "upload",
          path: file.path,
          timestamp: Date.now(),
          isBinary
        });
      }
    } else {
      // Folder rename (TFolder)
      console.log(`Folder renamed locally from ${oldPath} to ${file.path}. Processing all files inside.`);

      const oldFolderPrefix = oldPath.endsWith("/") ? oldPath : `${oldPath}/`;
      const newFolderPrefix = file.path.endsWith("/") ? file.path : `${file.path}/`;

      const trackedPaths = Object.keys(this.syncMetadata.files);
      let queueChanged = false;

      for (const path of trackedPaths) {
        if (path.startsWith(oldFolderPrefix)) {
          const relativePath = path.substring(oldFolderPrefix.length);
          const newFilePath = newFolderPrefix + relativePath;
          const isBinary = path.toLowerCase().endsWith(".md") === false;

          this.syncQueue = this.syncQueue.filter(
            (item) => item.path !== path && item.path !== newFilePath
          );

          if (!isOldIgnored) {
            this.syncQueue.push({
              action: "delete",
              path,
              timestamp: Date.now(),
              isBinary
            });
            queueChanged = true;
          }

          if (!isNewIgnored) {
            this.syncQueue.push({
              action: "upload",
              path: newFilePath,
              timestamp: Date.now(),
              isBinary
            });
            queueChanged = true;
          }
        }
      }

      if (!queueChanged) {
        return;
      }
    }

    await this.saveSyncQueue();

    if (this.settings.syncOnSave) {
      this.triggerDebouncedSync();
    }
  }

  triggerDebouncedSync() {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.settings.syncOnSave) {
      const delayMs = (this.settings.syncDelay || 2) * 1000;
      this.debounceTimer = window.setTimeout(() => {
        this.runSync();
      }, delayMs);
    }
  }

  // --- Core Sync Logic (Offline-First) ---

  async runSync() {
    if (this.isSyncing) return;
    if (!this.supabase) {
      this.updateStatusBar("Configuration Required");
      new Notice("Error: Supabase connection settings are incomplete.");
      return;
    }
    if (!this.currentUserId) {
      this.updateStatusBar("Login Required");
      new Notice("Error: You must log in to your Supabase account to start synchronization.");
      return;
    }
    if (!this.settings.vaultId) {
      this.updateStatusBar("Vault ID Required");
      new Notice("Error: Vault ID is required to start synchronization. Please enter a Vault ID in settings.");
      return;
    }

    this.isSyncing = true;
    this.updateStatusBar("Syncing...");
    console.log("Sync started...");

    try {
      // 1. Fetch remote changes since last sync (pull first to safely resolve conflicts)
      await this.pullRemoteChanges();

      // 2. Scan local vault for untracked or modified files
      await this.scanLocalVault();

      // 3. Process local offline queue (upload the local changes and any new conflict files)
      await this.processQueue();

      // 4. Auto-cleanup soft-deleted files older than TTL (Fix D)
      await this.autoCleanupSoftDeleted();

      // 5. Update Sync Metadata timestamp
      this.syncMetadata.lastSyncTime = Date.now();
      await this.saveSyncMetadata();

      // 6. Update device tracking timestamp
      await this.updateDeviceLastSync();

      this.updateStatusBar("Synced");
      console.log("Sync complete successfully.");
    } catch (e) {
      console.error("Error during sync:", e);
      this.updateStatusBar("Error");
      new Notice("Sync failed: Check Supabase settings or network connection.");
    } finally {
      this.isSyncing = false;
    }
  }

  async autoCleanupSoftDeleted() {
    if (!this.supabase || !this.currentUserId || !this.settings.vaultId) return;

    // Clean up expired inactive devices
    await this.autoCleanupExpiredDevices();

    const ttlDays = this.settings.softDeleteTTL || 30;
    const thresholdDate = new Date(Date.now() - ttlDays * 24 * 3600 * 1000).toISOString();

    try {
      const { data: filesToDelete, error: fetchError } = await this.supabase
        .from("obsidian_vault_files")
        .select("path, is_binary")
        .eq("user_id", this.currentUserId)
        .eq("vault_id", this.settings.vaultId)
        .not("deleted_at", "is", null)
        .lt("deleted_at", thresholdDate);

      if (fetchError) {
        console.warn("Auto-cleanup: Failed to fetch expired soft-deleted files:", fetchError);
        return;
      }

      if (!filesToDelete || filesToDelete.length === 0) return;

      console.log(`Auto-cleanup: Hard-deleting ${filesToDelete.length} expired soft-deleted file(s)...`);

      // Remove binaries from Storage (Path structure: user_id/vault_id/path)
      const binaryPaths = filesToDelete.filter(f => f.is_binary).map(f => `${this.currentUserId}/${this.settings.vaultId}/${f.path}`);
      if (binaryPaths.length > 0) {
        const { error: storageError } = await this.supabase.storage
          .from("obsidian-vault-binaries")
          .remove(binaryPaths);
        if (storageError) console.warn("Auto-cleanup: Storage cleanup error:", storageError);
      }

      // Hard-delete from DB
      const pathsToDelete = filesToDelete.map(f => f.path);
      const { error: deleteError } = await this.supabase
        .from("obsidian_vault_files")
        .delete()
        .eq("user_id", this.currentUserId)
        .eq("vault_id", this.settings.vaultId)
        .in("path", pathsToDelete);

      if (deleteError) {
        console.warn("Auto-cleanup: DB hard-delete error:", deleteError);
        return;
      }

      console.log(`Auto-cleanup: Successfully hard-deleted ${pathsToDelete.length} expired file(s).`);
    } catch (e) {
      console.warn("Auto-cleanup: Unexpected error during TTL cleanup:", e);
    }
  }

  async autoCleanupExpiredDevices() {
    if (!this.supabase || !this.currentUserId || !this.settings.vaultId) return;

    const thresholdDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    try {
      console.log("Auto-cleanup: Cleaning up expired inactive devices from database...");
      const { error } = await this.supabase
        .from("obsidian_sync_devices")
        .delete()
        .eq("user_id", this.currentUserId)
        .eq("vault_id", this.settings.vaultId)
        .is("last_sync_at", null)
        .lt("updated_at", thresholdDate);

      if (error) {
        console.warn("Auto-cleanup: Failed to clean up expired devices:", error);
      } else {
        console.log("Auto-cleanup: Successfully cleaned up expired devices.");
      }
    } catch (e) {
      console.warn("Auto-cleanup: Unexpected error during device cleanup:", e);
    }
  }

  async processQueue() {
    if (this.syncQueue.length === 0) return;

    console.log(`Processing queue of ${this.syncQueue.length} items...`);
    const activeQueue = [...this.syncQueue];

    for (const item of activeQueue) {
      try {
        if (item.action === "upload") {
          await this.uploadFile(item.path, item.isBinary);
        } else if (item.action === "delete") {
          await this.deleteFileRemote(item.path, item.isBinary);
        }

        // Remove item from queue only after successful execution
        this.syncQueue = this.syncQueue.filter((qi) => qi.path !== item.path || qi.action !== item.action);
        await this.saveSyncQueue();
      } catch (e) {
        console.error(`Failed to process queue item for ${item.path}:`, e);
        // Throw error to halt the sync process so we don't corrupt the sync sequence
        throw e;
      }
    }
  }

  async uploadFile(path: string, isBinary: boolean) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    if (isBinary) {
      await this.uploadBinary(file);
    } else {
      await this.uploadMarkdown(file);
    }
  }

  async uploadMarkdown(file: TFile) {
    const content = await this.app.vault.read(file);
    const hash = await this.getSHA256Hash(content);

    // Parse Frontmatter and metadata using Obsidian Cache API
    const fileCache = this.app.metadataCache.getFileCache(file);
    const frontmatter = fileCache?.frontmatter || {};

    // Extract dedicated columns from frontmatter
    const title = frontmatter.title || file.basename;
    const dateStr = frontmatter.date || frontmatter.created;
    const date = dateStr ? new Date(dateStr).toISOString() : null;

    let aliases: string[] = [];
    if (frontmatter.aliases) {
      if (Array.isArray(frontmatter.aliases)) {
        aliases = frontmatter.aliases.map((a: any) => String(a));
      } else if (typeof frontmatter.aliases === "string") {
        aliases = frontmatter.aliases.split(",").map((a) => a.trim());
      }
    }

    const author = frontmatter.author ? String(frontmatter.author) : null;
    const status = frontmatter.status ? String(frontmatter.status) : null;
    const category = frontmatter.category ? String(frontmatter.category) : null;

    // Upsert into Supabase obsidian_vault_files
    const { error } = await this.supabase!
      .from("obsidian_vault_files")
      .upsert({
        user_id: this.currentUserId,
        vault_id: this.settings.vaultId,
        path: file.path,
        content,
        is_binary: false,
        size: file.stat.size,
        hash,
        properties: frontmatter,
        title,
        date,
        aliases,
        author,
        status,
        category,
        updated_at: new Date().toISOString(),
        deleted_at: null
      });

    if (error) throw error;

    // Save in local metadata
    this.syncMetadata.files[file.path] = {
      mtime: file.stat.mtime,
      hash
    };
    await this.saveSyncMetadata();
  }

  async uploadBinary(file: TFile) {
    const arrayBuffer = await this.app.vault.readBinary(file);
    const hash = await this.getSHA256Hash(arrayBuffer);
    const mimeType = this.getMimeType(file.extension);

    // Storage path structure: {user_id}/{vault_id}/{file_path}
    const storagePath = `${this.currentUserId}/${this.settings.vaultId}/${file.path}`;

    // Upload attachment to Supabase Storage bucket 'obsidian-vault-binaries'
    const blob = new Blob([arrayBuffer], { type: mimeType });
    const { error: uploadError } = await this.supabase!.storage
      .from("obsidian-vault-binaries")
      .upload(storagePath, blob, {
        upsert: true,
        contentType: mimeType
      });

    if (uploadError) throw uploadError;

    // Upsert metadata record in obsidian_vault_files database table
    const { error: dbError } = await this.supabase!
      .from("obsidian_vault_files")
      .upsert({
        user_id: this.currentUserId,
        vault_id: this.settings.vaultId,
        path: file.path,
        content: null,
        is_binary: true,
        mime_type: mimeType,
        size: file.stat.size,
        hash,
        properties: {},
        updated_at: new Date().toISOString(),
        deleted_at: null
      });

    if (dbError) throw dbError;

    // Save in local metadata
    this.syncMetadata.files[file.path] = {
      mtime: file.stat.mtime,
      hash
    };
    await this.saveSyncMetadata();
  }

  async deleteFileRemote(path: string, isBinary: boolean) {
    if (!this.supabase || !this.currentUserId || !this.settings.vaultId) return;

    // If it's a binary file, delete from Supabase Storage
    if (isBinary) {
      const storagePath = `${this.currentUserId}/${this.settings.vaultId}/${path}`;
      const { error: storageError } = await this.supabase!.storage
        .from("obsidian-vault-binaries")
        .remove([storagePath]);

      // Ignore resource not found errors for storage deletion
      if (storageError && !(storageError as any).message?.includes("Object not found")) {
        throw storageError;
      }
    }

    // Determine if we should hard delete or soft delete
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let shouldHardDelete = this.syncMetadata.files[path]?.hash === emptyHash;

    if (!shouldHardDelete && !isBinary) {
      // Fetch current database content to check if it's empty
      try {
        const { data: dbFile } = await this.supabase!
          .from("obsidian_vault_files")
          .select("content, size")
          .eq("user_id", this.currentUserId)
          .eq("vault_id", this.settings.vaultId)
          .eq("path", path)
          .maybeSingle();

        if (dbFile && (dbFile.content === "" || dbFile.content === null || dbFile.size === 0)) {
          shouldHardDelete = true;
        }
      } catch (e) {
        console.warn("Failed to check if remote file is empty during deletion:", e);
      }
    }

    if (shouldHardDelete) {
      console.log(`Hard-deleting empty file from database: ${path}`);
      const { error: dbError } = await this.supabase!
        .from("obsidian_vault_files")
        .delete()
        .eq("user_id", this.currentUserId)
        .eq("vault_id", this.settings.vaultId)
        .eq("path", path);

      if (dbError) throw dbError;
    } else {
      console.log(`Soft-deleting file in database: ${path}`);
      // Soft delete in Postgres so that we can notify other sync clients of the deletion
      const { error: dbError } = await this.supabase!
        .from("obsidian_vault_files")
        .update({
          deleted_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("user_id", this.currentUserId)
        .eq("vault_id", this.settings.vaultId)
        .eq("path", path);

      if (dbError) throw dbError;
    }

    // Remove from local sync metadata
    delete this.syncMetadata.files[path];
    await this.saveSyncMetadata();
  }

  // --- Pull Remote Changes (Sync Bidirectionally) ---

  async pullRemoteChanges() {
    console.log("Fetching remote file list from Supabase...");

    // Retrieve metadata for all files in the database
    const { data: remoteFiles, error } = await this.supabase!
      .from("obsidian_vault_files")
      .select("path, updated_at, hash, is_binary, deleted_at")
      .eq("user_id", this.currentUserId)
      .eq("vault_id", this.settings.vaultId);

    if (error) throw error;

    // Connection successful! Check for project changes or empty remote data.
    const currentUrl = this.settings.supabaseUrl;
    const isFirstSyncToProject = !this.syncMetadata.lastSyncedUrl || this.syncMetadata.lastSyncedUrl !== currentUrl;
    const activeRemoteFiles = remoteFiles || [];

    if (isFirstSyncToProject) {
      console.log(`First-time connection to new project URL verified successfully: ${currentUrl}. Resetting local sync tracking metadata.`);
      new Notice("First sync to this Supabase project. Safely initializing...");
      this.syncMetadata.files = {};
      this.syncMetadata.lastSyncTime = 0;
      this.syncMetadata.lastSyncedUrl = currentUrl;
      await this.saveSyncMetadata();
    } else if (activeRemoteFiles.length === 0 && Object.keys(this.syncMetadata.files).length > 0) {
      // Same project URL, but the remote database has no matching files, while we have local tracked files.
      // This indicates the remote database was wiped or all files were cleared.
      // Reset tracking to prevent deleting all local files.
      console.log("No remote files found for this vault, but local metadata exists. Assuming wiped remote database. Resetting local metadata to perform clean upload.");
      new Notice("No remote files found. Re-initializing vault upload to protect local files...");
      this.syncMetadata.files = {};
      this.syncMetadata.lastSyncTime = 0;
      await this.saveSyncMetadata();
    }

    console.log(`Analyzing ${activeRemoteFiles.length} remote files...`);

    for (const remoteFile of activeRemoteFiles) {
      const localFile = this.app.vault.getAbstractFileByPath(remoteFile.path);
      const meta = this.syncMetadata.files[remoteFile.path];

      // Case 1: Remote file is soft-deleted
      if (remoteFile.deleted_at) {
        if (localFile instanceof TFile) {
          let isModifiedLocally = this.isLocallyModified(localFile);

          if (isModifiedLocally) {
            // Double check content hash to avoid mtime false positives
            const localContent = localFile.extension.toLowerCase() === "md"
              ? await this.app.vault.read(localFile)
              : await this.app.vault.readBinary(localFile);
            const localHash = await this.getSHA256Hash(localContent);
            if (meta && localHash === meta.hash) {
              isModifiedLocally = false; // Not actually modified!
            }
          }

          if (!isModifiedLocally) {
            console.log(`Remote deleted file. Deleting local file: ${remoteFile.path}`);
            await this.deleteLocalFileRespectingSettings(localFile);
            delete this.syncMetadata.files[remoteFile.path];
          }
        }
        continue;
      }

      // Case 2: File is active on remote

      // Determine if we need to pull the remote file.
      // We need to pull if:
      // a) It is completely missing from our local sync metadata
      // b) The remote hash is different from our local metadata hash AND the remote file has been updated since our last sync (with a 5-minute clock-skew buffer)
      let shouldPull = false;

      if (!meta) {
        // Completely untracked locally! We must pull it.
        shouldPull = true;
      } else if (meta.hash !== remoteFile.hash) {
        const bufferMs = 5 * 60 * 1000;
        const lastSyncTimeWithBuffer = Math.max(0, this.syncMetadata.lastSyncTime - bufferMs);
        const lastSyncStrWithBuffer = new Date(lastSyncTimeWithBuffer).toISOString();

        if (remoteFile.updated_at > lastSyncStrWithBuffer) {
          shouldPull = true;
        }
      }

      if (!shouldPull) {
        // Fix A: Even if hash matches metadata, verify the file physically exists on disk.
        // If it's missing (e.g., manually deleted outside Obsidian without triggering a delete event),
        // re-download from remote instead of silently skipping.
        // IMPORTANT: Skip re-download if there is a pending delete event in the queue — the user
        // intentionally deleted this file and the queue will propagate the soft-delete to Supabase.
        // (Principle 1: "Never delete without evidence of intent" — the inverse also applies:
        //  never restore a file when there IS evidence of delete intent.)
        if (meta && meta.hash === remoteFile.hash) {
          const physicallyExists = await this.app.vault.adapter.exists(remoteFile.path);
          if (!physicallyExists) {
            const hasPendingDelete = this.syncQueue.some(
              (item) => item.path === remoteFile.path && item.action === "delete"
            );
            if (hasPendingDelete) {
              // User deleted this file intentionally — do not restore it. The queue will soft-delete it remotely.
              console.log(`Fix A: Skipping re-download for intentionally deleted file (pending delete in queue): ${remoteFile.path}`);
              continue;
            }
            console.log(`Fix A: File matches metadata hash but is missing from disk. Re-downloading: ${remoteFile.path}`);
            shouldPull = true;
          } else if (localFile instanceof TFile) {
            // File exists — align local metadata mtime
            meta.mtime = localFile.stat.mtime;
          }
        }

        if (!shouldPull) {
          continue;
        }
      }

      // If we are pulling and the file exists locally, check for conflicts
      if (localFile instanceof TFile) {
        const isModified = this.isLocallyModified(localFile);

        if (isModified) {
          const localContent = localFile.extension.toLowerCase() === "md"
            ? await this.app.vault.read(localFile)
            : await this.app.vault.readBinary(localFile);

          const localHash = await this.getSHA256Hash(localContent);

          // If the contents are already identical, just update metadata and skip conflict resolution
          if (localHash === remoteFile.hash) {
            this.syncMetadata.files[remoteFile.path] = {
              mtime: localFile.stat.mtime,
              hash: localHash
            };
            continue;
          }

          // Conflict resolution: Rename local file to conflict, then let pull proceed
          console.warn(`Sync Conflict detected on: ${remoteFile.path}. Renaming local file.`);
          new Notice(`Sync Conflict: ${remoteFile.path} changed in both places. Renaming local version to prevent loss.`);

          const ext = localFile.extension;
          const folder = localFile.parent ? localFile.parent.path : "";
          const baseName = localFile.basename;

          let conflictPath = `${baseName} (Sync Conflict).${ext}`;
          if (folder && folder !== "/") {
            conflictPath = `${folder}/${conflictPath}`;
          }

          await this.app.vault.rename(localFile, conflictPath);
        }
      }

      // Write remote file to local vault (this also updates local metadata with the remote file's hash)
      console.log(`Downloading and writing remote file: ${remoteFile.path}`);

      let fullRemoteFile = remoteFile;
      if (!remoteFile.is_binary) {
        const { data: dbFile, error: fetchErr } = await this.supabase!
          .from("obsidian_vault_files")
          .select("*")
          .eq("user_id", this.currentUserId)
          .eq("vault_id", this.settings.vaultId)
          .eq("path", remoteFile.path)
          .maybeSingle();

        if (fetchErr) throw fetchErr;
        if (!dbFile) {
          console.warn(`File not found in DB when fetching content: ${remoteFile.path}`);
          continue;
        }
        fullRemoteFile = dbFile;
      }

      await this.writeRemoteFileToLocal(fullRemoteFile);
    }

    // Fix B/E: Check for files in local metadata that are NOT in remote.
    // These could be hard-deleted remotely (after TTL) or never propagated.
    // We must distinguish between:
    //   - User intentionally deleted (has a delete event in queue) → clean up metadata only
    //   - File just "disappeared" remotely without intent → DO NOT delete local; remove from metadata
    //     so scanLocalVault will re-queue it for upload.
    const remotePaths = new Set(activeRemoteFiles.map((rf) => rf.path));
    for (const localPath of Object.keys(this.syncMetadata.files)) {
      if (!remotePaths.has(localPath)) {
        console.log(`File not found on remote: ${localPath}. Checking delete intent...`);

        // Check if there's an explicit delete event in the queue for this file
        const hasDeleteIntent = this.syncQueue.some(
          (item) => item.path === localPath && item.action === "delete"
        );

        if (hasDeleteIntent) {
          // User intentionally deleted this file — the queue will propagate the soft-delete to remote.
          // Just clean up local metadata here.
          console.log(`Delete intent confirmed for: ${localPath}. Removing from metadata (queue will handle remote).`);
          delete this.syncMetadata.files[localPath];
        } else {
          // Fix E: No delete intent found. The file vanished from remote (hard-deleted after TTL,
          // or remote was partially wiped). DO NOT delete the local file.
          // Remove from metadata only — scanLocalVault will detect it as untracked and re-upload it.
          const localFile = this.app.vault.getAbstractFileByPath(localPath);
          if (localFile instanceof TFile) {
            console.log(`Fix E: No delete intent for ${localPath}. File exists locally — removing from metadata so it gets re-uploaded.`);
          } else {
            console.log(`Fix E: No delete intent for ${localPath} and file not on disk either — cleaning up metadata.`);
          }
          delete this.syncMetadata.files[localPath];
        }
      }
    }

    await this.saveSyncMetadata();
  }

  isLocallyModified(file: TFile): boolean {
    const meta = this.syncMetadata.files[file.path];
    if (!meta) return true; // Never synced before, so count as modified/new
    return file.stat.mtime > meta.mtime;
  }

  async deleteLocalFileRespectingSettings(file: TFile) {
    try {
      const trashOption = (this.app.vault as any).config?.trashOption || "none";
      if (trashOption === "system") {
        await this.app.vault.trash(file, true);
      } else if (trashOption === "local") {
        await this.app.vault.trash(file, false);
      } else {
        await this.app.vault.delete(file);
      }
    } catch (e) {
      console.warn("Failed to delete file respecting trash settings, falling back to permanent delete:", e);
      await this.app.vault.delete(file);
    }
  }

  async writeRemoteFileToLocal(remoteFile: any) {
    const path = remoteFile.path;

    // Ensure parent directories exist
    const parts = path.split("/");
    if (parts.length > 1) {
      const folderPath = parts.slice(0, -1).join("/");
      if (!(await this.app.vault.adapter.exists(folderPath))) {
        await this.app.vault.createFolder(folderPath);
      }
    }

    if (remoteFile.is_binary) {
      const storagePath = `${this.currentUserId}/${this.settings.vaultId}/${path}`;
      // Download binary from Supabase Storage
      const { data, error } = await this.supabase!.storage
        .from("obsidian-vault-binaries")
        .download(storagePath);

      if (error) throw error;

      const arrayBuffer = await data.arrayBuffer();

      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modifyBinary(file, arrayBuffer);
      } else {
        await this.app.vault.createBinary(path, arrayBuffer);
      }

      const stat = await this.app.vault.adapter.stat(path);
      const mtime = stat ? stat.mtime : Date.now();
      this.syncMetadata.files[path] = {
        mtime: mtime,
        hash: remoteFile.hash
      };
    } else {
      // Write markdown file
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, remoteFile.content);
      } else {
        await this.app.vault.create(path, remoteFile.content);
      }

      const stat = await this.app.vault.adapter.stat(path);
      const mtime = stat ? stat.mtime : Date.now();
      this.syncMetadata.files[path] = {
        mtime: mtime,
        hash: remoteFile.hash
      };
    }

    await this.saveSyncMetadata();
  }

  async scanLocalVault() {
    console.log("Scanning local vault for untracked or modified files...");
    const files = this.app.vault.getFiles();
    let queueChanged = false;

    for (const file of files) {
      // Ignore configuration files, sync state, and files in the .trash directory
      if (
        file.path.startsWith(".obsidian") ||
        file.path.startsWith(".trash") ||
        file.path.includes("/.trash/") ||
        file.path.includes("sync-queue") ||
        file.path.includes("sync-metadata")
      ) {
        continue;
      }

      const meta = this.syncMetadata.files[file.path];
      const isBinary = file.extension.toLowerCase() !== "md";

      if (!meta) {
        // Untracked file! Add to sync queue if not already there
        const inQueue = this.syncQueue.some((item) => item.path === file.path && item.action === "upload");
        if (!inQueue) {
          console.log(`Discovered untracked file: ${file.path}`);
          this.syncQueue.push({
            action: "upload",
            path: file.path,
            timestamp: Date.now(),
            isBinary
          });
          queueChanged = true;
        }
      } else if (file.stat.mtime > meta.mtime) {
        // Locally modified since last sync! Add to sync queue if not already there
        const inQueue = this.syncQueue.some(
          (item) => item.path === file.path && item.action === "upload"
        );
        if (!inQueue) {
          console.log(`Discovered externally modified file: ${file.path}`);
          this.syncQueue.push({
            action: "upload",
            path: file.path,
            timestamp: Date.now(),
            isBinary
          });
          queueChanged = true;
        }
      }
    }

    if (queueChanged) {
      await this.saveSyncQueue();
    }
  }

  // --- Utility Helpers ---

  async getSHA256Hash(data: string | ArrayBuffer): Promise<string> {
    const encoder = new TextEncoder();
    const buffer = typeof data === "string" ? encoder.encode(data) : data;
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  getMimeType(extension: string): string {
    const mimes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      mp4: "video/mp4",
      webm: "video/webm",
      zip: "application/zip",
      txt: "text/plain",
      json: "application/json"
    };
    return mimes[extension.toLowerCase()] || "application/octet-stream";
  }
}

// --- Settings Tab UI Implementation ---

class SupabaseSyncSettingTab extends PluginSettingTab {
  plugin: SupabaseSyncPlugin;
  includeDeletedInExport = false;

  constructor(app: any, plugin: SupabaseSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private escapeString(val: string | null | undefined): string {
    if (val === null || val === undefined) return "NULL";
    return `'${val.replace(/'/g, "''")}'`;
  }

  private escapeBoolean(val: boolean | null | undefined): string {
    if (val === null || val === undefined) return "NULL";
    return val ? "true" : "false";
  }

  private escapeNumber(val: number | null | undefined): string {
    if (val === null || val === undefined) return "NULL";
    return String(val);
  }

  private escapeJson(val: any): string {
    if (val === null || val === undefined) return "NULL";
    try {
      const jsonStr = JSON.stringify(val);
      return `'${jsonStr.replace(/'/g, "''")}'::jsonb`;
    } catch (e) {
      console.warn("Failed to stringify JSON properties:", e);
      return "NULL";
    }
  }

  private escapeTextArray(arr: string[] | null | undefined): string {
    if (arr === null || arr === undefined || !Array.isArray(arr)) return "NULL";
    if (arr.length === 0) return "'{}'::text[]";
    const escapedItems = arr.map(item => {
      if (item === null || item === undefined) return "NULL";
      return `'${String(item).replace(/'/g, "''")}'`;
    });
    return `ARRAY[${escapedItems.join(", ")}]::text[]`;
  }

  private triggerDownload(fileName: string, content: string): void {
    const blob = new Blob([content], { type: "application/sql" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  display(): void {
    const { containerEl } = this;
    let isSaving = false;
    let isInteracting = false;

    containerEl.empty();

    containerEl.createEl("h3", { text: "Supabase Setup" });

    // Supabase URL Setting
    new Setting(containerEl)
      .setName("Supabase Project URL")
      .setDesc("The API endpoint for your Supabase project (e.g. https://xxxx.supabase.co).")
      .addText((text) =>
        text
          .setPlaceholder("https://your-project.supabase.co")
          .setValue(this.plugin.settings.supabaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.supabaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Supabase Key Setting
    new Setting(containerEl)
      .setName("Supabase API Key")
      .setDesc("Your Supabase Anon Key (or Service Role Key) for database/storage operations.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("Supabase JWT API Key")
          .setValue(this.plugin.settings.supabaseKey)
          .onChange(async (value) => {
            this.plugin.settings.supabaseKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    // Test Connection Button
    new Setting(containerEl)
      .setName("Test Connection")
      .setDesc("Validate that the Supabase settings and API credentials are correct.")
      .addButton((button) =>
        button
          .setButtonText("Test Connection")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Testing...");

            try {
              if (!this.plugin.settings.supabaseUrl || !this.plugin.settings.supabaseKey) {
                new Notice("Error: Supabase URL and API Key must both be configured before testing.");
                return;
              }

              // Temporarily initialize client if not already initialized
              if (!this.plugin.supabase) {
                this.plugin.initSupabaseClient();
              }

              if (!this.plugin.supabase) {
                throw new Error("Could not initialize Supabase client. Check that your URL and API Key formats are valid.");
              }

              // 1. Test database access
              let dbQuery = this.plugin.supabase
                .from("obsidian_vault_files")
                .select("path")
                .limit(1);

              if (this.plugin.currentUserId) {
                dbQuery = dbQuery.eq("user_id", this.plugin.currentUserId);
              }
              if (this.plugin.settings.vaultId) {
                dbQuery = dbQuery.eq("vault_id", this.plugin.settings.vaultId);
              }

              const { data: dbData, error: dbError } = await dbQuery;

              if (dbError) {
                throw new Error(`Database connection failed: ${dbError.message}`);
              }

              // 2. Test storage access
              const { data: storageData, error: storageError } = await this.plugin.supabase.storage
                .from("obsidian-vault-binaries")
                .list("", { limit: 1 });

              if (storageError) {
                throw new Error(`Storage access failed: ${storageError.message}`);
              }

              new Notice("Connection test successful! Both Database and Storage are fully accessible.");
            } catch (err: any) {
              console.error("Connection test failed:", err);
              new Notice(`Connection test failed: ${err.message || err}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Test Connection");
            }
          })
      );

    const descEl = containerEl.createEl("p");
    descEl.style.fontSize = "0.8em";
    descEl.style.marginTop = "12px";
    descEl.style.marginBottom = "15px";
    descEl.style.paddingLeft = "15px";
    descEl.style.color = "var(--text-muted)";

    descEl.createEl("span", { text: "First time using this plugin? You must set up your database first. Read the " });
    descEl.createEl("a", {
      text: "Supabase Setup Guide",
      href: "https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SUPABASE_SETUP.md"
    });
    descEl.createEl("span", { text: " for step-by-step instructions." });


    // Authentication Section
    containerEl.createEl("h3", { text: "Authentication" });

    if (this.plugin.currentUserId) {
      new Setting(containerEl)
        .setName("Logged In")
        .setDesc(`Logged in as: ${this.plugin.currentUserEmail}`)
        .addButton((button) =>
          button
            .setButtonText("Log Out")
            .onClick(async () => {
              await this.plugin.signOut();
              this.display(); // Refresh settings UI
            })
        );
    } else {
      let email = "";
      let password = "";

      new Setting(containerEl)
        .setName("Email")
        .setDesc("Enter your Supabase auth account email.")
        .addText((text) =>
          text
            .setPlaceholder("email@example.com")
            .onChange((value) => {
              email = value.trim();
            })
        );

      new Setting(containerEl)
        .setName("Password")
        .setDesc("Enter your Supabase auth account password.")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("Password")
            .onChange((value) => {
              password = value;
            });
        });

      new Setting(containerEl)
        .setName("Log In")
        .setDesc("Log in to secure database & storage access.")
        .addButton((button) =>
          button
            .setButtonText("Log In")
            .setCta()
            .onClick(async () => {
              if (!email || !password) {
                new Notice("Email and Password are required!");
                return;
              }
              button.setDisabled(true);
              button.setButtonText("Logging in...");
              try {
                await this.plugin.signIn(email, password);
                this.display(); // Refresh settings UI
              } catch (e: any) {
                console.error("Login failed:", e);
                new Notice(`Login failed: ${e.message || e}`);
              } finally {
                button.setDisabled(false);
                button.setButtonText("Log In");
              }
            })
        );
    }

    // Vault & Device Configuration Section
    containerEl.createEl("h3", { text: "Vault & Device Configuration" });

    let textComponent: any;
    let saveButtonComponent: any;
    let editButtonComponent: any;
    let updateInputStyle: () => void;
    let clearInputSelection: () => void;

    new Setting(containerEl)
      .setName("Vault ID")
      .setDesc("A unique ID for this vault (max 10 characters). Required to sync.")
      .addText((text) => {
        textComponent = text;
        const inputEl = text.inputEl;
        inputEl.maxLength = 10;

        // Helper to update cursor style based on readonly state
        updateInputStyle = () => {
          if (inputEl.hasAttribute("readonly")) {
            inputEl.style.cursor = "default";
            inputEl.style.opacity = "0.75";
          } else {
            inputEl.style.cursor = "text";
            inputEl.style.opacity = "1";
          }
        };

        // Helper to clear text selection robustly
        clearInputSelection = () => {
          try {
            inputEl.selectionStart = 0;
            inputEl.selectionEnd = 0;
            inputEl.setSelectionRange(0, 0);
            window.getSelection()?.removeAllRanges();
          } catch (e) { }
        };

        // Set initial value
        const currentVal = this.plugin.settings.vaultId;
        text.setValue(currentVal);

        // Configure initial states based on whether the value is empty
        if (!currentVal) {
          inputEl.removeAttribute("readonly");
        } else {
          inputEl.setAttribute("readonly", "true");
        }
        updateInputStyle();

        // On input: clean the value
        inputEl.addEventListener("input", () => {
          let cleaned = inputEl.value.trim().substring(0, 10).replace(/[^a-zA-Z0-9-_]/g, "");
          inputEl.value = cleaned;

          updateSaveButtonState();
        });

        // Trigger edit state on double click if readonly
        inputEl.addEventListener("dblclick", () => {
          if (inputEl.hasAttribute("readonly")) {
            inputEl.removeAttribute("readonly");
            inputEl.focus();
            saveButtonComponent.buttonEl.show();
            editButtonComponent.buttonEl.hide();
            updateSaveButtonState();
            updateInputStyle();
          }
        });

        // Lost focus / blur handler
        inputEl.addEventListener("blur", () => {
          clearInputSelection();

          setTimeout(() => {
            clearInputSelection();

            if (isSaving || isInteracting) {
              return;
            }
            const val = inputEl.value.trim();
            if (!val) {
              // input is empty: no readonly, show save, hide edit
              inputEl.removeAttribute("readonly");
              if (saveButtonComponent) saveButtonComponent.buttonEl.show();
              if (editButtonComponent) editButtonComponent.buttonEl.hide();
              updateSaveButtonState();
            } else {
              // revert if there are unsaved changes
              if (val !== this.plugin.settings.vaultId) {
                textComponent.setValue(this.plugin.settings.vaultId);
              }
              inputEl.setAttribute("readonly", "true");
              if (saveButtonComponent) saveButtonComponent.buttonEl.hide();
              if (editButtonComponent) editButtonComponent.buttonEl.show();
            }
            updateInputStyle();
            clearInputSelection();
          }, 200);
        });
      })
      .addButton((btn) => {
        saveButtonComponent = btn;
        btn.setIcon("save");
        btn.setTooltip("Save Vault ID");
        btn.setCta(); // Style Save button with accent color

        // Initial visibility
        if (!this.plugin.settings.vaultId) {
          btn.buttonEl.show();
        } else {
          btn.buttonEl.hide();
        }

        // Mousedown to prevent input blur revert
        btn.buttonEl.addEventListener("mousedown", () => {
          isInteracting = true;
        });

        btn.onClick(async () => {
          isSaving = true;
          const inputEl = textComponent.inputEl;
          const cleaned = inputEl.value.trim();

          if (!cleaned || cleaned === this.plugin.settings.vaultId) {
            isSaving = false;
            setTimeout(() => { isInteracting = false; }, 300);
            return;
          }

          // Trigger confirmation logic
          btn.setDisabled(true);
          const success = await this.plugin.updateVaultId(cleaned);
          btn.setDisabled(false);

          if (success) {
            inputEl.setAttribute("readonly", "true");
            saveButtonComponent.buttonEl.hide();
            editButtonComponent.buttonEl.show();
          } else {
            // failed / cancelled: revert and reset state
            textComponent.setValue(this.plugin.settings.vaultId);
            if (!this.plugin.settings.vaultId) {
              inputEl.removeAttribute("readonly");
              saveButtonComponent.buttonEl.show();
              editButtonComponent.buttonEl.hide();
            } else {
              inputEl.setAttribute("readonly", "true");
              saveButtonComponent.buttonEl.hide();
              editButtonComponent.buttonEl.show();
            }
          }
          isSaving = false;
          setTimeout(() => { isInteracting = false; }, 300);
          updateSaveButtonState();
          updateInputStyle();
          clearInputSelection();
        });
      })
      .addButton((btn) => {
        editButtonComponent = btn;
        btn.setIcon("pencil");
        btn.setTooltip("Edit Vault ID");

        // Initial visibility
        if (!this.plugin.settings.vaultId) {
          btn.buttonEl.hide();
        } else {
          btn.buttonEl.show();
        }

        // Mousedown to prevent input blur revert
        btn.buttonEl.addEventListener("mousedown", () => {
          isInteracting = true;
        });

        btn.onClick(() => {
          const inputEl = textComponent.inputEl;
          inputEl.removeAttribute("readonly");
          inputEl.focus();
          saveButtonComponent.buttonEl.show();
          editButtonComponent.buttonEl.hide();
          updateSaveButtonState();
          updateInputStyle();
          // Reset isInteracting flag after any blur events have checked it
          setTimeout(() => {
            isInteracting = false;
          }, 300);
        });
      });

    // Helper function to update Save button state
    const updateSaveButtonState = () => {
      if (!textComponent || !saveButtonComponent) return;
      const val = textComponent.inputEl.value.trim();
      if (!val || val === this.plugin.settings.vaultId) {
        saveButtonComponent.setDisabled(true);
      } else {
        saveButtonComponent.setDisabled(false);
      }
    };

    updateSaveButtonState();

    let deviceNameTimeout: number | null = null;

    new Setting(containerEl)
      .setName("Device Name")
      .setDesc("Name to identify this device in database sync history.")
      .addText((text) =>
        text
          .setPlaceholder("e.g. My Laptop")
          .setValue(this.plugin.settings.deviceName)
          .onChange((value) => {
            const cleaned = value.trim();

            if (deviceNameTimeout) {
              window.clearTimeout(deviceNameTimeout);
            }

            deviceNameTimeout = window.setTimeout(async () => {
              if (cleaned && cleaned !== this.plugin.settings.deviceName) {
                this.plugin.settings.deviceName = cleaned;
                await this.plugin.saveSettings();
                await this.plugin.registerDevice();
              }
            }, 1000); // 1-second debounce
          })
      );

    // Sync on Save (file modifications) Toggle
    new Setting(containerEl)
      .setName("Auto-Sync on Changes")
      .setDesc("Trigger synchronization automatically when notes are created, modified, or deleted locally.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnSave)
          .onChange(async (value) => {
            this.plugin.settings.syncOnSave = value;
            await this.plugin.saveSettings();
          })
      );

    // Sync Delay Setting (Debounce delay)
    new Setting(containerEl)
      .setName("Auto-Sync Delay (seconds)")
      .setDesc("Delay in seconds to wait after a change before triggering auto-sync (debounced).")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.syncDelay || 2)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncDelay = value;
            await this.plugin.saveSettings();
          })
      );

    // Auto-Sync Interval (seconds) Setting
    new Setting(containerEl)
      .setName("Auto-Sync Interval (seconds)")
      .setDesc("Interval in seconds to automatically sync your vault. Set to 0 to disable interval-based sync.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 60, 1)
          .setValue(this.plugin.settings.syncInterval || 0)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncInterval = value;
            await this.plugin.saveSettings();
            this.plugin.startIntervalSync();
          })
      );

    // --- Sync Control Section ---
    containerEl.createEl("h3", { text: "Sync Control" });

    new Setting(containerEl)
      .setName("Sync Vault Now")
      .setDesc("Manually execute a full bi-directional synchronization with your Supabase database and storage.")
      .addButton((button) =>
        button
          .setButtonText("Sync Now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Syncing...");
            new Notice("Starting sync...");
            try {
              await this.plugin.runSync();
            } finally {
              button.setDisabled(false);
              button.setButtonText("Sync Now");
            }
          })
      );

    new Setting(containerEl)
      .setName("Reset Sync State")
      .setDesc(
        "Clear all local sync metadata and the pending queue. " +
        "The next sync will perform a full re-scan and safely merge local and remote files by hash. " +
        "No files will be deleted."
      )
      .addButton((button) =>
        button
          .setButtonText("Reset Sync")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Resetting...");

            try {
              // Clear the pending queue so no stale delete events carry over
              this.plugin.syncQueue = [];
              await this.plugin.saveSyncQueue();

              this.plugin.syncMetadata = {
                lastSyncTime: 0,
                lastSyncedUrl: this.plugin.settings.supabaseUrl,
                files: {}
              };
              await this.plugin.saveSyncMetadata();

              new Notice(
                "Sync state reset. Next sync will re-scan and safely merge all files."
              );
            } catch (err: any) {
              console.error("Reset sync failed:", err);
              new Notice(`Reset failed: ${err.message || err}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Reset Sync");
            }
          })
      );

    // Server Maintenance Section
    containerEl.createEl("h3", { text: "Server Maintenance" });

    new Setting(containerEl)
      .setName("Manage Database Vaults")
      .setDesc("View active vaults in the database, view connected devices, notes, binary files, and manage vault deletion.")
      .addButton((button) =>
        button
          .setButtonText("Manage Vaults")
          .onClick(() => {
            if (!this.plugin.supabase || !this.plugin.currentUserId) {
              new Notice("Error: Supabase connection and active login are required.");
              return;
            }
            new ManageVaultsModal(this.app, this.plugin).open();
          })
      );

    new Setting(containerEl)
      .setName("Automatic Cleanup Age (Days)")
      .setDesc("Age in days after which soft-deleted files are automatically purged from database and storage during sync.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1 Day")
          .addOption("7", "7 Days")
          .addOption("30", "30 Days")
          .addOption("90", "90 Days")
          .addOption("180", "180 Days")
          .setValue(String(this.plugin.settings.softDeleteTTL || 30))
          .onChange(async (value) => {
            this.plugin.settings.softDeleteTTL = parseInt(value, 10);
            await this.plugin.saveSettings();
            new Notice(`Automatic cleanup age set to ${value} days.`);
          })
      );

    let cleanupDays: string = "7";

    new Setting(containerEl)
      .setName("Manual Cleanup")
      .setDesc("Manually hard-delete (permanently remove) files in Supabase that have been soft-deleted for longer than this duration, or remove all.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1 Day")
          .addOption("7", "7 Days")
          .addOption("30", "30 Days")
          .addOption("90", "90 Days")
          .addOption("all", "All Soft-Deleted Files")
          .setValue("7")
          .onChange((value) => {
            cleanupDays = value;
          })
      )
      .addButton((button) =>
        button
          .setButtonText("Clean Up Now")
          .onClick(async () => {
            if (!this.plugin.supabase || !this.plugin.currentUserId || !this.plugin.settings.vaultId) {
              new Notice("Error: Supabase connection, active login, and Vault ID are required.");
              return;
            }

            button.setDisabled(true);
            button.setButtonText("Cleaning...");

            try {
              let query = this.plugin.supabase
                .from("obsidian_vault_files")
                .select("path, is_binary")
                .eq("user_id", this.plugin.currentUserId)
                .eq("vault_id", this.plugin.settings.vaultId)
                .not("deleted_at", "is", null);

              if (cleanupDays !== "all") {
                const days = parseInt(cleanupDays, 10);
                const thresholdDate = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
                query = query.lt("deleted_at", thresholdDate);
              }

              // 1. Fetch soft-deleted records older than the threshold
              const { data: filesToDelete, error: fetchError } = await query;

              if (fetchError) throw fetchError;

              if (!filesToDelete || filesToDelete.length === 0) {
                new Notice("No soft-deleted files matched the criteria.");
                return;
              }

              // 2. Remove binaries from Storage
              const binaryPaths = filesToDelete.filter(f => f.is_binary).map(f => `${this.plugin.currentUserId}/${this.plugin.settings.vaultId}/${f.path}`);
              if (binaryPaths.length > 0) {
                const { error: storageError } = await this.plugin.supabase.storage
                  .from("obsidian-vault-binaries")
                  .remove(binaryPaths);
                if (storageError) console.warn("Failed to clean up some storage binaries:", storageError);
              }

              // 3. Hard delete from DB
              const pathsToDelete = filesToDelete.map(f => f.path);
              const { error: deleteError } = await this.plugin.supabase
                .from("obsidian_vault_files")
                .delete()
                .eq("user_id", this.plugin.currentUserId)
                .eq("vault_id", this.plugin.settings.vaultId)
                .in("path", pathsToDelete);

              if (deleteError) throw deleteError;

              new Notice(`Successfully permanently deleted ${pathsToDelete.length} soft-deleted file(s) from Supabase.`);
            } catch (err: any) {
              console.error("Cleanup failed:", err);
              new Notice(`Cleanup failed: ${err.message || err}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Clean Up Now");
            }
          })
      );

    // Backup & Export
    containerEl.createEl("h3", { text: "Backup & Export" });

    new Setting(containerEl)
      .setName("Include Deleted Files")
      .setDesc("Include soft-deleted files (where deleted_at is set) in the SQL database backup.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.includeDeletedInExport)
          .onChange((value) => {
            this.includeDeletedInExport = value;
          })
      );

    new Setting(containerEl)
      .setName("Export Database to SQL")
      .setDesc("Export your Supabase vault database tables matching the current vault name into a local .sql file.")
      .addButton((button) =>
        button
          .setButtonText("Export Database")
          .setCta()
          .onClick(async () => {
            if (!this.plugin.supabase || !this.plugin.currentUserId || !this.plugin.settings.vaultId) {
              new Notice("Error: Supabase connection, active login, and Vault ID are required.");
              return;
            }

            button.setDisabled(true);
            button.setButtonText("Exporting...");

            try {
              let query = this.plugin.supabase
                .from("obsidian_vault_files")
                .select("*")
                .eq("user_id", this.plugin.currentUserId)
                .eq("vault_id", this.plugin.settings.vaultId);

              if (!this.includeDeletedInExport) {
                query = query.is("deleted_at", null);
              }

              const { data, error } = await query;

              if (error) {
                throw error;
              }

              if (!data || data.length === 0) {
                new Notice("No database records found in Supabase for this vault ID.");
                return;
              }

              const sqlStatements: string[] = [];

              // Add header
              sqlStatements.push(`-- Obsidian Supabase Sync Database Backup`);
              sqlStatements.push(`-- Vault ID: ${this.plugin.settings.vaultId}`);
              sqlStatements.push(`-- User ID: ${this.plugin.currentUserId}`);
              sqlStatements.push(`-- Generated At: ${new Date().toISOString()}`);
              sqlStatements.push(`-- Include Deleted Files: ${this.includeDeletedInExport}`);
              sqlStatements.push(`-- Total Records: ${data.length}`);
              sqlStatements.push(``);

              for (const row of data) {
                const sql = `INSERT INTO obsidian_vault_files (
  user_id, vault_id, path, content, is_binary, mime_type, size, hash, properties,
  title, date, aliases, author, status, category, created_at, updated_at, deleted_at
) VALUES (
  ${this.escapeString(row.user_id)},
  ${this.escapeString(row.vault_id)},
  ${this.escapeString(row.path)},
  ${this.escapeString(row.content)},
  ${this.escapeBoolean(row.is_binary)},
  ${this.escapeString(row.mime_type)},
  ${this.escapeNumber(row.size)},
  ${this.escapeString(row.hash)},
  ${this.escapeJson(row.properties)},
  ${this.escapeString(row.title)},
  ${this.escapeString(row.date)},
  ${this.escapeTextArray(row.aliases)},
  ${this.escapeString(row.author)},
  ${this.escapeString(row.status)},
  ${this.escapeString(row.category)},
  ${this.escapeString(row.created_at)},
  ${this.escapeString(row.updated_at)},
  ${this.escapeString(row.deleted_at)}
) ON CONFLICT (user_id, vault_id, path) DO UPDATE SET
  content = EXCLUDED.content,
  is_binary = EXCLUDED.is_binary,
  mime_type = EXCLUDED.mime_type,
  size = EXCLUDED.size,
  hash = EXCLUDED.hash,
  properties = EXCLUDED.properties,
  title = EXCLUDED.title,
  date = EXCLUDED.date,
  aliases = EXCLUDED.aliases,
  author = EXCLUDED.author,
  status = EXCLUDED.status,
  category = EXCLUDED.category,
  created_at = EXCLUDED.created_at,
  updated_at = EXCLUDED.updated_at,
  deleted_at = EXCLUDED.deleted_at;`;

                sqlStatements.push(sql);
              }

              const sqlContent = sqlStatements.join("\n\n");
              const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
              const fileName = `${this.plugin.settings.vaultId.replace(/[^a-z0-9_-]/gi, "_")}-backup-${timestamp}.sql`;

              this.triggerDownload(fileName, sqlContent);
              new Notice(`Database exported successfully as ${fileName}!`);
            } catch (err: any) {
              console.error("Database export failed:", err);
              new Notice("Failed to export database: Query error. Check console for details.");
            } finally {
              button.setDisabled(false);
              button.setButtonText("Export Database");
            }
          })
      );
  }
}

class ConfirmModal extends Modal {
  private message: string;
  private onSubmit: (result: boolean) => void;
  private result = false;

  constructor(app: any, message: string, onSubmit: (result: boolean) => void) {
    super(app);
    this.message = message;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Confirm Action");

    const messageEl = contentEl.createEl("p", { text: this.message });
    messageEl.style.whiteSpace = "pre-wrap";
    messageEl.style.margin = "1em 0";

    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.marginTop = "1.5em";

    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.result = false;
      this.close();
    });

    const confirmButton = buttonContainer.createEl("button", { text: "Confirm" });
    confirmButton.addClass("mod-warning");
    confirmButton.addEventListener("click", () => {
      this.result = true;
      this.close();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.onSubmit(this.result);
  }
}

class ManageVaultsModal extends Modal {
  plugin: SupabaseSyncPlugin;

  constructor(app: any, plugin: SupabaseSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Set modal size/styles
    this.modalEl.style.width = "650px";
    this.modalEl.style.maxWidth = "90vw";

    this.setTitle("Manage Database Vaults");

    const container = contentEl.createDiv();
    container.style.marginTop = "1em";

    this.loadVaultsData(container);
  }

  async loadVaultsData(container: HTMLDivElement) {
    container.empty();

    // Loading state
    const loadingEl = container.createDiv();
    loadingEl.setText("Loading vaults from Supabase database...");
    loadingEl.style.color = "var(--text-muted)";
    loadingEl.style.padding = "20px";
    loadingEl.style.textAlign = "center";

    try {
      if (!this.plugin.supabase || !this.plugin.currentUserId) {
        throw new Error("Supabase is not initialized or user is not logged in.");
      }

      // 1. Fetch devices for current user
      const { data: devices, error: devicesError } = await this.plugin.supabase
        .from("obsidian_sync_devices")
        .select("vault_id, device_name, platform, last_sync_at")
        .eq("user_id", this.plugin.currentUserId);

      if (devicesError) throw devicesError;

      // 2. Fetch all vault_ids from vault_files
      const { data: filesData, error: filesError } = await this.plugin.supabase
        .from("obsidian_vault_files")
        .select("vault_id")
        .eq("user_id", this.plugin.currentUserId);

      if (filesError) throw filesError;

      // Aggregate unique vault IDs
      const vaultIds = new Set<string>();
      if (this.plugin.settings.vaultId) {
        vaultIds.add(this.plugin.settings.vaultId);
      }
      if (devices) {
        devices.forEach((d: any) => vaultIds.add(d.vault_id));
      }
      if (filesData) {
        filesData.forEach((f: any) => vaultIds.add(f.vault_id));
      }

      // Convert Set to Array and sort: current vault first, then alphabetical
      const currentVaultId = this.plugin.settings.vaultId;
      const sortedVaultIds = Array.from(vaultIds).sort((a, b) => {
        if (a === currentVaultId) return -1;
        if (b === currentVaultId) return 1;
        return a.localeCompare(b);
      });

      loadingEl.remove();

      if (sortedVaultIds.length === 0) {
        container.createEl("p", { text: "No vaults found in the database." });
        return;
      }

      // Create list container
      const listContainer = container.createDiv();
      listContainer.style.display = "flex";
      listContainer.style.flexDirection = "column";
      listContainer.style.gap = "15px";

      for (const vaultId of sortedVaultIds) {
        // Fetch note count (raw SQL / PostgREST count query)
        const { count: noteCount, error: noteError } = await this.plugin.supabase
          .from("obsidian_vault_files")
          .select("*", { count: "exact", head: true })
          .eq("user_id", this.plugin.currentUserId)
          .eq("vault_id", vaultId)
          .eq("is_binary", false)
          .is("deleted_at", null);

        if (noteError) console.warn(`Failed to count notes for vault ${vaultId}:`, noteError);

        // Fetch binary count (raw SQL / PostgREST count query)
        const { count: binaryCount, error: binaryError } = await this.plugin.supabase
          .from("obsidian_vault_files")
          .select("*", { count: "exact", head: true })
          .eq("user_id", this.plugin.currentUserId)
          .eq("vault_id", vaultId)
          .eq("is_binary", true)
          .is("deleted_at", null);

        if (binaryError) console.warn(`Failed to count binaries for vault ${vaultId}:`, binaryError);

        // Filter devices for this vault
        const vaultDevices = (devices || []).filter((d: any) => d.vault_id === vaultId);

        this.renderVaultItem(listContainer, vaultId, vaultDevices, noteCount || 0, binaryCount || 0, container);
      }

    } catch (err: any) {
      loadingEl.remove();
      const errorEl = container.createDiv();
      errorEl.setText(`Failed to load vaults: ${err.message || err}`);
      errorEl.style.color = "var(--text-error)";
      errorEl.style.padding = "10px";
    }
  }

  renderVaultItem(
    parent: HTMLDivElement,
    vaultId: string,
    devices: any[],
    noteCount: number,
    binaryCount: number,
    container: HTMLDivElement
  ) {
    const isCurrentVault = vaultId === this.plugin.settings.vaultId;

    // Create a beautiful premium card
    const card = parent.createDiv();
    card.style.border = isCurrentVault ? "1px solid var(--interactive-accent)" : "1px solid var(--border-color)";
    card.style.borderRadius = "8px";
    card.style.padding = "15px";
    card.style.backgroundColor = "var(--background-secondary)";
    card.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.05)";
    card.style.display = "flex";
    card.style.flexDirection = "column";
    card.style.gap = "10px";
    card.style.position = "relative";

    // Header line inside the card (Vault ID + Current Badge + Delete Button)
    const headerLine = card.createDiv();
    headerLine.style.display = "flex";
    headerLine.style.justifyContent = "space-between";
    headerLine.style.alignItems = "center";

    const titleContainer = headerLine.createDiv();
    titleContainer.style.display = "flex";
    titleContainer.style.alignItems = "center";
    titleContainer.style.gap = "8px";

    const vaultIdEl = titleContainer.createEl("span", { text: vaultId });
    vaultIdEl.style.fontWeight = "bold";
    vaultIdEl.style.fontSize = "1.1em";
    vaultIdEl.style.color = isCurrentVault ? "var(--text-accent)" : "var(--text-normal)";

    if (isCurrentVault) {
      const badge = titleContainer.createEl("span", { text: "active vault" });
      badge.style.fontSize = "0.75em";
      badge.style.padding = "2px 6px";
      badge.style.borderRadius = "4px";
      badge.style.backgroundColor = "var(--interactive-accent)";
      badge.style.color = "var(--text-on-accent)";
      badge.style.fontWeight = "600";
      badge.style.textTransform = "uppercase";
    }

    // Delete Button (ONLY if not current vault)
    if (!isCurrentVault) {
      const deleteBtn = headerLine.createEl("button", { text: "Delete Vault" });
      deleteBtn.addClass("mod-warning");
      deleteBtn.style.padding = "4px 8px";
      deleteBtn.style.fontSize = "0.85em";
      deleteBtn.addEventListener("click", () => {
        this.deleteVault(vaultId, container);
      });
    }

    // Counts line
    const countsLine = card.createDiv();
    countsLine.style.display = "flex";
    countsLine.style.gap = "15px";
    countsLine.style.fontSize = "0.9em";
    countsLine.style.color = "var(--text-muted)";

    const notesEl = countsLine.createDiv();
    notesEl.createSpan({ text: "📄 Notes: " }).style.color = "var(--text-normal)";
    notesEl.createSpan({ text: String(noteCount) }).style.fontWeight = "bold";

    const binariesEl = countsLine.createDiv();
    binariesEl.createSpan({ text: "📁 Binary Files: " }).style.color = "var(--text-normal)";
    binariesEl.createSpan({ text: String(binaryCount) }).style.fontWeight = "bold";

    // Devices Section
    const devicesContainer = card.createDiv();
    devicesContainer.style.borderTop = "1px solid var(--border-color)";
    devicesContainer.style.paddingTop = "8px";
    devicesContainer.style.marginTop = "4px";

    const devicesHeader = devicesContainer.createEl("div", { text: "Connected Devices:" });
    devicesHeader.style.fontWeight = "600";
    devicesHeader.style.fontSize = "0.85em";
    devicesHeader.style.color = "var(--text-muted)";
    devicesHeader.style.marginBottom = "12px";

    if (devices.length === 0) {
      const noDevices = devicesContainer.createEl("div", { text: "No registered devices." });
      noDevices.style.fontStyle = "italic";
      noDevices.style.fontSize = "0.85em";
      noDevices.style.color = "var(--text-muted)";
    } else {
      const devicesList = devicesContainer.createDiv();
      devicesList.style.display = "flex";
      devicesList.style.flexDirection = "column";
      devicesList.style.gap = "8px";

      for (const d of devices) {
        const deviceRow = devicesList.createDiv();
        deviceRow.style.display = "flex";
        if (Platform.isMobile) {
          deviceRow.style.flexDirection = "column";
          deviceRow.style.alignItems = "flex-start";
          deviceRow.style.gap = "2px";
        } else {
          deviceRow.style.flexDirection = "row";
          deviceRow.style.justifyContent = "space-between";
          deviceRow.style.alignItems = "center";
        }
        deviceRow.style.fontSize = "0.85em";

        const isThisDevice = isCurrentVault && d.device_name === this.plugin.settings.deviceName;

        const nameEl = deviceRow.createDiv();
        const platformStr = d.platform ? ` (${d.platform})` : "";
        nameEl.createSpan({ text: `💻 ${d.device_name}${platformStr}` });
        if (isThisDevice) {
          const suffix = nameEl.createSpan({ text: " (this device)" });
          suffix.style.fontWeight = "bold";
          suffix.style.color = "var(--text-accent)";
        }

        const syncTimeEl = deviceRow.createDiv();
        syncTimeEl.style.color = "var(--text-muted)";
        if (d.last_sync_at) {
          const syncDate = new Date(d.last_sync_at);
          syncTimeEl.setText(`Last Sync: ${syncDate.toLocaleString()}`);
        } else {
          syncTimeEl.setText("Last Sync: Never");
        }
      }
    }
  }

  async deleteVault(vaultId: string, container: HTMLDivElement) {
    const confirmMessage = `WARNING: Are you sure you want to permanently delete all data in the vault "${vaultId}" from the remote database and storage?\n\nThis will permanently delete all notes and binary files associated with this vault ID. This action is IRREVERSIBLE.\n\nRecommendation: It is highly recommended that you back up or export your data before performing this deletion.\n\nTo proceed, click Confirm.`;

    const confirmed = await this.plugin.showConfirm(confirmMessage);
    if (!confirmed) return;

    // Show a loading overlay or update status
    container.empty();
    const deletingEl = container.createDiv();
    deletingEl.setText(`Permanently deleting vault "${vaultId}"... Please wait.`);
    deletingEl.style.padding = "20px";
    deletingEl.style.textAlign = "center";
    deletingEl.style.fontWeight = "bold";
    deletingEl.style.color = "var(--text-accent)";

    try {
      if (!this.plugin.supabase || !this.plugin.currentUserId) {
        throw new Error("Supabase is not initialized or user is not logged in.");
      }

      // 1. Fetch all binary files for this vault ID to delete from storage
      const { data: filesToDelete, error: fetchError } = await this.plugin.supabase
        .from("obsidian_vault_files")
        .select("path")
        .eq("user_id", this.plugin.currentUserId)
        .eq("vault_id", vaultId)
        .eq("is_binary", true);

      if (fetchError) throw fetchError;

      if (filesToDelete && filesToDelete.length > 0) {
        const binaryPaths = filesToDelete.map(f => `${this.plugin.currentUserId}/${vaultId}/${f.path}`);

        // Chunk storage deletion if there are many binary files (Supabase Storage allows up to 100 at once)
        const chunkSize = 80;
        for (let i = 0; i < binaryPaths.length; i += chunkSize) {
          const chunk = binaryPaths.slice(i, i + chunkSize);
          const { error: storageError } = await this.plugin.supabase.storage
            .from("obsidian-vault-binaries")
            .remove(chunk);
          if (storageError) {
            console.warn(`Failed to clean up storage binaries chunk:`, storageError);
          }
        }
      }

      // 2. Delete all records from obsidian_vault_files
      const { error: dbFilesError } = await this.plugin.supabase
        .from("obsidian_vault_files")
        .delete()
        .eq("user_id", this.plugin.currentUserId)
        .eq("vault_id", vaultId);

      if (dbFilesError) throw dbFilesError;

      // 3. Delete all records from obsidian_sync_devices
      const { error: dbDevicesError } = await this.plugin.supabase
        .from("obsidian_sync_devices")
        .delete()
        .eq("user_id", this.plugin.currentUserId)
        .eq("vault_id", vaultId);

      if (dbDevicesError) throw dbDevicesError;

      new Notice(`Vault "${vaultId}" and all its remote files have been permanently deleted.`);

    } catch (err: any) {
      console.error("Failed to delete vault:", err);
      new Notice(`Failed to delete vault: ${err.message || err}`);
    } finally {
      // Refresh the modal content
      this.loadVaultsData(container);
    }
  }
}

