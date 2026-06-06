# Supabase Vault Sync for Obsidian

An offline-first, high-performance Obsidian plugin that bidirectionally synchronizes your vault notes to a Supabase Postgres database (with frontmatter metadata) and binary attachments to Supabase Storage.

> [!NOTE]
> This is an unofficial way to sync Obsidian vaults. [Obsidian Sync](https://obsidian.md/sync) is the officially supported option.

> [!WARNING]
> **Backup Your Vault First!**
> Please make a complete backup of your local Obsidian vault before installing or configuring this plugin. Since this plugin performs bidirectional synchronization and direct file system writes/deletions, having a fresh backup ensures your notes are completely safe during initial setup and testing.

---

## Features

- **Offline-First Architecture**: Changes are tracked locally in a robust sync queue and synchronized metadata registry. If you are offline, all changes queue up safely and sync automatically once you re-establish a connection.
- **Secure Authentication**: Users authenticate securely with Email & Password. Sessions are managed and persistent across Obsidian restarts.
- **Strict Row Level Security (RLS)**: Database tables utilize strict Postgres RLS policies (`auth.uid() = user_id`) to ensure no user can ever access another user's vault data.
- **Private Storage Bucket & Folder Isolation**: Attachment assets are stored in a private bucket using the path `{user_id}/{vault_id}/{file_path}` with strict owner policies.
- **Namespace Vault ID Isolation**: Sync multiple vaults with ease using alphanumeric Vault IDs (max 10 characters). Changing Vault ID automatically triggers a remote database migration of your vault data.
- **Device Tracking & Hostname Auto-Detection**: Connected devices (Desktop/Mobile/Tablet) are registered to the database, automatically reading your computer's OS hostname on desktop.
- **Rich Postgres & Bidirectional Sync**: Notes are structured as Postgres records, and pulls are automatically executed since your last sync.
- **Debounced Settings Input**: 1-second debounce on critical inputs like Vault ID and Device Name prevents heavy database overhead while typing.
- **Customizable Retention & Server Maintenance**: Automatic and manual purging of old soft-deleted files from Postgres and Storage.
- **Database Vaults Management**: View all vaults in your Supabase database, track connected sync devices, display file and note counts, and permanently delete inactive vaults.

---

## Synchronization Strategy

This plugin operates on strict offline-first, data-safety guarantees to ensure that your local notes and remote data are safely merged without any data loss.

Please refer to the dedicated **[Sync Strategy Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SYNC_STRATEGY.md)** for:
- Detailed data-safety guarantees
- Decision flowcharts and resolution rules
- Scenario matrix for conflict resolution, deletions, and merges

---

## Supabase Database & Storage Setup

> **New to Supabase?** Read the beginner-friendly **[Supabase Setup Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SUPABASE_SETUP.md)** for step-by-step instructions.

Before using the plugin, you must configure your Supabase instance. Run the content of [schema.sql](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/schema.sql) in the Supabase SQL Editor. This script:
- Creates the `obsidian_vault_files` table with all metadata columns and a composite primary key `(user_id, vault_id, path)`.
- Enables Row Level Security (RLS) on `obsidian_vault_files` to allow authenticated users to perform operations only on their own rows (`auth.uid() = user_id`).
- Creates the `obsidian_sync_devices` table to track connected devices (enforcing RLS for owner access only).
- Optimizes querying with a GIN index on the `properties` column of `obsidian_vault_files`.
- Registers a private storage bucket called `obsidian-vault-binaries` for media attachments.
- Configures strict storage bucket access control policies (`SELECT`, `INSERT`, `DELETE`) limiting operations to the folder prefix corresponding to the user's ID (`auth.uid()::text`).

---

## Installation in Obsidian

> [!NOTE]
> This plugin is currently undergoing review for the official Obsidian Community Plugins store. Until it is officially approved and listed, please use one of the installation methods below.

To install and enable this plugin in your Obsidian vault, choose one of the following methods:

### Option A: Install via BRAT (Recommended for Beta Users)
Using the [Obsidian42 - BRAT](https://github.com/tfthacker/obsidian42-brat) plugin is the easiest way to install and receive updates automatically:
1. Install **Obsidian42 - BRAT** from the Community Plugins directory in Obsidian.
2. Enable the BRAT plugin.
3. Open BRAT settings: **Settings** -> **BRAT**.
4. Click **Add Beta plugin** under *Beta Plugin List*.
5. Enter the repository URL: `https://github.com/dsnbyte/obsidian-supabase-sync`.
6. Click **Add Plugin**. BRAT will download and install the latest release files automatically.
7. Go to **Community Plugins** and toggle **Supabase Vault Sync** to **On**.

### Option B: Manual Installation
1. Download the latest release from the [Releases page](https://github.com/dsnbyte/obsidian-supabase-sync/releases).
2. Under your vault's plugin directory, create a new folder:
   ```
   <your-vault-path>/.obsidian/plugins/obsidian-supabase-sync/
   ```
3. Copy the following files into that folder:
   - `main.js`
   - `manifest.json`
4. Reload plugins or restart Obsidian.

### Enabling the Plugin
1. Open Obsidian and go to **Settings** -> **Community plugins**.
2. If **Community plugins** are not enabled, enable them.
3. Locate **Supabase Vault Sync** in the list of installed plugins.
4. Toggle the switch to **On**.

---

## How to Use

### 1. Configuration
1. Open Obsidian **Settings** -> **Supabase Vault Sync**.
2. **Supabase Connection**: Enter your **Supabase Project URL** (e.g., `https://your-project-id.supabase.co`) and your **Supabase API Key** (typically your `anon` public key). Click **Test Connection** to verify database and storage access.
3. **Authentication**: Enter your account **Email** and **Password** (created via your Supabase Dashboard -> Authentication) and click **Log In**.
4. **Vault & Device Configuration**:
   - **Vault ID**: Enter a unique namespace ID for this vault (alphanumeric/dashes/underscores up to 10 characters). Changing the Vault ID dynamically triggers a remote database migration of all your data. Note: critical inputs are debounced by 1 second to prevent overhead while typing.
   - **Device Name**: Give this device a custom name to identify it in database sync history, or let it auto-detect your OS hostname.
5. (Optional) Configure **Auto-Sync Options**:
   - **Auto-Sync on Changes**: Turn this toggle **On** to enable automatic background synchronization when edits occur.
   - **Auto-Sync Delay (seconds)**: Customize this slider to change how long the plugin debounces sync operations after you stop typing (default is `2` seconds).
   - **Auto-Sync Interval (seconds)**: Set a slider value from `0` to `60` seconds to trigger automatic syncs periodically. Set to `0` to disable interval syncs. Note that interval syncs only execute when the Obsidian app is actively in the foreground to conserve battery life, particularly on mobile.

### 2. Manual and Full Syncs
- **Sync Control Settings**: Under Settings -> **Supabase Vault Sync** -> **Sync Control**:
  - **Sync Now**: Triggers an instant full bidirectional sync cycle.
  - **Reset Sync State**: Clears local sync metadata and the pending event queue. The next sync will perform a full re-scan and safely merge all local and remote files by hash. No files are deleted.
- **Ribbon Button**: Click the circular arrows icon (**Sync Obsidian to Supabase**) on the left sidebar to manually trigger a bidirectional sync.
- **Command Palette**: Press `Ctrl+P` (or `Cmd+P` on macOS) and select:
  - `Supabase Vault Sync: Sync Vault with Supabase Now` — triggers standard sync.
  - `Supabase Vault Sync: Reset Sync Metadata (Re-sync all files)` — clears local sync cache so the next sync scans and updates all vault items.

### 3. Server Maintenance
To maintain remote deleted files retention policies:
1. Go to settings -> **Supabase Vault Sync** -> **Server Maintenance**.
2. **Automatic Cleanup Age (Days)**: Select the number of days after which soft-deleted files are automatically purged from database and storage during sync cycles.
3. **Manual Cleanup**: Select a manual duration threshold (e.g., `7 Days` or `"All Soft-Deleted Files"` to select everything) and click **Clean Up Now** to permanently purge matched soft-deleted records and storage binaries from Supabase.

### 4. Database Backup & Export
You can easily back up your synchronized files in the Supabase database by exporting them to a local SQL file:
1. Navigate to **Settings** -> **Supabase Vault Sync** -> **Backup & Export**.
2. Customize the **Include Deleted Files** option:
   - Toggle **On** to include all soft-deleted files (where the `deleted_at` timestamp exists) in your backup.
   - Toggle **Off** to only export currently active, non-deleted files.
3. Click **Export Database**.
4. The plugin will query Supabase for all records matching the current user and vault ID and download a compiled `.sql` file named `<vault_id>-backup-<timestamp>.sql` containing full `INSERT ... ON CONFLICT DO UPDATE` statements. This file can be run directly in your Supabase SQL Editor to restore or seed your vault data.

---

## License

[MIT](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/LICENSE)
