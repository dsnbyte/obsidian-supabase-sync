# Supabase Vault Sync for Obsidian

An offline-first, high-performance Obsidian plugin that bidirectionally synchronizes vault notes to a Supabase PostgreSQL database (including frontmatter metadata) and binary attachments to Supabase Storage.

> [!WARNING]
> Back up your local Obsidian vault before installing or configuring this plugin. Although this plugin includes safeguards to prevent accidental file deletion, a fresh backup is highly recommended during initial setup and testing.

**Note:** This is an unofficial sync solution. [Obsidian Sync](https://obsidian.md/sync) is the officially supported service.


## Features

- **Offline-First Architecture**: Changes are tracked locally in a robust sync queue and synchronized metadata registry. If you are offline, all changes queue up safely and sync automatically once you re-establish a connection.
- **Secure Authentication**: Users authenticate securely with Email & Password. Sessions are managed and persistent across Obsidian restarts.
- **Strict Row Level Security (RLS)**: Database tables utilize strict Postgres RLS policies to ensure no user can ever access another user's vault data.
- **Private Storage Bucket & Folder Isolation**: Attachment assets are stored in a private bucket with strict owner policies.
- **Namespace Vault ID Isolation**: Enables seamless synchronization across multiple independent vaults.
- **Device Tracking**: Connected devices (Desktop/Mobile/Tablet) are registered to the database.
- **Rich Postgres & Bidirectional Sync**: Notes are structured as Postgres records, and pulls are automatically executed since your last sync.
- **Database Vaults Management**: View all vaults in your Supabase database, track connected sync devices, display file and note counts, and permanently delete inactive vaults.


## How It Works

This plugin uses an offline-first, event-driven architecture to keep your notes and attachments in sync:

1. **Local Event Queue**: As you create, edit, or delete files, the plugin tracks these changes locally. If you are offline, these events are queued safely.
2. **Metadata Cache**: The plugin maintains a local registry of file paths, last-modified timestamps, and SHA-256 hashes. This allows it to instantly identify changes and avoid redundant uploads or downloads.
3. **Dual-Channel Sync**:
   - **Markdown Notes**: Synchronized directly with PostgreSQL database rows. Frontmatter properties are parsed into a queryable JSONB column, while tags and titles are indexed in dedicated fields.
   - **Binary Attachments**: Uploaded to/deleted from a private Supabase Storage bucket, organized securely under your Supabase User ID.
4. **Conflict Resolution**: When files are edited on multiple devices, conflicts are resolved using robust, safety-first rules (e.g., comparing hashes and timestamps) to prevent data loss. For details, see the **[Sync Strategy Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SYNC_STRATEGY.md)**.
5. **Security First**: Everything is protected by strict **Row Level Security (RLS)** policies. Your vault data can only be read or written by your authenticated user session.
6. **100% Privacy & Zero Telemetry**: The sync engine runs entirely on your local client device, and all data is transmitted directly to your own self-hosted or managed Supabase project. No analytics, tracking, or telemetry data is ever collected or shared.


## Quick Start

1. Create a project in [Supabase](https://supabase.com/).
2. Open the **SQL Editor** in your Supabase Dashboard and run the contents of [schema.sql](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/schema.sql) to initialize the database tables, performance indexes, and storage bucket.
3. Enable Email/Password authentication in your Supabase project under **Authentication** -> **Providers**.
4. Get Supabase Project URL and API Key from your Supabase Dashboard.
4. Install the plugin in your Obsidian vault.
5. Configure the plugin in Obsidian Settings.
6. Perform an initial sync.

For a detailed step-by-step setup guide, see the **[Supabase Setup Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SUPABASE_SETUP.md)**.


## Usage

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


## Documentation

For more in-depth information, check out the following guides:
- **[Supabase Setup Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SUPABASE_SETUP.md)**: Detailed instructions on configuring tables, indexes, and storage.
- **[Sync Strategy Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SYNC_STRATEGY.md)**: Details on the offline-first sync mechanism, safety guarantees, and conflict resolution rules.
- **[Development Guide](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/DEV_GUIDE.md)**: Information on setting up the project locally, and building.


## License

MIT. See [LICENSE](LICENSE).
