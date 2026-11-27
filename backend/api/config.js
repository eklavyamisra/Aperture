// Public runtime config for the browser.
//
//   GET /api/config  ->  { supabase: { url, anonKey } }   when accounts are set up
//                    ->  {}                               when they aren't (app stays local-only)
//
// The Supabase anon key is meant to be public: every table and file is locked
// to its owner by row-level security (see backend/supabase/schema.sql). The service
// role key must never be sent here.

// the Supabase settings from the env, or null unless both look right
export function supabaseEnv() {
    const url = process.env.SUPABASE_URL || "";
    const anonKey = process.env.SUPABASE_ANON_KEY || "";
    if (/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/.test(url) && /^[A-Za-z0-9._-]{20,}$/.test(anonKey)) {
        return { url: url.replace(/\/$/, ""), anonKey };
    }
    return null;
}

export async function GET() {
    const supabase = supabaseEnv();
    return new Response(JSON.stringify(supabase ? { supabase } : {}), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
    });
}
