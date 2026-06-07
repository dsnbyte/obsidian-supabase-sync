# Changelog

All notable changes to this project will be documented in this file.

## [1.1.1] - 2026-06-07

### Bug Fixes

* Resolve obsidian community plugin review issues (d4c6b72)


## [1.1.0] - 2026-06-07

### Features

* Implement device name validation and improve logout confirmation in settings (0d679f5)
* Enhance vault ID management and add vault setup modal for improved user experience (ae0a011)

### Bug Fixes

* Enhance vault ID migration logic to prevent sync issues with other devices (80a8b63)


## [1.0.8] - 2026-06-07

* No significant changes in this release.

## [1.0.7] - 2026-06-07

### Bug Fixes

* Update minAppVersion to 1.6.6 (77efd70)


## [1.0.6] - 2026-06-07

### Bug Fixes

* Update minAppVersion to 1.1.0 (3cc4ed6)


## [1.0.5] - 2026-06-07

### Bug Fixes

* Resolve uses obsidian api newer than minAppVersion (0dab037)


## [1.0.4] - 2026-06-07

### Bug Fixes

* Another obsidian community plugin warnings (88997dc)


## [1.0.3] - 2026-06-07

### Bug Fixes

* **ci**: Predicate-type must be provided (a204988)
* Resolve another obsidian community plugin review issues (afb7a47)


## [1.0.2] - 2026-06-07

### Bug Fixes

* Resolve obsidian community plugin review issues (6bb99c8)


## [1.0.1] - 2026-06-07

### Features

* Remove unnecessary fields and add dedicated tags field (cdce44f)

### Bug Fixes

* Update hostname retrieval (c7b9ae4)
* Lint and change obsidian setting headers (0496d6b)
* Remove unnecessary db fields (b0aa650)

### Other Changes

* fixed some warnings (81a70f1)


## [1.0.0] - 2026-06-06

### Features

- Offline-first architecture with local sync queue and metadata registry
- Bidirectional sync of Markdown notes and binary attachments to Supabase
- Secure email/password authentication with persistent sessions
- Row Level Security (RLS) on all database tables (`auth.uid() = user_id`)
- Private storage bucket with per-user folder isolation (`{user_id}/{vault_id}/{path}`)
- Multi-vault support via alphanumeric Vault IDs (max 10 characters)
- Vault ID migration: renaming a Vault ID updates all remote records automatically
- Device tracking with OS hostname auto-detection on desktop
- Auto-sync on file changes with configurable debounce delay
- Configurable interval-based auto-sync (skips when app is in background)
- Configurable soft-delete TTL with automatic and manual cleanup
- Database vault management modal (view, track devices, delete remote vaults)
- SQL database export (INSERT … ON CONFLICT DO UPDATE) for backup/restore
- Ribbon icon and Command Palette commands for manual sync and metadata reset
- Status bar indicator reflecting current sync state

### Bug Fixes

* Update plugin ID to follow Obsidian manifest guidelines (b98d072)

