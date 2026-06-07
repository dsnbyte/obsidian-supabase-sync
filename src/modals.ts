import { Modal, App, Platform, Notice, Setting } from "obsidian";
import type SupabaseSyncPlugin from "./main";
import type { SyncDevice } from "./types";

// --- Confirm Modal Helper ---

export function showConfirm(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, message, (result) => {
      resolve(result);
    }).open();
  });
}

// --- Confirm Modal ---

export class ConfirmModal extends Modal {
  private message: string;
  private onSubmit: (result: boolean) => void;
  private result = false;

  constructor(app: App, message: string, onSubmit: (result: boolean) => void) {
    super(app);
    this.message = message;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle("Confirm Action");

    const messageEl = contentEl.createEl("p", { text: this.message });
    messageEl.setCssStyles({
      whiteSpace: "pre-wrap",
      margin: "1em 0"
    });

    const buttonContainer = contentEl.createDiv();
    buttonContainer.setCssStyles({
      display: "flex",
      justifyContent: "flex-end",
      gap: "10px",
      marginTop: "1.5em"
    });

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

// --- Manage Vaults Modal ---

export class ManageVaultsModal extends Modal {
  plugin: SupabaseSyncPlugin;

  constructor(app: App, plugin: SupabaseSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Set modal size/styles
    this.modalEl.setCssStyles({
      width: "650px",
      maxWidth: "90vw"
    });

    this.setTitle("Manage Database Vaults");

    const container = contentEl.createDiv();
    container.setCssStyles({
      marginTop: "1em"
    });

    void this.loadVaultsData(container);
  }

  async loadVaultsData(container: HTMLDivElement) {
    container.empty();

    // Loading state
    const loadingEl = container.createDiv();
    loadingEl.setText("Loading vaults from Supabase database...");
    loadingEl.setCssStyles({
      color: "var(--text-muted)",
      padding: "20px",
      textAlign: "center"
    });

    try {
      if (!this.plugin.supabase || !this.plugin.currentUserId) {
        throw new Error("Supabase is not initialized or user is not logged in.");
      }

      // 1. Fetch devices for current user
      const { data: devicesRaw, error: devicesError } = await this.plugin.supabase
        .from("obsidian_sync_devices")
        .select("vault_id, device_name, platform, last_sync_at")
        .eq("user_id", this.plugin.currentUserId);

      if (devicesError) throw devicesError;

      const devices = devicesRaw as SyncDevice[] | null;

      // 2. Fetch all vault_ids from vault_files
      const { data: filesDataRaw, error: filesError } = await this.plugin.supabase
        .from("obsidian_vault_files")
        .select("vault_id")
        .eq("user_id", this.plugin.currentUserId);

      if (filesError) throw filesError;

      const filesData = filesDataRaw as Array<{ vault_id: string }> | null;

      // Aggregate unique vault IDs
      const vaultIds = new Set<string>();
      if (this.plugin.settings.vaultId) {
        vaultIds.add(this.plugin.settings.vaultId);
      }
      if (devices) {
        devices.forEach((d) => vaultIds.add(d.vault_id));
      }
      if (filesData) {
        filesData.forEach((f) => vaultIds.add(f.vault_id));
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
      listContainer.setCssStyles({
        display: "flex",
        flexDirection: "column",
        gap: "15px"
      });

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
        const vaultDevices = (devices || []).filter((d) => d.vault_id === vaultId);

        this.renderVaultItem(listContainer, vaultId, vaultDevices, noteCount || 0, binaryCount || 0, container);
      }

    } catch (err) {
      loadingEl.remove();
      const errorEl = container.createDiv();
      const errorMsg = err instanceof Error ? err.message : String(err);
      errorEl.setText(`Failed to load vaults: ${errorMsg}`);
      errorEl.setCssStyles({
        color: "var(--text-error)",
        padding: "10px"
      });
    }
  }

  renderVaultItem(
    parent: HTMLDivElement,
    vaultId: string,
    devices: SyncDevice[],
    noteCount: number,
    binaryCount: number,
    container: HTMLDivElement
  ) {
    const isCurrentVault = vaultId === this.plugin.settings.vaultId;

    // Create a beautiful premium card
    const card = parent.createDiv();
    card.setCssStyles({
      border: isCurrentVault ? "1px solid var(--interactive-accent)" : "1px solid var(--border-color)",
      borderRadius: "8px",
      padding: "15px",
      backgroundColor: "var(--background-secondary)",
      boxShadow: "0 2px 4px rgba(0, 0, 0, 0.05)",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      position: "relative"
    });

    // Header line inside the card (Vault ID + Current Badge + Delete Button)
    const headerLine = card.createDiv();
    headerLine.setCssStyles({
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center"
    });

    const titleContainer = headerLine.createDiv();
    titleContainer.setCssStyles({
      display: "flex",
      alignItems: "center",
      gap: "8px"
    });

    const vaultIdEl = titleContainer.createEl("span", { text: vaultId });
    vaultIdEl.setCssStyles({
      fontWeight: "bold",
      fontSize: "1.1em",
      color: isCurrentVault ? "var(--text-accent)" : "var(--text-normal)"
    });

    if (isCurrentVault) {
      const badge = titleContainer.createEl("span", { text: "active vault" });
      badge.setCssStyles({
        fontSize: "0.75em",
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: "var(--interactive-accent)",
        color: "var(--text-on-accent)",
        fontWeight: "600",
        textTransform: "uppercase"
      });
    }

    // Delete Button (ONLY if not current vault)
    if (!isCurrentVault) {
      const deleteBtn = headerLine.createEl("button", { text: "Delete Vault" });
      deleteBtn.addClass("mod-warning");
      deleteBtn.setCssStyles({
        padding: "4px 8px",
        fontSize: "0.85em"
      });
      deleteBtn.addEventListener("click", () => {
        void this.deleteVault(vaultId, container);
      });
    }

    // Counts line
    const countsLine = card.createDiv();
    countsLine.setCssStyles({
      display: "flex",
      gap: "15px",
      fontSize: "0.9em",
      color: "var(--text-muted)"
    });

    const notesEl = countsLine.createDiv();
    notesEl.createSpan({ text: "📄 Notes: " }).setCssStyles({ color: "var(--text-normal)" });
    notesEl.createSpan({ text: String(noteCount) }).setCssStyles({ fontWeight: "bold" });

    const binariesEl = countsLine.createDiv();
    binariesEl.createSpan({ text: "📁 Binary Files: " }).setCssStyles({ color: "var(--text-normal)" });
    binariesEl.createSpan({ text: String(binaryCount) }).setCssStyles({ fontWeight: "bold" });

    // Devices Section
    const devicesContainer = card.createDiv();
    devicesContainer.setCssStyles({
      borderTop: "1px solid var(--border-color)",
      paddingTop: "8px",
      marginTop: "4px"
    });

    const devicesHeader = devicesContainer.createEl("div", { text: "Connected Devices:" });
    devicesHeader.setCssStyles({
      fontWeight: "600",
      fontSize: "0.85em",
      color: "var(--text-muted)",
      marginBottom: "12px"
    });

    if (devices.length === 0) {
      const noDevices = devicesContainer.createEl("div", { text: "No registered devices." });
      noDevices.setCssStyles({
        fontStyle: "italic",
        fontSize: "0.85em",
        color: "var(--text-muted)"
      });
    } else {
      const devicesList = devicesContainer.createDiv();
      devicesList.setCssStyles({
        display: "flex",
        flexDirection: "column",
        gap: "8px"
      });

      for (const d of devices) {
        const deviceRow = devicesList.createDiv();
        deviceRow.setCssStyles({
          display: "flex",
          fontSize: "0.85em",
          ...(Platform.isMobile ? {
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "2px"
          } : {
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center"
          })
        });

        const isThisDevice = isCurrentVault && d.device_name === this.plugin.settings.deviceName;

        const nameEl = deviceRow.createDiv();
        const platformStr = d.platform ? ` (${d.platform})` : "";
        nameEl.createSpan({ text: `💻 ${d.device_name}${platformStr}` });
        if (isThisDevice) {
          const suffix = nameEl.createSpan({ text: " (this device)" });
          suffix.setCssStyles({
            fontWeight: "bold",
            color: "var(--text-accent)"
          });
        }

        const syncTimeEl = deviceRow.createDiv();
        syncTimeEl.setCssStyles({ color: "var(--text-muted)" });
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

    const confirmed = await showConfirm(this.app, confirmMessage);
    if (!confirmed) return;

    // Show a loading overlay or update status
    container.empty();
    const deletingEl = container.createDiv();
    deletingEl.setText(`Permanently deleting vault "${vaultId}"... Please wait.`);
    deletingEl.setCssStyles({
      padding: "20px",
      textAlign: "center",
      fontWeight: "bold",
      color: "var(--text-accent)"
    });

    try {
      if (!this.plugin.supabase || !this.plugin.currentUserId) {
        throw new Error("Supabase is not initialized or user is not logged in.");
      }

      // 1. Fetch all binary files for this vault ID to delete from storage
      const { data, error: fetchError } = await this.plugin.supabase
        .from("obsidian_vault_files")
        .select("path")
        .eq("user_id", this.plugin.currentUserId)
        .eq("vault_id", vaultId)
        .eq("is_binary", true);

      if (fetchError) throw fetchError;

      const filesToDelete = data as { path: string }[] | null;
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

    } catch (err) {
      console.error("Failed to delete vault:", err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to delete vault: ${errorMsg}`);
    } finally {
      // Refresh the modal content
      void this.loadVaultsData(container);
    }
  }
}

// --- Vault Setup Modal ---

export class VaultSetupModal extends Modal {
  plugin: SupabaseSyncPlugin;
  private onDoneCallback: (() => void) | null;

  // internal state
  private existingVaultIds: string[] = [];
  private selectedVaultId = "";
  private isCreatingNew = false;
  private newVaultIdValue = "";
  private deviceNameValue = "";
  private isSaving = false;

  constructor(app: App, plugin: SupabaseSyncPlugin, onDone?: () => void) {
    super(app);
    this.plugin = plugin;
    this.onDoneCallback = onDone ?? null;
    this.deviceNameValue = plugin.settings.deviceName;
    this.selectedVaultId = plugin.settings.vaultId ?? "";
  }

  onOpen() {
    this.modalEl.setCssStyles({ width: "500px", maxWidth: "92vw" });
    this.setTitle("Setup Vault Sync");
    this.renderContent();
  }

  private renderContent() {
    const { contentEl } = this;
    contentEl.empty();

    // Loading indicator
    const loadingEl = contentEl.createEl("p", { text: "Loading vault list from database…" });
    loadingEl.setCssStyles({ color: "var(--text-muted)", margin: "1em 0" });

    void this.loadAndRender(loadingEl);
  }

  private async loadAndRender(loadingEl: HTMLElement) {
    try {
      if (!this.plugin.supabase || !this.plugin.currentUserId) {
        throw new Error("Not logged in or Supabase not initialised.");
      }

      // Fetch distinct vault_ids for this user
      const { data, error } = await this.plugin.supabase
        .from("obsidian_vault_files")
        .select("vault_id")
        .eq("user_id", this.plugin.currentUserId);

      if (error) throw error;

      const rows = data as Array<{ vault_id: string }> | null;
      const uniqueIds = new Set<string>();
      if (rows) {
        for (const r of rows) {
          if (r.vault_id) uniqueIds.add(r.vault_id);
        }
      }
      this.existingVaultIds = Array.from(uniqueIds).sort();
    } catch (err) {
      console.warn("VaultSetupModal: failed to fetch vault IDs:", err);
      this.existingVaultIds = [];
    }

    loadingEl.remove();
    this.buildForm();
  }

  private buildForm() {
    const { contentEl } = this;

    // Description
    const descEl = contentEl.createEl("p", {
      text: "Select an existing vault to sync with, or create a new one. Then enter a name for this device."
    });
    descEl.setCssStyles({ color: "var(--text-muted)", marginBottom: "1.2em", fontSize: "0.9em" });

    // ---- Vault ID Dropdown ----
    const CREATE_NEW_VALUE = "__create_new__";

    // Pre-select: if currentVaultId exists in list use it, else "create new"
    const hasExisting = this.existingVaultIds.length > 0;
    if (!this.selectedVaultId || !this.existingVaultIds.includes(this.selectedVaultId)) {
      this.selectedVaultId = hasExisting ? this.existingVaultIds[0] : CREATE_NEW_VALUE;
    }
    this.isCreatingNew = (this.selectedVaultId === CREATE_NEW_VALUE);

    // Containers for the conditional new-vault input and alert — placed BEFORE the dropdown
    // so they render below the dropdown setting row
    const dropdownSetting = contentEl.createDiv();
    const newVaultContainer = contentEl.createDiv();
    const alertContainer = contentEl.createDiv();

    new Setting(dropdownSetting)
      .setName("Vault ID")
      .setDesc("Choose an existing vault or create a new one.")
      .addDropdown((dd) => {
        for (const id of this.existingVaultIds) {
          dd.addOption(id, id);
        }
        dd.addOption(CREATE_NEW_VALUE, "＋ Create new vault");
        dd.setValue(this.selectedVaultId);

        dd.onChange((value) => {
          this.selectedVaultId = value;
          this.isCreatingNew = (value === CREATE_NEW_VALUE);
          alertContainer.empty();
          if (this.isCreatingNew) {
            newVaultContainer.show();
          } else {
            newVaultContainer.hide();
          }
        });
      });

    // ---- New Vault ID Input (conditional) ----
    newVaultContainer.setCssStyles({ marginTop: "0.75em", marginBottom: "0.5em" });
    if (!this.isCreatingNew) newVaultContainer.hide();

    let newVaultInput: HTMLInputElement | null = null;

    new Setting(newVaultContainer)
      .setName("New Vault ID")
      .setDesc("Max 10 characters: letters, numbers, hyphens, underscores.")
      .addText((text) => {
        newVaultInput = text.inputEl;
        text.inputEl.maxLength = 10;
        text.setPlaceholder("my-vault");
        text.setValue(this.newVaultIdValue);
        text.inputEl.addEventListener("input", () => {
          const cleaned = text.inputEl.value.replace(/[^a-zA-Z0-9\-_]/g, "").substring(0, 10);
          text.inputEl.value = cleaned;
          this.newVaultIdValue = cleaned;
          alertContainer.empty();
        });
      });

    // Alert container (shown when validation fails)
    alertContainer.setCssStyles({ marginBottom: "0.5em" });

    // ---- Device Name Input ----
    new Setting(contentEl)
      .setName("Device Name")
      .setDesc("A friendly name to identify this device in sync history.")
      .addText((text) => {
        text.setPlaceholder("e.g. My Laptop");
        text.setValue(this.deviceNameValue);
        text.onChange((value) => {
          this.deviceNameValue = value.trim();
        });
      });

    // ---- Action Buttons ----
    const buttonRow = contentEl.createDiv();
    buttonRow.setCssStyles({
      display: "flex",
      justifyContent: "flex-end",
      gap: "10px",
      marginTop: "1.5em"
    });

    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = buttonRow.createEl("button", { text: "Save & Start Sync" });
    saveBtn.addClass("mod-cta");

    saveBtn.addEventListener("click", async () => {
      if (this.isSaving) return;

      alertContainer.empty();

      // Resolve the final vault ID
      let finalVaultId: string;
      if (this.isCreatingNew) {
        finalVaultId = (newVaultInput?.value ?? this.newVaultIdValue).trim();
        if (!finalVaultId) {
          this.showAlert(alertContainer, "Please enter a vault ID.");
          return;
        }

        // Check if new vault ID already exists in DB
        try {
          if (this.plugin.supabase && this.plugin.currentUserId) {
            const { data: existing, error: checkError } = await this.plugin.supabase
              .from("obsidian_vault_files")
              .select("vault_id")
              .eq("user_id", this.plugin.currentUserId)
              .eq("vault_id", finalVaultId)
              .limit(1);

            if (checkError) throw checkError;

            if (existing && existing.length > 0) {
              this.showAlert(
                alertContainer,
                `Vault ID "${finalVaultId}" already exists in the database. Choose a different name or select it from the dropdown above.`
              );
              return;
            }
          }
        } catch (err) {
          console.error("VaultSetupModal: DB check error:", err);
          const msg = err instanceof Error ? err.message : String(err);
          this.showAlert(alertContainer, `Failed to check vault ID: ${msg}`);
          return;
        }
      } else {
        finalVaultId = this.selectedVaultId;
        if (!finalVaultId) {
          this.showAlert(alertContainer, "Please select a vault ID.");
          return;
        }
      }

      if (!this.deviceNameValue) {
        this.showAlert(alertContainer, "Please enter a device name.");
        return;
      }

      // --- Save ---
      this.isSaving = true;
      saveBtn.setText("Saving…");
      saveBtn.setAttr("disabled", "true");
      cancelBtn.setAttr("disabled", "true");

      try {
        // Save device name first
        this.plugin.settings.deviceName = this.deviceNameValue;

        // Update vault ID (handles migration/confirmation internally)
        const success = await this.plugin.updateVaultId(finalVaultId, !this.isCreatingNew);
        if (!success) {
          // User cancelled the confirm dialog inside updateVaultId
          return;
        }

        await this.plugin.saveSettings();
        await this.plugin.registerDevice();

        new Notice("Vault setup complete! Starting sync…");
        this.close();

        // Trigger sync after modal close
        window.setTimeout(() => {
          void this.plugin.runSync();
        }, 300);
      } catch (err) {
        console.error("VaultSetupModal: save error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        this.showAlert(alertContainer, `Error: ${msg}`);
      } finally {
        this.isSaving = false;
        saveBtn.setText("Save & Start Sync");
        saveBtn.removeAttribute("disabled");
        cancelBtn.removeAttribute("disabled");
      }
    });
  }

  private showAlert(container: HTMLElement, message: string) {
    container.empty();
    const alertEl = container.createEl("p", { text: message });
    alertEl.setCssStyles({
      color: "var(--text-error)",
      backgroundColor: "var(--background-modifier-error)",
      borderRadius: "4px",
      padding: "8px 12px",
      fontSize: "0.88em",
      margin: "0 0 0.5em 0"
    });
  }

  onClose() {
    this.contentEl.empty();
    if (this.onDoneCallback) {
      this.onDoneCallback();
    }
  }
}
