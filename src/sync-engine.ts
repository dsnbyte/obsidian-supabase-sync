import { TFile, Notice } from "obsidian";
import type SupabaseSyncPlugin from "./main";
import type { RemoteFile } from "./types";
import { uploadFile, deleteFileRemote, writeRemoteFileToLocal, deleteLocalFileRespectingSettings, isLocallyModified } from "./file-operations";
import { saveSyncQueue, saveSyncMetadata } from "./state";
import { updateDeviceLastSync } from "./supabase-client";
import { getSHA256Hash } from "./utils";

// Module-level state for interval sync timer
let syncIntervalTimer: number | null = null;

// --- Interval Sync ---

export function startIntervalSync(plugin: SupabaseSyncPlugin): void {
  stopIntervalSync();

  if (plugin.settings.syncInterval > 0) {
    const intervalMs = plugin.settings.syncInterval * 1000;
    syncIntervalTimer = window.setInterval(() => {
      handleIntervalSync(plugin);
    }, intervalMs);
  }
}

export function stopIntervalSync(): void {
  if (syncIntervalTimer) {
    window.clearInterval(syncIntervalTimer);
    syncIntervalTimer = null;
  }
}

function handleIntervalSync(plugin: SupabaseSyncPlugin): void {
  // Check if the app is hidden/minimized (very battery-friendly, especially on mobile)
  if (typeof document !== "undefined" && document.hidden) {
    console.log("Supabase Sync: Obsidian is in the background. Skipping interval sync to save battery.");
    return;
  }

  if (!plugin.supabase || !plugin.currentUserId || !plugin.settings.vaultId) {
    return;
  }

  console.log("Supabase Sync: Triggering periodic interval sync...");
  void runSync(plugin);
}

// --- Debounced Sync ---

export function triggerDebouncedSync(plugin: SupabaseSyncPlugin): void {
  if (plugin.debounceTimer) {
    window.clearTimeout(plugin.debounceTimer);
    plugin.debounceTimer = null;
  }

  if (plugin.settings.syncOnSave) {
    const delayMs = (plugin.settings.syncDelay || 2) * 1000;
    plugin.debounceTimer = window.setTimeout(() => {
      void runSync(plugin);
    }, delayMs);
  }
}

// --- Core Sync Logic (Offline-First) ---

export async function runSync(plugin: SupabaseSyncPlugin): Promise<void> {
  if (plugin.isSyncing) return;
  if (!plugin.supabase) {
    plugin.updateStatusBar("Configuration Required");
    new Notice("Error: Supabase connection settings are incomplete.");
    return;
  }
  if (!plugin.currentUserId) {
    plugin.updateStatusBar("Login Required");
    new Notice("Error: You must log in to your Supabase account to start synchronization.");
    return;
  }
  if (!plugin.settings.vaultId) {
    plugin.updateStatusBar("Vault ID Required");
    new Notice("Error: Vault ID is required to start synchronization. Please enter a Vault ID in settings.");
    return;
  }

  plugin.isSyncing = true;
  plugin.updateStatusBar("Syncing...");
  console.log("Sync started...");

  try {
    // 1. Fetch remote changes since last sync (pull first to safely resolve conflicts)
    await pullRemoteChanges(plugin);

    // 2. Scan local vault for untracked or modified files
    await scanLocalVault(plugin);

    // 3. Process local offline queue (upload the local changes and any new conflict files)
    await processQueue(plugin);

    // 4. Auto-cleanup soft-deleted files older than TTL (Fix D)
    await autoCleanupSoftDeleted(plugin);

    // 5. Update Sync Metadata timestamp
    plugin.syncMetadata.lastSyncTime = Date.now();
    await saveSyncMetadata(plugin);

    // 6. Update device tracking timestamp
    await updateDeviceLastSync(plugin);

    plugin.updateStatusBar("Synced");
    console.log("Sync complete successfully.");
  } catch (e) {
    console.error("Error during sync:", e);
    plugin.updateStatusBar("Error");
    new Notice("Sync failed: Check Supabase settings or network connection.");
  } finally {
    plugin.isSyncing = false;
  }
}

// --- Auto-Cleanup ---

export async function autoCleanupSoftDeleted(plugin: SupabaseSyncPlugin): Promise<void> {
  if (!plugin.supabase || !plugin.currentUserId || !plugin.settings.vaultId) return;

  // Clean up expired inactive devices
  await autoCleanupExpiredDevices(plugin);

  const ttlDays = plugin.settings.softDeleteTTL || 30;
  const thresholdDate = new Date(Date.now() - ttlDays * 24 * 3600 * 1000).toISOString();

  try {
    const { data, error: fetchError } = await plugin.supabase
      .from("obsidian_vault_files")
      .select("path, is_binary")
      .eq("user_id", plugin.currentUserId)
      .eq("vault_id", plugin.settings.vaultId)
      .not("deleted_at", "is", null)
      .lt("deleted_at", thresholdDate);

    if (fetchError) {
      console.warn("Auto-cleanup: Failed to fetch expired soft-deleted files:", fetchError);
      return;
    }

    const filesToDelete = data as { path: string; is_binary: boolean }[] | null;
    if (!filesToDelete || filesToDelete.length === 0) return;

    console.log(`Auto-cleanup: Hard-deleting ${filesToDelete.length} expired soft-deleted file(s)...`);

    // Remove binaries from Storage (Path structure: user_id/vault_id/path)
    const binaryPaths = filesToDelete.filter(f => f.is_binary).map(f => `${plugin.currentUserId}/${plugin.settings.vaultId}/${f.path}`);
    if (binaryPaths.length > 0) {
      const { error: storageError } = await plugin.supabase.storage
        .from("obsidian-vault-binaries")
        .remove(binaryPaths);
      if (storageError) console.warn("Auto-cleanup: Storage cleanup error:", storageError);
    }

    // Hard-delete from DB
    const pathsToDelete = filesToDelete.map(f => f.path);
    const { error: deleteError } = await plugin.supabase
      .from("obsidian_vault_files")
      .delete()
      .eq("user_id", plugin.currentUserId)
      .eq("vault_id", plugin.settings.vaultId)
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

export async function autoCleanupExpiredDevices(plugin: SupabaseSyncPlugin): Promise<void> {
  if (!plugin.supabase || !plugin.currentUserId || !plugin.settings.vaultId) return;

  const thresholdDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  try {
    console.log("Auto-cleanup: Cleaning up expired inactive devices from database...");
    const { error } = await plugin.supabase
      .from("obsidian_sync_devices")
      .delete()
      .eq("user_id", plugin.currentUserId)
      .eq("vault_id", plugin.settings.vaultId)
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

// --- Queue Processing ---

export async function processQueue(plugin: SupabaseSyncPlugin): Promise<void> {
  if (plugin.syncQueue.length === 0) return;

  console.log(`Processing queue of ${plugin.syncQueue.length} items...`);
  const activeQueue = [...plugin.syncQueue];

  for (const item of activeQueue) {
    try {
      if (item.action === "upload") {
        await uploadFile(plugin, item.path, item.isBinary);
      } else if (item.action === "delete") {
        await deleteFileRemote(plugin, item.path, item.isBinary);
      }

      // Remove item from queue only after successful execution
      plugin.syncQueue = plugin.syncQueue.filter((qi) => qi.path !== item.path || qi.action !== item.action);
      await saveSyncQueue(plugin);
    } catch (e) {
      console.error(`Failed to process queue item for ${item.path}:`, e);
      // Throw error to halt the sync process so we don't corrupt the sync sequence
      throw e;
    }
  }
}

// --- Pull Remote Changes (Sync Bidirectionally) ---

export async function pullRemoteChanges(plugin: SupabaseSyncPlugin): Promise<void> {
  console.log("Fetching remote file list from Supabase...");

  // Retrieve metadata for all files in the database
  const { data, error } = await plugin.supabase!
    .from("obsidian_vault_files")
    .select("path, updated_at, hash, is_binary, deleted_at")
    .eq("user_id", plugin.currentUserId)
    .eq("vault_id", plugin.settings.vaultId);

  if (error) throw error;

  const remoteFiles: RemoteFile[] | null = data as RemoteFile[] | null;

  // Connection successful! Check for project changes or empty remote data.
  const currentUrl = plugin.settings.supabaseUrl;
  const isFirstSyncToProject = !plugin.syncMetadata.lastSyncedUrl || plugin.syncMetadata.lastSyncedUrl !== currentUrl;
  const activeRemoteFiles: RemoteFile[] = remoteFiles || [];

  if (isFirstSyncToProject) {
    console.log(`First-time connection to new project URL verified successfully: ${currentUrl}. Resetting local sync tracking metadata.`);
    new Notice("First sync to this Supabase project. Safely initializing...");
    plugin.syncMetadata.files = {};
    plugin.syncMetadata.lastSyncTime = 0;
    plugin.syncMetadata.lastSyncedUrl = currentUrl;
    await saveSyncMetadata(plugin);
  } else if (activeRemoteFiles.length === 0 && Object.keys(plugin.syncMetadata.files).length > 0) {
    // Same project URL, but the remote database has no matching files, while we have local tracked files.
    // This indicates the remote database was wiped or all files were cleared.
    // Reset tracking to prevent deleting all local files.
    console.log("No remote files found for this vault, but local metadata exists. Assuming wiped remote database. Resetting local metadata to perform clean upload.");
    new Notice("No remote files found. Re-initializing vault upload to protect local files...");
    plugin.syncMetadata.files = {};
    plugin.syncMetadata.lastSyncTime = 0;
    await saveSyncMetadata(plugin);
  }

  console.log(`Analyzing ${activeRemoteFiles.length} remote files...`);

  for (const remoteFile of activeRemoteFiles) {
    const localFile = plugin.app.vault.getAbstractFileByPath(remoteFile.path);
    const meta = plugin.syncMetadata.files[remoteFile.path];

    // Case 1: Remote file is soft-deleted
    if (remoteFile.deleted_at) {
      if (localFile instanceof TFile) {
        let isModifiedLocally = isLocallyModified(plugin, localFile);

        if (isModifiedLocally) {
          // Double check content hash to avoid mtime false positives
          const localContent = localFile.extension.toLowerCase() === "md"
            ? await plugin.app.vault.read(localFile)
            : await plugin.app.vault.readBinary(localFile);
          const localHash = await getSHA256Hash(localContent);
          if (meta && localHash === meta.hash) {
            isModifiedLocally = false; // Not actually modified!
          }
        }

        if (!isModifiedLocally) {
          console.log(`Remote deleted file. Deleting local file: ${remoteFile.path}`);
          await deleteLocalFileRespectingSettings(plugin, localFile);
          delete plugin.syncMetadata.files[remoteFile.path];
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
      const lastSyncTimeWithBuffer = Math.max(0, plugin.syncMetadata.lastSyncTime - bufferMs);
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
        const physicallyExists = await plugin.app.vault.adapter.exists(remoteFile.path);
        if (!physicallyExists) {
          const hasPendingDelete = plugin.syncQueue.some(
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
      const isModified = isLocallyModified(plugin, localFile);

      if (isModified) {
        const localContent = localFile.extension.toLowerCase() === "md"
          ? await plugin.app.vault.read(localFile)
          : await plugin.app.vault.readBinary(localFile);

        const localHash = await getSHA256Hash(localContent);

        // If the contents are already identical, just update metadata and skip conflict resolution
        if (localHash === remoteFile.hash) {
          plugin.syncMetadata.files[remoteFile.path] = {
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

        await plugin.app.vault.rename(localFile, conflictPath);
      }
    }

    // Write remote file to local vault (this also updates local metadata with the remote file's hash)
    console.log(`Downloading and writing remote file: ${remoteFile.path}`);

    let fullRemoteFile = remoteFile;
    if (!remoteFile.is_binary) {
      const response = await plugin.supabase!
        .from("obsidian_vault_files")
        .select("*")
        .eq("user_id", plugin.currentUserId)
        .eq("vault_id", plugin.settings.vaultId)
        .eq("path", remoteFile.path)
        .maybeSingle();

      if (response.error) throw response.error;
      const dbFile = response.data as RemoteFile | null;
      if (!dbFile) {
        console.warn(`File not found in DB when fetching content: ${remoteFile.path}`);
        continue;
      }
      fullRemoteFile = dbFile;
    }

    await writeRemoteFileToLocal(plugin, fullRemoteFile);
  }

  // Fix B/E: Check for files in local metadata that are NOT in remote.
  // These could be hard-deleted remotely (after TTL) or never propagated.
  // We must distinguish between:
  //   - User intentionally deleted (has a delete event in queue) → clean up metadata only
  //   - File just "disappeared" remotely without intent → DO NOT delete local; remove from metadata
  //     so scanLocalVault will re-queue it for upload.
  const remotePaths = new Set(activeRemoteFiles.map((rf) => rf.path));
  for (const localPath of Object.keys(plugin.syncMetadata.files)) {
    if (!remotePaths.has(localPath)) {
      console.log(`File not found on remote: ${localPath}. Checking delete intent...`);

      // Check if there's an explicit delete event in the queue for this file
      const hasDeleteIntent = plugin.syncQueue.some(
        (item) => item.path === localPath && item.action === "delete"
      );

      if (hasDeleteIntent) {
        // User intentionally deleted this file — the queue will propagate the soft-delete to remote.
        // Just clean up local metadata here.
        console.log(`Delete intent confirmed for: ${localPath}. Removing from metadata (queue will handle remote).`);
        delete plugin.syncMetadata.files[localPath];
      } else {
        // Fix E: No delete intent found. The file vanished from remote (hard-deleted after TTL,
        // or remote was partially wiped). DO NOT delete the local file.
        // Remove from metadata only — scanLocalVault will detect it as untracked and re-upload it.
        const localFile = plugin.app.vault.getAbstractFileByPath(localPath);
        if (localFile instanceof TFile) {
          console.log(`Fix E: No delete intent for ${localPath}. File exists locally — removing from metadata so it gets re-uploaded.`);
        } else {
          console.log(`Fix E: No delete intent for ${localPath} and file not on disk either — cleaning up metadata.`);
        }
        delete plugin.syncMetadata.files[localPath];
      }
    }
  }

  await saveSyncMetadata(plugin);
}

// --- Local Vault Scanning ---

export async function scanLocalVault(plugin: SupabaseSyncPlugin): Promise<void> {
  console.log("Scanning local vault for untracked or modified files...");
  const files = plugin.app.vault.getFiles();
  let queueChanged = false;

  for (const file of files) {
    // Ignore configuration files, sync state, and files in the .trash directory
    if (
      file.path.startsWith(plugin.configDir) ||
      file.path.startsWith(".trash") ||
      file.path.includes("/.trash/") ||
      file.path.includes("sync-queue") ||
      file.path.includes("sync-metadata")
    ) {
      continue;
    }

    const meta = plugin.syncMetadata.files[file.path];
    const isBinary = file.extension.toLowerCase() !== "md";

    if (!meta) {
      // Untracked file! Add to sync queue if not already there
      const inQueue = plugin.syncQueue.some((item) => item.path === file.path && item.action === "upload");
      if (!inQueue) {
        console.log(`Discovered untracked file: ${file.path}`);
        plugin.syncQueue.push({
          action: "upload",
          path: file.path,
          timestamp: Date.now(),
          isBinary
        });
        queueChanged = true;
      }
    } else if (file.stat.mtime > meta.mtime) {
      // Locally modified since last sync! Add to sync queue if not already there
      const inQueue = plugin.syncQueue.some(
        (item) => item.path === file.path && item.action === "upload"
      );
      if (!inQueue) {
        console.log(`Discovered externally modified file: ${file.path}`);
        plugin.syncQueue.push({
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
    await saveSyncQueue(plugin);
  }
}
