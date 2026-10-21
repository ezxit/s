-- Shortlink 1.5: full-library search, recoverable deletion, original files.
-- Run this entire file in each project's Supabase SQL Editor. Idempotent.
-- Existing public/anonymous access is retained; namespaces are labels, not accounts.
-- Browser code never requires a service-role key.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.shortlinks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT DEFAULT '', images JSONB DEFAULT '[]'::jsonb,
  files JSONB DEFAULT '[]'::jsonb, description TEXT DEFAULT '',
  namespace TEXT DEFAULT 'default', created TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.shortlinks
  ADD COLUMN IF NOT EXISTS files JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleanup_keys JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retired_assets JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS search_text TEXT DEFAULT '';

-- Permanent tombstones prevent an object scheduled for deletion from being
-- attached to another record while the browser is contacting Storage.
CREATE TABLE IF NOT EXISTS public.shortlink_object_cleanup (
  bucket TEXT NOT NULL, object_key TEXT NOT NULL,
  record_id UUID NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ, PRIMARY KEY (bucket, object_key)
);
ALTER TABLE public.shortlink_object_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shortlink_object_cleanup FROM anon, authenticated;
CREATE TABLE IF NOT EXISTS public.shortlink_purge_receipts (
  id UUID PRIMARY KEY, namespace TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.shortlink_purge_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shortlink_purge_receipts FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.shortlink_asset_keys(p_images JSONB, p_files JSONB, p_retired JSONB)
RETURNS TABLE(bucket TEXT, key TEXT)
LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public AS $$
  WITH assets AS (
    SELECT value AS asset FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_images) = 'array' THEN p_images ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof(p_files) = 'array' THEN p_files ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof(p_retired) = 'array' THEN p_retired ELSE '[]'::jsonb END)
  ), objects AS (
    SELECT asset, COALESCE(NULLIF(asset->>'bucket', ''), 'files') AS bucket
    FROM assets WHERE jsonb_typeof(asset) = 'object'
  ), keys AS (
    SELECT bucket,
      -- Segmented assets have a logical base key, not a Storage object.
      unnest(ARRAY[CASE WHEN asset->'segmented' = 'true'::jsonb THEN NULL ELSE asset->>'key' END,
        asset->>'originalKey', asset->>'thumbnailKey', asset->>'thumbKey', asset->>'previewKey']) AS key
    FROM objects
    UNION ALL
    SELECT COALESCE(NULLIF(part->>'bucket', ''), objects.bucket), part->>'key'
    FROM objects CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(asset->'parts') = 'array' THEN asset->'parts' ELSE '[]'::jsonb END) AS part
    WHERE jsonb_typeof(part) = 'object'
    UNION ALL
    SELECT COALESCE(NULLIF(asset->'thumbnail'->>'bucket', ''), bucket), asset->'thumbnail'->>'key' FROM objects
    UNION ALL
    SELECT COALESCE(NULLIF(asset->'thumb'->>'bucket', ''), bucket), asset->'thumb'->>'key' FROM objects
  ) SELECT DISTINCT bucket, key FROM keys WHERE key IS NOT NULL AND key <> '';
$$;

CREATE OR REPLACE FUNCTION public.shortlink_search_document(p_text TEXT, p_description TEXT, p_images JSONB, p_files JSONB)
RETURNS TEXT LANGUAGE SQL IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_text, '') || E'\n' || COALESCE(p_description, '') || E'\n' || COALESCE((
    SELECT string_agg(COALESCE(value->>'name', ''), E'\n') FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_images) = 'array' THEN p_images ELSE '[]'::jsonb END ||
      CASE WHEN jsonb_typeof(p_files) = 'array' THEN p_files ELSE '[]'::jsonb END)
  ), '');
$$;

CREATE OR REPLACE FUNCTION public.shortlinks_before_write()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Writes and purge reservations share a transaction lock, closing the gap
  -- between checking references and reserving a Storage object for deletion.
  PERFORM pg_advisory_xact_lock(1894501401, 1500);
  IF TG_OP = 'DELETE' THEN
    IF OLD.cleanup_started_at IS NULL OR current_setting('shortlink.operation', true) IS DISTINCT FROM 'purge' THEN
      RAISE EXCEPTION 'Move the link to the recycle bin and use begin_purge / finish_purge';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.cleanup_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'This link is being permanently cleaned; retry cleanup instead of restoring or editing it';
  END IF;
  IF NEW.cleanup_started_at IS NOT NULL AND (NEW.deleted_at IS NULL OR current_setting('shortlink.operation', true) IS DISTINCT FROM 'purge') THEN
    RAISE EXCEPTION 'Cleanup state is managed by begin_purge';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.shortlink_asset_keys(NEW.images, NEW.files, NEW.retired_assets) k
    JOIN public.shortlink_object_cleanup c ON c.bucket = k.bucket AND c.object_key = k.key
  ) THEN
    RAISE EXCEPTION 'An attachment is being removed or was removed; upload a new copy before attaching it';
  END IF;
  NEW.search_text := public.shortlink_search_document(NEW.text, NEW.description, NEW.images, NEW.files);
  IF TG_OP = 'UPDATE' THEN NEW.updated_at := clock_timestamp(); END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.shortlinks_before_statement()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Acquire before row locks, matching the RPC lock order and avoiding a
  -- concurrent ordinary PATCH and purge waiting on each other's locks.
  PERFORM pg_advisory_xact_lock(1894501401, 1500);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS shortlinks_before_statement ON public.shortlinks;
CREATE TRIGGER shortlinks_before_statement BEFORE INSERT OR UPDATE OR DELETE ON public.shortlinks
FOR EACH STATEMENT EXECUTE FUNCTION public.shortlinks_before_statement();
DROP TRIGGER IF EXISTS shortlinks_before_write ON public.shortlinks;
CREATE TRIGGER shortlinks_before_write BEFORE INSERT OR UPDATE OR DELETE ON public.shortlinks
FOR EACH ROW EXECUTE FUNCTION public.shortlinks_before_write();

UPDATE public.shortlinks SET search_text = public.shortlink_search_document(text, description, images, files)
WHERE cleanup_started_at IS NULL AND search_text IS DISTINCT FROM public.shortlink_search_document(text, description, images, files);

CREATE INDEX IF NOT EXISTS shortlinks_namespace_created_idx ON public.shortlinks(namespace, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS shortlinks_namespace_deleted_idx ON public.shortlinks(namespace, deleted_at DESC) WHERE deleted_at IS NOT NULL;
DO $$ DECLARE extension_schema TEXT;
BEGIN
  SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE format('CREATE INDEX IF NOT EXISTS shortlinks_search_trgm_idx ON public.shortlinks USING GIN (search_text %I.gin_trgm_ops)', extension_schema);
END $$;

CREATE OR REPLACE FUNCTION public.shortlink_capabilities()
RETURNS JSONB LANGUAGE SQL STABLE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('schema', 2, 'search', true, 'trash', true, 'reliable_cleanup', true);
$$;

CREATE OR REPLACE FUNCTION public.search_shortlinks(p_namespace TEXT, p_query TEXT DEFAULT '', p_trash BOOLEAN DEFAULT false, p_limit INTEGER DEFAULT 20, p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE SQL STABLE SET search_path = pg_catalog, public AS $$
  WITH matching AS MATERIALIZED (
    SELECT id, namespace, description, created_at, updated_at, deleted_at, cleanup_started_at,
      left(COALESCE(text, ''), 180) AS preview,
      CASE WHEN jsonb_typeof(images) = 'array' THEN jsonb_array_length(images) ELSE 0 END AS image_count,
      CASE WHEN jsonb_typeof(files) = 'array' THEN jsonb_array_length(files) ELSE 0 END AS file_count
    FROM public.shortlinks
    WHERE namespace = p_namespace AND ((deleted_at IS NOT NULL) = p_trash)
      AND (COALESCE(p_query, '') = '' OR search_text ILIKE '%' ||
        replace(replace(replace(p_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%' ESCAPE E'\\')
  ), paged AS (
    SELECT * FROM matching ORDER BY created_at DESC, id DESC
    LIMIT LEAST(100, GREATEST(1, p_limit)) OFFSET GREATEST(0, p_offset)
  ) SELECT jsonb_build_object('items', COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY created_at DESC, id DESC) FROM paged), '[]'::jsonb),
    'total', (SELECT count(*) FROM matching));
$$;

CREATE OR REPLACE FUNCTION public.soft_delete_shortlinks(p_ids UUID[], p_namespace TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE selected UUID[]; available INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(1894501401, 1500);
  SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::uuid[]) INTO selected FROM unnest(p_ids) id;
  PERFORM id FROM public.shortlinks WHERE id = ANY(selected) AND namespace = p_namespace ORDER BY id FOR UPDATE;
  SELECT count(*) INTO available FROM public.shortlinks WHERE id = ANY(selected) AND namespace = p_namespace AND cleanup_started_at IS NULL;
  IF available <> cardinality(selected) THEN RAISE EXCEPTION 'Some links are missing, belong to another namespace, or are being permanently cleaned'; END IF;
  UPDATE public.shortlinks SET deleted_at = clock_timestamp() WHERE id = ANY(selected) AND namespace = p_namespace AND deleted_at IS NULL;
  RETURN jsonb_build_object('ids', to_jsonb(selected), 'count', available);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_shortlinks(p_ids UUID[], p_namespace TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE selected UUID[]; available INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(1894501401, 1500);
  SELECT COALESCE(array_agg(DISTINCT id), ARRAY[]::uuid[]) INTO selected FROM unnest(p_ids) id;
  PERFORM id FROM public.shortlinks WHERE id = ANY(selected) AND namespace = p_namespace ORDER BY id FOR UPDATE;
  SELECT count(*) INTO available FROM public.shortlinks WHERE id = ANY(selected) AND namespace = p_namespace AND cleanup_started_at IS NULL;
  IF available <> cardinality(selected) THEN RAISE EXCEPTION 'Some links are missing, belong to another namespace, or have already started permanent cleanup'; END IF;
  UPDATE public.shortlinks SET deleted_at = NULL WHERE id = ANY(selected) AND namespace = p_namespace AND deleted_at IS NOT NULL;
  RETURN jsonb_build_object('ids', to_jsonb(selected), 'count', available);
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_purge(p_id UUID, p_namespace TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target public.shortlinks%ROWTYPE; plan JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(1894501401, 1500);
  SELECT * INTO target FROM public.shortlinks WHERE id = p_id AND namespace = p_namespace FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.shortlink_purge_receipts WHERE id = p_id AND namespace = p_namespace) THEN
      RETURN jsonb_build_object('id', p_id, 'keys', '[]'::jsonb, 'completed', true);
    END IF;
    RAISE EXCEPTION 'Link missing or namespace does not match';
  END IF;
  IF target.deleted_at IS NULL THEN RAISE EXCEPTION 'Move the link to the recycle bin first'; END IF;
  IF target.cleanup_started_at IS NOT NULL THEN RETURN jsonb_build_object('id', p_id, 'keys', target.cleanup_keys); END IF;
  -- Shared objects stay intact while a restorable record refers to them.
  -- Frozen cleanup rows may share an object: exactly one persisted plan owns
  -- its reservation, including when two browser windows start cleanup.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', k.bucket, 'key', k.key) ORDER BY k.bucket, k.key), '[]'::jsonb) INTO plan
  FROM public.shortlink_asset_keys(target.images, target.files, target.retired_assets) k
  WHERE NOT EXISTS (
    SELECT 1 FROM public.shortlinks other_row
    CROSS JOIN LATERAL public.shortlink_asset_keys(other_row.images, other_row.files, other_row.retired_assets) other_key
    WHERE other_row.id <> p_id AND other_row.cleanup_started_at IS NULL
      AND other_key.bucket = k.bucket AND other_key.key = k.key
  ) AND NOT EXISTS (
    SELECT 1 FROM public.shortlink_object_cleanup reserved
    WHERE reserved.bucket = k.bucket AND reserved.object_key = k.key
  );
  PERFORM set_config('shortlink.operation', 'purge', true);
  UPDATE public.shortlinks SET cleanup_started_at = clock_timestamp(), cleanup_keys = plan WHERE id = p_id;
  INSERT INTO public.shortlink_object_cleanup(bucket, object_key, record_id)
    SELECT value->>'bucket', value->>'key', p_id FROM jsonb_array_elements(plan)
    ON CONFLICT (bucket, object_key) DO NOTHING;
  RETURN jsonb_build_object('id', p_id, 'keys', plan);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_purge(p_id UUID, p_namespace TEXT, p_completed_keys JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE target public.shortlinks%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(1894501401, 1500);
  SELECT * INTO target FROM public.shortlinks WHERE id = p_id AND namespace = p_namespace FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.shortlink_purge_receipts WHERE id = p_id AND namespace = p_namespace) THEN
      RETURN jsonb_build_object('id', p_id, 'completed', true);
    END IF;
    RAISE EXCEPTION 'Link missing or namespace does not match';
  END IF;
  IF target.cleanup_started_at IS NULL OR p_completed_keys IS DISTINCT FROM target.cleanup_keys THEN
    RAISE EXCEPTION 'The complete Storage cleanup plan must succeed before removing the record';
  END IF;
  PERFORM set_config('shortlink.operation', 'purge', true);
  UPDATE public.shortlink_object_cleanup SET completed_at = clock_timestamp() WHERE record_id = p_id;
  DELETE FROM public.shortlinks WHERE id = p_id AND namespace = p_namespace;
  INSERT INTO public.shortlink_purge_receipts(id, namespace) VALUES (p_id, p_namespace)
    ON CONFLICT (id) DO UPDATE SET namespace = EXCLUDED.namespace, completed_at = clock_timestamp();
  RETURN jsonb_build_object('id', p_id);
END;
$$;

ALTER TABLE public.shortlinks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shortlinks TO anon;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_read') THEN
    CREATE POLICY public_read ON public.shortlinks FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_insert') THEN
    CREATE POLICY public_insert ON public.shortlinks FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_update') THEN
    CREATE POLICY public_update ON public.shortlinks FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'shortlinks' AND policyname = 'public_delete') THEN
    CREATE POLICY public_delete ON public.shortlinks FOR DELETE USING (true);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.shortlink_capabilities(), public.search_shortlinks(TEXT, TEXT, BOOLEAN, INTEGER, INTEGER),
  public.soft_delete_shortlinks(UUID[], TEXT), public.restore_shortlinks(UUID[], TEXT),
  public.begin_purge(UUID, TEXT), public.finish_purge(UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shortlink_capabilities(), public.search_shortlinks(TEXT, TEXT, BOOLEAN, INTEGER, INTEGER),
  public.soft_delete_shortlinks(UUID[], TEXT), public.restore_shortlinks(UUID[], TEXT),
  public.begin_purge(UUID, TEXT), public.finish_purge(UUID, TEXT, JSONB) TO anon, authenticated;

-- Original images and attachments share a 200 MiB public bucket.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('files', 'files', true, 209715200)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_upload_files') THEN
    CREATE POLICY public_upload_files ON storage.objects FOR INSERT TO anon WITH CHECK (bucket_id = 'files');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_read_files') THEN
    CREATE POLICY public_read_files ON storage.objects FOR SELECT TO anon USING (bucket_id = 'files');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_update_files') THEN
    CREATE POLICY public_update_files ON storage.objects FOR UPDATE TO anon USING (bucket_id = 'files') WITH CHECK (bucket_id = 'files');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'public_delete_files') THEN
    CREATE POLICY public_delete_files ON storage.objects FOR DELETE TO anon USING (bucket_id = 'files');
  END IF;
END $$;
NOTIFY pgrst, 'reload schema';
