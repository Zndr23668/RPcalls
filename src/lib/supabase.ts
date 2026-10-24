import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const realtimeConfigured = Boolean(url && key);
export const supabase = realtimeConfigured ? createClient(url!, key!, {
  realtime: {
    params: { eventsPerSecond: 30 },
  },
}) : null;