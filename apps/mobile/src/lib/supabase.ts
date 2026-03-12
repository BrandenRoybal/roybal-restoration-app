/**
 * Supabase client for the Roybal Restoration mobile app.
 * Uses Expo's AsyncStorage for session persistence.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    "Missing Supabase env vars. Copy .env.example to .env and fill in values."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/** Get a signed URL for a storage object (valid for 1 hour) */
export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresIn = 3600
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error) {
    console.warn("getSignedUrl error:", error.message);
    return null;
  }
  return data.signedUrl;
}

/** Upload a file to Supabase Storage and return the storage path */
export async function uploadFile(
  bucket: string,
  path: string,
  uri: string,
  contentType: string
): Promise<string | null> {
  const response = await fetch(uri);
  const blob = await response.blob();
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(path, blob, { contentType, upsert: false });
  if (error) {
    console.error("uploadFile error:", error.message);
    return null;
  }
  return data.path;
}
