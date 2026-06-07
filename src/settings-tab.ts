import {
  PluginSettingTab,
  Setting,
  App,
  Notice,
  TextComponent,
  ButtonComponent
} from "obsidian";
import type SupabaseSyncPlugin from "./main";
import { ManageVaultsModal } from "./modals";

// --- Settings Tab UI Implementation ---

export class SupabaseSyncSettingTab extends PluginSettingTab {
  plugin: SupabaseSyncPlugin;
  includeDeletedInExport = false;

  constructor(app: App, plugin: SupabaseSyncPlugin) {
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

  private escapeJson(val: unknown): string {
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
    const a = activeDocument.createElement("a");
    a.href = url;
    a.download = fileName;
    activeDocument.body.appendChild(a);
    a.click();
    activeDocument.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  display(): void {
    this.render();
  }

  render(): void {
    const { containerEl } = this;
    let isSaving = false;
    let isInteracting = false;

    containerEl.empty();

    new Setting(containerEl).setName("Supabase Setup").setHeading();

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
                void this.plugin.initSupabaseClient();
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

              const { error: dbError } = await dbQuery;

              if (dbError) {
                throw new Error(`Database connection failed: ${dbError.message}`);
              }

              // 2. Test storage access
              const { error: storageError } = await this.plugin.supabase.storage
                .from("obsidian-vault-binaries")
                .list("", { limit: 1 });

              if (storageError) {
                throw new Error(`Storage access failed: ${storageError.message}`);
              }

              new Notice("Connection test successful! Both Database and Storage are fully accessible.");
            } catch (err) {
              console.error("Connection test failed:", err);
              const errorMsg = err instanceof Error ? err.message : String(err);
              new Notice(`Connection test failed: ${errorMsg}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Test Connection");
            }
          })
      );

    const descEl = containerEl.createEl("p");
    descEl.setCssStyles({
      fontSize: "0.8em",
      marginTop: "12px",
      marginBottom: "15px",
      paddingLeft: "15px",
      color: "var(--text-muted)"
    });

    descEl.createEl("span", { text: "First time using this plugin? You must set up your database first. Read the " });
    descEl.createEl("a", {
      text: "Supabase Setup Guide",
      href: "https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SUPABASE_SETUP.md"
    });
    descEl.createEl("span", { text: " for step-by-step instructions." });


    // Authentication Section
    new Setting(containerEl).setName("Authentication").setHeading();

    if (this.plugin.currentUserId) {
      new Setting(containerEl)
        .setName("Logged In")
        .setDesc(`Logged in as: ${this.plugin.currentUserEmail}`)
        .addButton((button) =>
          button
            .setButtonText("Log Out")
            .onClick(async () => {
              await this.plugin.signOut();
              this.render(); // Refresh settings UI
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
                this.render(); // Refresh settings UI
              } catch (e) {
                console.error("Login failed:", e);
                const errorMsg = e instanceof Error ? e.message : String(e);
                new Notice(`Login failed: ${errorMsg}`);
              } finally {
                button.setDisabled(false);
                button.setButtonText("Log In");
              }
            })
        );
    }

    // Vault & Device Configuration Section
    new Setting(containerEl).setName("Vault & Device Configuration").setHeading();

    let textComponent: TextComponent | undefined;
    let saveButtonComponent: ButtonComponent | undefined;
    let editButtonComponent: ButtonComponent | undefined;
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
            inputEl.setCssStyles({
              cursor: "default",
              opacity: "0.75"
            });
          } else {
            inputEl.setCssStyles({
              cursor: "text",
              opacity: "1"
            });
          }
        };

        // Helper to clear text selection robustly
        clearInputSelection = () => {
          try {
            inputEl.selectionStart = 0;
            inputEl.selectionEnd = 0;
            inputEl.setSelectionRange(0, 0);
            window.getSelection()?.removeAllRanges();
          } catch {
            /* Intentionally empty: selection clearing may throw in some environments */
          }
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
            saveButtonComponent?.buttonEl.show();
            editButtonComponent?.buttonEl.hide();
            updateSaveButtonState();
            updateInputStyle();
          }
        });

        // Lost focus / blur handler
        inputEl.addEventListener("blur", () => {
          clearInputSelection();

          window.setTimeout(() => {
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
                textComponent?.setValue(this.plugin.settings.vaultId);
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
          if (!textComponent) return;
          isSaving = true;
          const inputEl = textComponent.inputEl;
          const cleaned = inputEl.value.trim();

          if (!cleaned || cleaned === this.plugin.settings.vaultId) {
            isSaving = false;
            window.setTimeout(() => { isInteracting = false; }, 300);
            return;
          }

          // Trigger confirmation logic
          btn.setDisabled(true);
          const success = await this.plugin.updateVaultId(cleaned);
          btn.setDisabled(false);

          if (success) {
            inputEl.setAttribute("readonly", "true");
            saveButtonComponent?.buttonEl.hide();
            editButtonComponent?.buttonEl.show();
          } else {
            // failed / cancelled: revert and reset state
            textComponent?.setValue(this.plugin.settings.vaultId);
            if (!this.plugin.settings.vaultId) {
              inputEl.removeAttribute("readonly");
              saveButtonComponent?.buttonEl.show();
              editButtonComponent?.buttonEl.hide();
            } else {
              inputEl.setAttribute("readonly", "true");
              saveButtonComponent?.buttonEl.hide();
              editButtonComponent?.buttonEl.show();
            }
          }
          isSaving = false;
          window.setTimeout(() => { isInteracting = false; }, 300);
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
          if (!textComponent) return;
          const inputEl = textComponent.inputEl;
          inputEl.removeAttribute("readonly");
          inputEl.focus();
          saveButtonComponent?.buttonEl.show();
          editButtonComponent?.buttonEl.hide();
          updateSaveButtonState();
          updateInputStyle();
          // Reset isInteracting flag after any blur events have checked it
          window.setTimeout(() => {
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

            deviceNameTimeout = window.setTimeout(() => {
              void (async () => {
                if (cleaned && cleaned !== this.plugin.settings.deviceName) {
                  this.plugin.settings.deviceName = cleaned;
                  await this.plugin.saveSettings();
                  await this.plugin.registerDevice();
                }
              })();
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
    new Setting(containerEl).setName("Sync Control").setHeading();

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
          .setDestructive()
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
            } catch (err) {
              console.error("Reset sync failed:", err);
              const errorMsg = err instanceof Error ? err.message : String(err);
              new Notice(`Reset failed: ${errorMsg}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Reset Sync");
            }
          })
      );

    // Server Maintenance Section
    new Setting(containerEl).setName("Server Maintenance").setHeading();

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
              const { data, error: fetchError } = await query;

              if (fetchError) throw fetchError;

              const filesToDelete = data as { path: string; is_binary: boolean }[] | null;
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
            } catch (err) {
              console.error("Cleanup failed:", err);
              const errorMsg = err instanceof Error ? err.message : String(err);
              new Notice(`Cleanup failed: ${errorMsg}`);
            } finally {
              button.setDisabled(false);
              button.setButtonText("Clean Up Now");
            }
          })
      );

    // Backup & Export
    new Setting(containerEl).setName("Backup & Export").setHeading();

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

              const filesData = data as Record<string, unknown>[] | null;
              if (!filesData || filesData.length === 0) {
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
              sqlStatements.push(`-- Total Records: ${filesData.length}`);
              sqlStatements.push(``);

              for (const row of filesData) {
                const sql = `INSERT INTO obsidian_vault_files (
  user_id, vault_id, path, content, is_binary, mime_type, size, hash, properties,
  title, tags, created_at, updated_at, deleted_at
) VALUES (
  ${this.escapeString(row["user_id"] as string | null)},
  ${this.escapeString(row["vault_id"] as string | null)},
  ${this.escapeString(row["path"] as string | null)},
  ${this.escapeString(row["content"] as string | null)},
  ${this.escapeBoolean(row["is_binary"] as boolean | null)},
  ${this.escapeString(row["mime_type"] as string | null)},
  ${this.escapeNumber(row["size"] as number | null)},
  ${this.escapeString(row["hash"] as string | null)},
  ${this.escapeJson(row["properties"])},
  ${this.escapeString(row["title"] as string | null)},
  ${this.escapeTextArray(row["tags"] as string[] | null)},
  ${this.escapeString(row["created_at"] as string | null)},
  ${this.escapeString(row["updated_at"] as string | null)},
  ${this.escapeString(row["deleted_at"] as string | null)}
) ON CONFLICT (user_id, vault_id, path) DO UPDATE SET
  content = EXCLUDED.content,
  is_binary = EXCLUDED.is_binary,
  mime_type = EXCLUDED.mime_type,
  size = EXCLUDED.size,
  hash = EXCLUDED.hash,
  properties = EXCLUDED.properties,
  title = EXCLUDED.title,
  tags = EXCLUDED.tags,
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
            } catch (err) {
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
