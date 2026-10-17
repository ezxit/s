-- ============================================================
-- Supabase migration for shortlink
-- Run in Supabase SQL Editor (https://app.supabase.com)
-- Safe to run again for existing projects.
-- Content is public: anyone with the project API key can read and edit it.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.shortlinks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT DEFAULT '',
  images JSONB DEFAULT '[]'::jsonb,
  files JSONB DEFAULT '[]'::jsonb,   -- [{name, size, url, type, key}]
  description TEXT DEFAULT '',
  namespace TEXT DEFAULT 'default',
  created TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.shortlinks
  ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE public.shortlinks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shortlinks TO anon;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_read') THEN
    CREATE POLICY "public_read" ON public.shortlinks FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_insert') THEN
    CREATE POLICY "public_insert" ON public.shortlinks FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_update') THEN
    CREATE POLICY "public_update" ON public.shortlinks FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_delete') THEN
    CREATE POLICY "public_delete" ON public.shortlinks FOR DELETE USING (true);
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Storage bucket for file uploads
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('files', 'files', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_upload_files') THEN
    CREATE POLICY "public_upload_files"
      ON storage.objects FOR INSERT TO anon
      WITH CHECK (bucket_id = 'files');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_read_files') THEN
    CREATE POLICY "public_read_files"
      ON storage.objects FOR SELECT TO anon
      USING (bucket_id = 'files');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_delete_files') THEN
    CREATE POLICY "public_delete_files"
      ON storage.objects FOR DELETE TO anon
      USING (bucket_id = 'files');
  END IF;
END;
$$;
