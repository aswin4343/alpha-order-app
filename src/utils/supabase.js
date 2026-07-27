import { createClient } from '@supabase/supabase-js'

// Alpha Trade Links Supabase project (publishable key — safe in the browser;
// real protection comes from Row Level Security policies on the database).
const SUPABASE_URL = 'https://nkbawdgxllsyktwppnhn.supabase.co'
const SUPABASE_KEY = 'sb_publishable_CVbupUuEhO5Np0aBZLGh0w_7NCqJ2pj'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true
  }
})
