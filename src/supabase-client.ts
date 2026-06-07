import { Notice, Platform } from "obsidian";
import { createClient } from "@supabase/supabase-js";
import type SupabaseSyncPlugin from "./main";

// Module-level state for client initialization tracking
let activeSupabaseUrl = "";
let activeSupabaseKey = "";
let initClientDebounceTimer: number | null = null;

export function clearInitClientDebounceTimer(): void {
  if (initClientDebounceTimer) {
    window.clearTimeout(initClientDebounceTimer);
    initClientDebounceTimer = null;
  }
}

export async function initSupabaseClient(plugin: SupabaseSyncPlugin, debounceMs = 0): Promise<void> {
  if (initClientDebounceTimer) {
    window.clearTimeout(initClientDebounceTimer);
    initClientDebounceTimer = null;
  }

  if (debounceMs > 0) {
    initClientDebounceTimer = window.setTimeout(() => {
      void initSupabaseClientImmediate(plugin);
    }, debounceMs);
  } else {
    await initSupabaseClientImmediate(plugin);
  }
}

async function initSupabaseClientImmediate(plugin: SupabaseSyncPlugin): Promise<void> {
  if (plugin.settings.supabaseUrl && plugin.settings.supabaseKey) {
    if (
      plugin.supabase &&
      activeSupabaseUrl === plugin.settings.supabaseUrl &&
      activeSupabaseKey === plugin.settings.supabaseKey
    ) {
      return;
    }
    try {
      plugin.supabase = createClient(plugin.settings.supabaseUrl, plugin.settings.supabaseKey, {
        auth: {
          persistSession: true,
          storage: {
            getItem: (_key: string) => {
              return plugin.settings.authSession || null;
            },
            setItem: async (_key: string, value: string) => {
              plugin.settings.authSession = value;
              await plugin.saveSettings();
            },
            removeItem: async (_key: string) => {
              plugin.settings.authSession = null;
              await plugin.saveSettings();
            }
          }
        }
      });
      activeSupabaseUrl = plugin.settings.supabaseUrl;
      activeSupabaseKey = plugin.settings.supabaseKey;
      console.log("Supabase client initialized successfully.");
      await checkAuth(plugin);
    } catch (e) {
      console.error("Failed to initialize Supabase client:", e);
      plugin.supabase = null;
      activeSupabaseUrl = "";
      activeSupabaseKey = "";
    }
  } else {
    plugin.supabase = null;
    activeSupabaseUrl = "";
    activeSupabaseKey = "";
    plugin.currentUserId = null;
    plugin.currentUserEmail = null;
    plugin.deviceId = null;
  }
  plugin.updateStatusBarBasedOnState();
}

export async function checkAuth(plugin: SupabaseSyncPlugin): Promise<boolean> {
  if (!plugin.supabase) {
    plugin.currentUserId = null;
    plugin.currentUserEmail = null;
    plugin.deviceId = null;
    return false;
  }
  try {
    const { data: { session }, error } = await plugin.supabase.auth.getSession();
    if (error) throw error;
    if (session && session.user) {
      plugin.currentUserId = session.user.id;
      plugin.currentUserEmail = session.user.email ?? null;
      console.log("Supabase Auth: Session restored for", plugin.currentUserEmail);

      await registerDevice(plugin);
      plugin.updateStatusBarBasedOnState();
      return true;
    } else {
      plugin.currentUserId = null;
      plugin.currentUserEmail = null;
      plugin.deviceId = null;
      plugin.updateStatusBarBasedOnState();
      return false;
    }
  } catch (e) {
    console.error("Supabase Auth: Failed to check session:", e);
    plugin.currentUserId = null;
    plugin.currentUserEmail = null;
    plugin.deviceId = null;
    plugin.updateStatusBarBasedOnState();
    return false;
  }
}

export async function signIn(plugin: SupabaseSyncPlugin, email: string, password: string): Promise<void> {
  if (!plugin.supabase) {
    throw new Error("Supabase client is not initialized.");
  }
  const { data, error } = await plugin.supabase.auth.signInWithPassword({
    email,
    password
  });
  if (error) {
    throw error;
  }
  if (data.session && data.session.user) {
    plugin.currentUserId = data.session.user.id;
    plugin.currentUserEmail = data.session.user.email ?? null;
    new Notice("Login successful!");

    await registerDevice(plugin);
    plugin.updateStatusBarBasedOnState();
  }
}

export async function signOut(plugin: SupabaseSyncPlugin): Promise<void> {
  if (!plugin.supabase) return;
  const { error } = await plugin.supabase.auth.signOut();
  if (error) {
    console.error("Supabase Auth: Sign out error:", error);
  }
  plugin.currentUserId = null;
  plugin.currentUserEmail = null;
  plugin.deviceId = null;
  new Notice("Logged out successfully.");
  plugin.updateStatusBarBasedOnState();
  // Call via plugin to avoid circular import with sync-engine
  plugin.stopIntervalSync();
}

export async function registerDevice(plugin: SupabaseSyncPlugin): Promise<void> {
  if (!plugin.supabase || !plugin.currentUserId || !plugin.settings.vaultId) {
    return;
  }

  if (!plugin.settings.deviceName) {
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
    plugin.settings.deviceName = defaultName;
    await plugin.saveSettings();
  }

  try {
    const payload: any = {
      user_id: plugin.currentUserId,
      vault_id: plugin.settings.vaultId,
      device_name: plugin.settings.deviceName,
      platform: Platform.isDesktop ? "Desktop" : Platform.isMobile ? "Mobile" : "Tablet",
      updated_at: new Date().toISOString()
    };
    if (plugin.deviceId) {
      payload.id = plugin.deviceId;
    }

    const { data, error } = await plugin.supabase
      .from("obsidian_sync_devices")
      .upsert(payload, {
        onConflict: plugin.deviceId ? "id" : "user_id,vault_id,device_name"
      })
      .select("id")
      .maybeSingle();

    if (error) throw error;
    if (data) {
      plugin.deviceId = (data as { id: string }).id;
      console.log("Device registered with ID:", plugin.deviceId);
    }
  } catch (e) {
    console.warn("Failed to register device in obsidian_sync_devices:", e);
  }
}

export async function updateDeviceLastSync(plugin: SupabaseSyncPlugin): Promise<void> {
  if (!plugin.supabase || !plugin.currentUserId || !plugin.deviceId) {
    return;
  }
  try {
    const { error } = await plugin.supabase
      .from("obsidian_sync_devices")
      .update({
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", plugin.deviceId);
    if (error) throw error;
  } catch (e) {
    console.warn("Failed to update device last sync time:", e);
  }
}
