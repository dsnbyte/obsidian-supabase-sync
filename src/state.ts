import type SupabaseSyncPlugin from "./main";

export async function loadSyncQueue(plugin: SupabaseSyncPlugin): Promise<void> {
  const path = plugin.syncQueuePath;
  if (await plugin.app.vault.adapter.exists(path)) {
    try {
      const content = await plugin.app.vault.adapter.read(path);
      plugin.syncQueue = JSON.parse(content) as typeof plugin.syncQueue;
    } catch (e) {
      console.error("Failed to load sync queue:", e);
      plugin.syncQueue = [];
    }
  }
}

export async function saveSyncQueue(plugin: SupabaseSyncPlugin): Promise<void> {
  const dir = plugin.pluginDir;
  if (!(await plugin.app.vault.adapter.exists(dir))) {
    await plugin.app.vault.adapter.mkdir(dir);
  }
  const path = plugin.syncQueuePath;
  await plugin.app.vault.adapter.write(path, JSON.stringify(plugin.syncQueue, null, 2));
}

export async function loadSyncMetadata(plugin: SupabaseSyncPlugin): Promise<void> {
  const path = plugin.syncMetadataPath;
  if (await plugin.app.vault.adapter.exists(path)) {
    try {
      const content = await plugin.app.vault.adapter.read(path);
      plugin.syncMetadata = JSON.parse(content) as typeof plugin.syncMetadata;
      if (!plugin.syncMetadata.files) {
        plugin.syncMetadata.files = {};
      }
    } catch (e) {
      console.error("Failed to load sync metadata:", e);
      plugin.syncMetadata = { lastSyncTime: 0, files: {} };
    }
  }
}

export async function saveSyncMetadata(plugin: SupabaseSyncPlugin): Promise<void> {
  const dir = plugin.pluginDir;
  if (!(await plugin.app.vault.adapter.exists(dir))) {
    await plugin.app.vault.adapter.mkdir(dir);
  }
  const path = plugin.syncMetadataPath;
  await plugin.app.vault.adapter.write(path, JSON.stringify(plugin.syncMetadata, null, 2));
}
