-- Schema Migration for Obsidian Supabase Sync Plugin
-- Targets the Supabase Postgres Database

-- Create the obsidian_vault_files table to store markdown and metadata
CREATE TABLE IF NOT EXISTS obsidian_vault_files (
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    vault_id text NOT NULL,
    path text NOT NULL,
    content text,
    is_binary boolean DEFAULT false,
    mime_type text,
    size integer,
    hash text,
    properties jsonb DEFAULT '{}'::jsonb,
    
    -- Dedicated columns for standard frontmatter attributes
    title text,
    tags text[] DEFAULT '{}'::text[],
    
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    deleted_at timestamptz,
    
    PRIMARY KEY (user_id, vault_id, path)
);

-- Enable Row Level Security (RLS)
ALTER TABLE obsidian_vault_files ENABLE ROW LEVEL SECURITY;

-- Drop old policies if they exist
DROP POLICY IF EXISTS "Enable all access for anon" ON obsidian_vault_files;
DROP POLICY IF EXISTS "Enable all access for owners" ON obsidian_vault_files;

-- Create policy to allow all access for authenticated users to their own files
CREATE POLICY "Enable all access for owners" ON obsidian_vault_files
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Create the obsidian_sync_devices table to track connected devices
CREATE TABLE IF NOT EXISTS obsidian_sync_devices (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    vault_id text NOT NULL,
    device_name text NOT NULL,
    platform text,
    last_sync_at timestamptz,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (user_id, vault_id, device_name)
);

-- Enable RLS for obsidian_sync_devices
ALTER TABLE obsidian_sync_devices ENABLE ROW LEVEL SECURITY;

-- Drop old policies if they exist
DROP POLICY IF EXISTS "Users can manage their own devices" ON obsidian_sync_devices;

-- Create policy to allow all access for authenticated users to their own devices
CREATE POLICY "Users can manage their own devices" ON obsidian_sync_devices
    FOR ALL
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Create performance and querying indexes
CREATE INDEX IF NOT EXISTS idx_obsidian_vault_files_properties ON obsidian_vault_files USING gin (properties);
CREATE INDEX IF NOT EXISTS idx_obsidian_vault_files_is_binary ON obsidian_vault_files (is_binary);

-- Register storage bucket for binaries (public = false for auth-based access control)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('obsidian-vault-binaries', 'obsidian-vault-binaries', false, null, null)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for obsidian-vault-binaries bucket
DROP POLICY IF EXISTS "Enable read access for all" ON storage.objects;
DROP POLICY IF EXISTS "Enable write access for all" ON storage.objects;
DROP POLICY IF EXISTS "Enable delete access for all" ON storage.objects;
DROP POLICY IF EXISTS "Enable select for owners" ON storage.objects;
DROP POLICY IF EXISTS "Enable insert for owners" ON storage.objects;
DROP POLICY IF EXISTS "Enable update for owners" ON storage.objects;
DROP POLICY IF EXISTS "Enable delete for owners" ON storage.objects;

-- Create policies for storage objects: path format must start with user's ID
CREATE POLICY "Enable select for owners" ON storage.objects
    FOR SELECT
    TO authenticated
    USING (bucket_id = 'obsidian-vault-binaries' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Enable insert for owners" ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'obsidian-vault-binaries' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Enable update for owners" ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (bucket_id = 'obsidian-vault-binaries' AND auth.uid()::text = (storage.foldername(name))[1])
    WITH CHECK (bucket_id = 'obsidian-vault-binaries' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Enable delete for owners" ON storage.objects
    FOR DELETE
    TO authenticated
    USING (bucket_id = 'obsidian-vault-binaries' AND auth.uid()::text = (storage.foldername(name))[1]);
