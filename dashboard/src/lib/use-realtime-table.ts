"use client";

import { useEffect, useRef } from "react";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/**
 * Subscribe to Postgres INSERT and UPDATE events on a Supabase table,
 * filtered to a single user_id. Cleans up on unmount.
 *
 * Graceful degradation: if the table doesn't exist, Realtime is disabled,
 * or the channel times out, the hook silently swallows the error and the
 * page keeps working with its initial server-rendered rows.
 *
 * Callbacks are stored in refs so consumers don't need to memoise them.
 */
export function useRealtimeTable<T extends { id: string }>(
  table: string,
  userId: string | null | undefined,
  onInsert?: (row: T) => void,
  onUpdate?: (row: T) => void
): void {
  const onInsertRef = useRef(onInsert);
  const onUpdateRef = useRef(onUpdate);

  // Keep refs current without re-subscribing.
  useEffect(() => {
    onInsertRef.current = onInsert;
  }, [onInsert]);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    if (!userId) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      return;
    }

    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    try {
      const supabase = createClient();
      const channelName = `realtime:${table}:${userId}:${Math.random().toString(36).slice(2, 8)}`;
      channel = supabase.channel(channelName);

      const handleInsert = (payload: RealtimePostgresChangesPayload<T>) => {
        if (cancelled) return;
        const row = payload.new as T | undefined;
        if (row && onInsertRef.current) onInsertRef.current(row);
      };

      const handleUpdate = (payload: RealtimePostgresChangesPayload<T>) => {
        if (cancelled) return;
        const row = payload.new as T | undefined;
        if (row && onUpdateRef.current) onUpdateRef.current(row);
      };

      channel = channel
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table, filter: `user_id=eq.${userId}` },
          handleInsert
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table, filter: `user_id=eq.${userId}` },
          handleUpdate
        );

      channel.subscribe((status: string, err?: Error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          // Realtime unavailable (table not in publication, RLS, network) — degrade silently.
          if (err) console.warn(`[realtime:${table}] channel error:`, err.message);
        }
      });
    } catch (err) {
      // Client construction or channel wiring failed — degrade silently.
      console.warn(`[realtime:${table}] init failed:`, err);
    }

    return () => {
      cancelled = true;
      if (channel) {
        try {
          const supabase = createClient();
          supabase.removeChannel(channel);
        } catch {
          // Ignore cleanup errors — page is unmounting.
        }
      }
    };
  }, [table, userId]);
}
