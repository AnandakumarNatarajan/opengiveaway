/**
 * Supabase client factory for the multi-tenant server.
 *
 * Every request runs as the signed-in user: we build a client carrying that
 * user's access token so Postgres Row Level Security (not application code) is
 * the tenant boundary. The service-role key is intentionally never used here.
 *
 * The factory is injectable so tests can supply an in-memory fake without a
 * live Supabase.
 */
import { createClient } from "@supabase/supabase-js";

/** The structural subset of supabase-js the server uses (satisfied by the real client). */
export interface SupabaseLike {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  storage: { from(bucket: string): any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type ClientFactory = (accessToken?: string) => SupabaseLike;

export function makeSupabaseFactory(url: string, anonKey: string): ClientFactory {
  return (accessToken?: string) =>
    createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : {},
    }) as unknown as SupabaseLike;
}
