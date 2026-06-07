import { TFile, TAbstractFile } from "obsidian";
import type SupabaseSyncPlugin from "./main";
import type { RemoteFile } from "./types";
import { getSHA256Hash, getMimeType } from "./utils";
import { saveSyncQueue, saveSyncMetadata } from "./state";

// --- Obsidian Event Handlers ---

export async function handleFileChange(
  plugin: SupabaseSyncPlugin,
  file: TAbstractFile,
  action: "upload" | "delete"
): Promise<void> {
  // Ignore configuration files, sync state, and files in the .trash directory
  if (
    file.path.startsWith(plugin.configDir) ||
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
    plugin.syncQueue = plugin.syncQueue.filter((item) => item.path !== file.path);

    plugin.syncQueue.push({
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
      const trackedPaths = Object.keys(plugin.syncMetadata.files);
      let queueChanged = false;

      for (const path of trackedPaths) {
        if (path.startsWith(folderPrefix)) {
          const isBinary = path.toLowerCase().endsWith(".md") === false;

          // De-duplicate
          plugin.syncQueue = plugin.syncQueue.filter((item) => item.path !== path);

          plugin.syncQueue.push({
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

  await saveSyncQueue(plugin);

  if (plugin.settings.syncOnSave) {
    // Call via plugin to avoid circular import with sync-engine
    plugin.triggerDebouncedSync();
  }
}

export async function handleFileRename(
  plugin: SupabaseSyncPlugin,
  file: TAbstractFile,
  oldPath: string
): Promise<void> {
  const configDir = plugin.configDir;
  const isOldIgnored = oldPath.startsWith(configDir) || oldPath.startsWith(".trash") || oldPath.includes("/.trash/");
  const isNewIgnored = file.path.startsWith(configDir) || file.path.startsWith(".trash") || file.path.includes("/.trash/");

  if (isOldIgnored && isNewIgnored) {
    return;
  }

  if (file instanceof TFile) {
    const oldIsBinary = oldPath.toLowerCase().endsWith(".md") === false;
    const isBinary = file.extension.toLowerCase() !== "md";

    plugin.syncQueue = plugin.syncQueue.filter(
      (item) => item.path !== oldPath && item.path !== file.path
    );

    if (!isOldIgnored) {
      plugin.syncQueue.push({
        action: "delete",
        path: oldPath,
        timestamp: Date.now(),
        isBinary: oldIsBinary
      });
    }

    if (!isNewIgnored) {
      plugin.syncQueue.push({
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

    const trackedPaths = Object.keys(plugin.syncMetadata.files);
    let queueChanged = false;

    for (const path of trackedPaths) {
      if (path.startsWith(oldFolderPrefix)) {
        const relativePath = path.substring(oldFolderPrefix.length);
        const newFilePath = newFolderPrefix + relativePath;
        const isBinary = path.toLowerCase().endsWith(".md") === false;

        plugin.syncQueue = plugin.syncQueue.filter(
          (item) => item.path !== path && item.path !== newFilePath
        );

        if (!isOldIgnored) {
          plugin.syncQueue.push({
            action: "delete",
            path,
            timestamp: Date.now(),
            isBinary
          });
          queueChanged = true;
        }

        if (!isNewIgnored) {
          plugin.syncQueue.push({
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

  await saveSyncQueue(plugin);

  if (plugin.settings.syncOnSave) {
    // Call via plugin to avoid circular import with sync-engine
    plugin.triggerDebouncedSync();
  }
}

// --- Upload Operations ---

export async function uploadFile(
  plugin: SupabaseSyncPlugin,
  path: string,
  isBinary: boolean
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;

  if (isBinary) {
    await uploadBinary(plugin, file);
  } else {
    await uploadMarkdown(plugin, file);
  }
}

export async function uploadMarkdown(
  plugin: SupabaseSyncPlugin,
  file: TFile
): Promise<void> {
  const content = await plugin.app.vault.read(file);
  const hash = await getSHA256Hash(content);

  // Parse Frontmatter and metadata using Obsidian Cache API
  const fileCache = plugin.app.metadataCache.getFileCache(file);
  const frontmatter = fileCache?.frontmatter || {};

  // Extract dedicated columns from frontmatter
  const title = frontmatter.title ? String(frontmatter.title) : file.basename;

  let tags: string[] = [];
  const rawTags: unknown = frontmatter.tags ?? frontmatter.tag;
  if (rawTags) {
    if (Array.isArray(rawTags)) {
      tags = rawTags.map((t: unknown) => String(t).trim()).filter(Boolean);
    } else if (typeof rawTags === "string") {
      tags = rawTags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    }
  }


  // Upsert into Supabase obsidian_vault_files
  const { error } = await plugin.supabase!
    .from("obsidian_vault_files")
    .upsert({
      user_id: plugin.currentUserId,
      vault_id: plugin.settings.vaultId,
      path: file.path,
      content,
      is_binary: false,
      size: file.stat.size,
      hash,
      properties: frontmatter,
      title,
      tags,
      updated_at: new Date().toISOString(),
      deleted_at: null
    });

  if (error) throw error;

  // Save in local metadata
  plugin.syncMetadata.files[file.path] = {
    mtime: file.stat.mtime,
    hash
  };
  await saveSyncMetadata(plugin);
}

export async function uploadBinary(
  plugin: SupabaseSyncPlugin,
  file: TFile
): Promise<void> {
  const arrayBuffer = await plugin.app.vault.readBinary(file);
  const hash = await getSHA256Hash(arrayBuffer);
  const mimeType = getMimeType(file.extension);

  // Storage path structure: {user_id}/{vault_id}/{file_path}
  const storagePath = `${plugin.currentUserId}/${plugin.settings.vaultId}/${file.path}`;

  // Upload attachment to Supabase Storage bucket 'obsidian-vault-binaries'
  const blob = new Blob([arrayBuffer], { type: mimeType });
  const { error: uploadError } = await plugin.supabase!.storage
    .from("obsidian-vault-binaries")
    .upload(storagePath, blob, {
      upsert: true,
      contentType: mimeType
    });

  if (uploadError) throw uploadError;

  // Upsert metadata record in obsidian_vault_files database table
  const { error: dbError } = await plugin.supabase!
    .from("obsidian_vault_files")
    .upsert({
      user_id: plugin.currentUserId,
      vault_id: plugin.settings.vaultId,
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
  plugin.syncMetadata.files[file.path] = {
    mtime: file.stat.mtime,
    hash
  };
  await saveSyncMetadata(plugin);
}

// --- Delete Operations ---

export async function deleteFileRemote(
  plugin: SupabaseSyncPlugin,
  path: string,
  isBinary: boolean
): Promise<void> {
  if (!plugin.supabase || !plugin.currentUserId || !plugin.settings.vaultId) return;

  // If it's a binary file, delete from Supabase Storage
  if (isBinary) {
    const storagePath = `${plugin.currentUserId}/${plugin.settings.vaultId}/${path}`;
    const { error: storageError } = await plugin.supabase.storage
      .from("obsidian-vault-binaries")
      .remove([storagePath]);

    // Ignore resource not found errors for storage deletion
    if (storageError && !(storageError as { message?: string }).message?.includes("Object not found")) {
      throw storageError;
    }
  }

  // Determine if we should hard delete or soft delete
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  let shouldHardDelete = plugin.syncMetadata.files[path]?.hash === emptyHash;

  if (!shouldHardDelete && !isBinary) {
    // Fetch current database content to check if it's empty
    try {
      const { data } = await plugin.supabase
        .from("obsidian_vault_files")
        .select("content, size")
        .eq("user_id", plugin.currentUserId)
        .eq("vault_id", plugin.settings.vaultId)
        .eq("path", path)
        .maybeSingle();

      const dbFile = data as { content: string | null; size: number } | null;
      if (dbFile && (dbFile.content === "" || dbFile.content === null || dbFile.size === 0)) {
        shouldHardDelete = true;
      }
    } catch (e) {
      console.warn("Failed to check if remote file is empty during deletion:", e);
    }
  }

  if (shouldHardDelete) {
    console.log(`Hard-deleting empty file from database: ${path}`);
    const { error: dbError } = await plugin.supabase
      .from("obsidian_vault_files")
      .delete()
      .eq("user_id", plugin.currentUserId)
      .eq("vault_id", plugin.settings.vaultId)
      .eq("path", path);

    if (dbError) throw dbError;
  } else {
    console.log(`Soft-deleting file in database: ${path}`);
    // Soft delete in Postgres so that we can notify other sync clients of the deletion
    const { error: dbError } = await plugin.supabase
      .from("obsidian_vault_files")
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("user_id", plugin.currentUserId)
      .eq("vault_id", plugin.settings.vaultId)
      .eq("path", path);

    if (dbError) throw dbError;
  }

  // Remove from local sync metadata
  delete plugin.syncMetadata.files[path];
  await saveSyncMetadata(plugin);
}

// --- Download / Write Operations ---

export async function writeRemoteFileToLocal(
  plugin: SupabaseSyncPlugin,
  remoteFile: RemoteFile
): Promise<void> {
  const path = remoteFile.path;

  // Ensure parent directories exist
  const parts = path.split("/");
  if (parts.length > 1) {
    const folderPath = parts.slice(0, -1).join("/");
    if (!(await plugin.app.vault.adapter.exists(folderPath))) {
      await plugin.app.vault.createFolder(folderPath);
    }
  }

  if (remoteFile.is_binary) {
    const storagePath = `${plugin.currentUserId}/${plugin.settings.vaultId}/${path}`;
    // Download binary from Supabase Storage
    const { data, error } = await plugin.supabase!.storage
      .from("obsidian-vault-binaries")
      .download(storagePath);

    if (error) throw error;

    const arrayBuffer = await data.arrayBuffer();

    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await plugin.app.vault.modifyBinary(file, arrayBuffer);
    } else {
      await plugin.app.vault.createBinary(path, arrayBuffer);
    }

    const stat = await plugin.app.vault.adapter.stat(path);
    const mtime = stat ? stat.mtime : Date.now();
    plugin.syncMetadata.files[path] = {
      mtime: mtime,
      hash: remoteFile.hash
    };
  } else {
    // Write markdown file
    const file = plugin.app.vault.getAbstractFileByPath(path);
    const content = remoteFile.content ?? "";
    if (file instanceof TFile) {
      await plugin.app.vault.modify(file, content);
    } else {
      await plugin.app.vault.create(path, content);
    }

    const stat = await plugin.app.vault.adapter.stat(path);
    const mtime = stat ? stat.mtime : Date.now();
    plugin.syncMetadata.files[path] = {
      mtime: mtime,
      hash: remoteFile.hash
    };
  }

  await saveSyncMetadata(plugin);
}

// --- Local File Helpers ---

export async function deleteLocalFileRespectingSettings(
  plugin: SupabaseSyncPlugin,
  file: TFile
): Promise<void> {
  // Use FileManager.trashFile() to respect the user's file deletion preference
  // (system trash, .trash folder, or permanent delete) as configured in Obsidian settings.
  await plugin.app.fileManager.trashFile(file);
}

export function isLocallyModified(
  plugin: SupabaseSyncPlugin,
  file: TFile
): boolean {
  const meta = plugin.syncMetadata.files[file.path];
  if (!meta) return true; // Never synced before, so count as modified/new
  return file.stat.mtime > meta.mtime;
}
