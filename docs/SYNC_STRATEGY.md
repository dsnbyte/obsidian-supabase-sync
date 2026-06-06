# Sync Strategy

This document explains how **Supabase Vault Sync** decides what to do when synchronizing your local Obsidian vault with Supabase. Understanding these rules will help you predict plugin behavior in edge cases and avoid surprises.

---

## Core Principles

The plugin is built around five data-safety guarantees:

| # | Principle | Description |
|---|-----------|-------------|
| 1 | **Never delete without evidence of intent** | A file is only deleted from one side if there is a recorded delete event proving the user intentionally removed it. A missing file is treated as "needs restore", not "needs deletion". |
| 2 | **Always verify physical existence** | Local metadata saying a file is "in sync" does not mean the file is actually on disk. Before skipping a pull, the plugin checks that the file physically exists. |
| 3 | **First sync is additive-only** | When connecting to a Supabase project for the first time (or after a Reset Sync), nothing is deleted from either side. Files are only added or merged. |
| 4 | **Soft-delete with TTL** | Deletions are recorded as `deleted_at` timestamps in Supabase so other devices learn about them. After 30 days, the record is permanently removed automatically (hard-delete). |
| 5 | **Conflict = keep both** | If a file has been changed on both sides since the last sync, the local version is renamed to `filename (Sync Conflict).ext` and the remote version is downloaded — no data is ever silently overwritten. |

---

## Sync Cycle Overview

Every sync run executes four steps in order:

```
1. Pull Remote Changes   — download new/updated/deleted files from Supabase
2. Scan Local Vault      — detect untracked or locally-modified files
3. Process Queue         — upload queued local changes to Supabase
4. Auto TTL Cleanup      — hard-delete soft-deleted files older than 30 days
```

Steps 2 and 3 implement the **offline-first** model: local changes are always queued on disk first, and survive app restarts before being pushed upstream.

---

## Decision Flowchart — Pull Step

### For each file that exists on remote:

```
Is deleted_at set?
├─ Yes → Does the file exist locally?
│        ├─ Yes → Was it modified locally? → Yes  → KEEP local (user's edits win)
│        │                                → No   → DELETE local (move to trash)
│        └─ No  → SKIP (nothing to do)
│
└─ No (file is active) ↓

Is the file tracked in local metadata?
├─ No  → DOWNLOAD (new file from remote)
│
└─ Yes → Does the hash match?
         ├─ Yes → Does the file physically exist on disk?
         │        ├─ Yes → SKIP (already in sync) ✓
         │        └─ No  → DOWNLOAD again (file missing from disk) ← Fix A
         │
         └─ No  → Was remote updated after last sync?
                  ├─ Yes → Was local file modified too?
                  │        ├─ Yes → CONFLICT (rename local, download remote)
                  │        └─ No  → DOWNLOAD (remote update wins)
                  └─ No  → SKIP (local is newer, will be uploaded in step 3)
```

### For each file tracked locally but absent from remote:

```
Is there a delete event in the local queue for this file?
├─ Yes → REMOVE from local metadata only
│        (queue will propagate the soft-delete to Supabase in step 3)
│
└─ No  → DO NOT delete local file ← Fix E
          REMOVE from metadata only so the next scan re-uploads it
          (the file disappeared from remote without user intent — treat as restore)
```

---

## Scenario Matrix

### Legend

| Symbol | Meaning |
|--------|---------|
| 🟢 | Safe — no risk of data loss |
| 🟡 | Requires attention |
| ⬆️ | Upload to Supabase |
| ⬇️ | Download to local |
| 🔀 | Conflict resolution |
| 🗑️ | Delete (soft or hard) |
| ➖ | No action |
| **FS** | First Sync — never synced to this project before |
| **RS** | Re-Sync — has synced to this project previously |

---

### 1. Upload Scenarios (Local → Supabase)

| # | Supabase | Local | Status | Action | Safety |
|---|----------|-------|--------|--------|--------|
| 1.1 | Empty | 3 notes | FS | ⬆️ Upload all | 🟢 |
| 1.2 | Empty | 3 notes | RS (remote wiped) | ⬆️ Re-upload all (metadata auto-reset) | 🟢 |
| 1.3 | Empty | Empty | FS | ➖ Nothing to do | 🟢 |
| 1.4 | Empty | Empty | RS | ➖ Nothing to do | 🟢 |

> **Remote wiped detection (1.2):** If the remote returns zero files but local metadata still tracks files with the same project URL, the plugin assumes the database was wiped externally. It resets local metadata and re-uploads everything — your local files are never deleted.

---

### 2. Download Scenarios (Supabase → Local)

| # | Supabase | Local | Status | Action | Safety |
|---|----------|-------|--------|--------|--------|
| 2.1 | 3 notes | Empty | FS | ⬇️ Download all | 🟢 |
| 2.2 | 3 notes | Empty | RS | See sub-scenarios below | 🟡 |
| 2.3 | 3 notes (some soft-deleted) | Empty | FS | ⬇️ Download active files only | 🟢 |

**Sub-scenarios for 2.2** — remote has files, local vault is empty, previously synced:

| Condition | Action |
|-----------|--------|
| Delete events exist in the queue | 🗑️ Propagate soft-delete to Supabase for those files |
| No delete events (files disappeared silently) | ⬇️ Restore from Supabase |

---

### 3. Merge Scenarios (Files on Both Sides)

| # | Supabase | Local | Status | Action | Safety |
|---|----------|-------|--------|--------|--------|
| 3.1 | A, B, C | B, C, D | FS | ⬇️ A · 🔀 B & C (hash check) · ⬆️ D | 🟢 |
| 3.2 | A, B, C | B, C, D | RS | See sub-scenarios below | 🟡 |
| 3.3 | A, B, C | A, B, C (identical) | FS | ➖ Hash match → skip all | 🟢 |
| 3.4 | A, B, C | A, B, C (identical) | RS | ➖ Skip all | 🟢 |
| 3.5 | A, B, C | A′, B, C (A modified locally) | RS | ⬆️ Upload A′ | 🟢 |
| 3.6 | A′, B, C (A modified remotely) | A, B, C | RS | ⬇️ Download A′ | 🟢 |
| 3.7 | A″ (remote edit) | A′ (local edit) | RS | 🔀 Save A″ locally + rename A′ as conflict copy | 🟢 |

**Sub-scenarios for 3.2** — remote has A, B, C; local has B, C, D; previously synced:

| File | Condition | Action |
|------|-----------|--------|
| **A** | In Supabase & metadata, missing locally | Check queue: delete event? → soft-delete A in Supabase. No event? → ⬇️ re-download A |
| **B, C** | Present on both sides | Compare hashes. Same → skip. Different → 🔀 conflict resolution |
| **D** | Local only, not in Supabase or metadata | ⬆️ Upload D (new file) |

---

### 4. Deletion Scenarios

| # | Who Deleted | Condition | Action | Safety |
|---|------------|-----------|--------|--------|
| 4.1 | User deletes file locally | File exists in Supabase | 🗑️ Soft-delete in Supabase (`deleted_at` = now) | 🟢 |
| 4.2 | User deletes on another device | File exists locally, `deleted_at` set on remote | 🗑️ Delete local file (respects vault trash setting) | 🟢 |
| 4.3 | File disappears locally (no delete event) | File exists in Supabase | ⬇️ **Restore** — re-download, never delete from Supabase | 🟢 |
| 4.4 | Database wiped externally | Files exist locally | ⬆️ Re-upload everything (metadata auto-reset) | 🟢 |
| 4.5 | User deletes all local files | Files exist in Supabase | Check queue: events found → soft-delete · No events → ⬇️ restore | 🟡 |

---

### 5. Reset Sync Scenarios

Reset Sync clears local metadata and the pending queue. The next sync behaves like a first sync (additive-only), but since `lastSyncedUrl` is preserved, it does **not** trigger the "first connection" notice.

| # | State Before Reset | After Reset + Sync | Safety |
|---|--------------------|--------------------|--------|
| 5.1 | Local = Supabase (identical) | ➖ Hash check passes for all files → skip | 🟢 |
| 5.2 | Local has files not in Supabase | ⬆️ Upload missing files | 🟢 |
| 5.3 | Supabase has files not in local | ⬇️ Download missing files | 🟢 |
| 5.4 | Content differs on both sides | 🔀 Conflict resolution for differing files | �� |
| 5.5 | Supabase has soft-deleted files | ⬇️ Download active files only · soft-deleted ignored | 🟢 |

---

## Soft-Delete & Auto-Cleanup (TTL)

When a file is deleted locally, the plugin does a **soft-delete** in Supabase by setting `deleted_at` to the current timestamp. This allows other synced devices to learn about the deletion on their next pull.

After **30 days**, the plugin automatically **hard-deletes** these records during the sync cycle — removing both the database row and any associated binary in Storage. This keeps the database clean without requiring manual intervention.

You can also trigger a manual cleanup at any time via **Settings → Server Maintenance → Clean Up Now**, with a configurable threshold (1, 7, 30, or 90 days).

---

## Conflict Resolution

A conflict occurs when the **same file has been modified on both local and remote** since the last sync.

**Resolution steps:**
1. The local file is renamed to `filename (Sync Conflict).ext` in the same folder.
2. The remote version is downloaded and saved as the canonical `filename.ext`.
3. Both versions are preserved — you can diff and merge them manually.
4. The conflict copy is queued for upload on the next sync cycle.

---

## What the Plugin Will Never Do

- ❌ Delete a local file that has no corresponding delete event in the queue
- ❌ Delete any file during a first sync or Reset Sync
- ❌ Silently overwrite a file that was modified on both sides
- ❌ Skip downloading a file that is missing from disk (even if metadata says it's synced)
- ❌ Run sync operations when Obsidian is in the background (interval syncs are paused to save battery)

---

## Security, Authentication, & Vault Isolation

The plugin uses robust security practices to isolate data between different users and devices:

### 1. User Authentication
A public anonymous key is no longer enough to sync. Users must log in using their email and password. The session is managed securely by the Supabase client and persisted across Obsidian restarts.

### 2. Row Level Security (RLS)
The database enforces strict RLS policies on `obsidian_vault_files`:
- `auth.uid() = user_id` ensures that a user can only select, insert, update, or delete their own files.
- Even if a public anon API key is compromised, attackers cannot view or modify any other user's files without their active user login token.

### 3. Vault ID Isolation
Vault data is partitioned by `vault_id` (alphanumeric/dashes/underscores up to 10 characters). 
- Changing the Vault ID in settings triggers a remote database migration of all files matching that user and old Vault ID to the new one.
- Any other device syncing with the old Vault ID will see a cleared database (since the remote has been migrated) and trigger a full upload of its local files, maintaining consistency.

### 4. Storage Bucket Access Control
- All binary files are uploaded to the `obsidian-vault-binaries` storage bucket under the path `{user_id}/{vault_id}/{file_path}`.
- Strict storage policies ensure that authenticated users can only access paths that start with their own `auth.uid()::text`.

### 5. Device Tracking
Connected devices are tracked in the `obsidian_sync_devices` database table:
- Stores device name, platform (Desktop/Mobile/Tablet), and `last_sync_at` timestamp.
- User can custom name their device in settings to identify it in database history.
