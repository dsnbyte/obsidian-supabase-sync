# Changelog

All notable changes to this project will be documented in this file.

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

