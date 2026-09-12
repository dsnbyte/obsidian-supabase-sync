-- Allow file metadata larger than PostgreSQL integer's 2,147,483,647-byte limit.
-- Existing integer values are preserved by this widening conversion.
ALTER TABLE IF EXISTS public.obsidian_vault_files
    ALTER COLUMN size TYPE bigint
    USING size::bigint;
