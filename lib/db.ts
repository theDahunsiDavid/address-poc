import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-only module: uses the service role key, which must never reach the
// browser. Import this only from pages/api/* routes.

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  }
  client ??= createClient(url, serviceKey);
  return client;
}