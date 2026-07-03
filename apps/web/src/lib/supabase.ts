/**
 * Supabase client for the Roybal Restoration web admin.
 * Uses the browser's localStorage for session persistence.
 * Never includes the SERVICE_ROLE_KEY — that lives only in server-side code.
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env["VITE_SUPABASE_URL"] as string;
const supabaseAnonKey = import.meta.env["VITE_SUPABASE_ANON_KEY"] as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "[Roybal] Missing Supabase env vars. Copy .env.example → .env and fill in values."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
  },
});

/** Get a signed URL for a storage object */
export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn = 3600
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error) return null;
  return data.signedUrl;
}

/**
 * Resolve display URLs for photos.
 *
 * Canonical storage is the private `photos` bucket (signed URLs). Photos
 * uploaded by older web builds live in the legacy `job-photos` bucket —
 * for any path that fails to sign, fall back to that bucket's public URL.
 */
export async function resolvePhotoUrls<T extends { storage_path: string }>(
  photos: T[],
  expiresIn = 3600
): Promise<(T & { url: string })[]> {
  if (photos.length === 0) return [];
  const paths = photos.map((p) => p.storage_path);
  const { data } = await supabase.storage.from("photos").createSignedUrls(paths, expiresIn);
  const signedByPath = new Map(
    (data ?? []).filter((r) => !r.error && r.signedUrl).map((r) => [r.path, r.signedUrl])
  );
  return photos.map((p) => ({
    ...p,
    url:
      signedByPath.get(p.storage_path) ??
      supabase.storage.from("job-photos").getPublicUrl(p.storage_path).data.publicUrl,
  }));
}
