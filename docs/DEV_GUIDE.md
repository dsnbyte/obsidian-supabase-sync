# Developer Guide — Supabase Vault Sync

This guide is for contributors and developers who want to build, modify, or test the plugin locally.

---

## Prerequisites

- **Node.js** v18 or higher
- **npm**
- A **Supabase Account** (free tier works)

---

## Local Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/dsnbyte/obsidian-supabase-sync.git
cd obsidian-supabase-sync
npm install
```

---

## Build Scripts

The plugin uses [`esbuild`](https://esbuild.github.io/) for fast bundling:

```bash
# Development mode — watches for file changes and rebuilds automatically
npm run dev

# Production build — creates an optimized, minified bundle
npm run build
```

The output is a single `main.js` file in the project root.

---

## Installing Locally in Obsidian

The fastest way to test changes is to place (or symlink) the repository directly inside your vault's plugins folder:

1. Copy or clone this repository into your Obsidian vault's plugin directory:
   ```
   <your-vault-path>/.obsidian/plugins/obsidian-supabase-sync/
   ```
2. Inside that directory, install dependencies and build:
   ```bash
   npm install
   npm run build
   ```
3. In Obsidian, go to **Settings → Community plugins** and reload/enable the plugin.

Only `main.js` and `manifest.json` are required at runtime — the rest of the source files are only needed for building.

---

## Database Setup

Before testing sync functionality, you need to configure a Supabase project:

1. Create a Supabase project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** in your Supabase dashboard.
3. Run the contents of [`schema.sql`](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/schema.sql) to create all required tables, RLS policies, indexes, and the storage bucket.

For a detailed walkthrough, see [`docs/SUPABASE_SETUP.md`](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SUPABASE_SETUP.md).

---

## Architecture & Sync Strategy

The sync engine is implemented entirely in [`src/main.ts`](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/src/main.ts).

For a deep dive into the offline-first approach, conflict resolution rules, and decision flowcharts, see [`docs/SYNC_STRATEGY.md`](https://github.com/dsnbyte/obsidian-supabase-sync/blob/main/docs/SYNC_STRATEGY.md).

---

## Project Structure

```
obsidian-supabase-sync/
├── src/
│   └── main.ts          # Full plugin source (single-file)
├── docs/
│   ├── SUPABASE_SETUP.md
│   └── SYNC_STRATEGY.md
├── schema.sql            # Supabase SQL setup script
├── esbuild.config.mjs    # Build configuration
├── manifest.json         # Obsidian plugin manifest
├── package.json
└── main.js               # Compiled output (do not edit directly)
```
