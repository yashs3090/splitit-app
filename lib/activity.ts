// Data layer for the Activity screen: the bill's newest events plus participants' display names.
// Spec: docs/specs/2026-11-20-m1b-m2-share-and-claim.md ("Activity log", Task 17).
//
// Same rules as lib/bills.ts: returns { ok: true, ... } or { ok: false, error: BillError }, maps
// errors from the SQLSTATE only (server text never leaves this file), and validates every value.
// Malformed rows are 'network', never coerced. `kind` and `details` are passed through as data:
// lib/activityText.ts decides what is shown and skips anything unknown or malformed.
//
// Kept separate from lib/bills.ts so the Activity screen can land without touching the bill data
// layer. The client is a parameter so tests can pass a fake without mocking modules.
import type { SupabaseClient } from '@supabase/supabase-js';

import type { ActivityEvent } from './activityText';
import type { BillError, BillParticipant } from './bills';

/** The slice of the Supabase client this module uses. */
export type ActivityClient = Pick<SupabaseClient, 'from'>;

export type ActivityResult =
  | { ok: true; events: ActivityEvent[]; participants: BillParticipant[] }
  | { ok: false; error: BillError };

/** The screen shows the newest 200 events (spec: no pagination in this slice). */
export const ACTIVITY_LIMIT = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_COLUMNS = 'id, actor_id, kind, item_name, details, created_at';
// The same embed lib/bills.ts uses: the FK is named because bills ↔ profiles is ambiguous to PostgREST.
const PARTICIPANT_COLUMNS = 'user_id, profile:profiles!bill_participants_user_id_fkey(display_name)';

type Raw = { data: unknown; error: unknown };

class Malformed extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isTimestamp = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());

function check<T>(ok: boolean, value: T): T {
  if (!ok) throw new Malformed();
  return value;
}

function parseEvent(v: unknown): ActivityEvent {
  if (!isObject(v)) throw new Malformed();
  return {
    id: check(isUuid(v.id), v.id as string),
    kind: check(typeof v.kind === 'string' && v.kind !== '', v.kind as string),
    actorId: check(v.actor_id === null || isUuid(v.actor_id), v.actor_id as string | null),
    itemName: check(isStringOrNull(v.item_name), v.item_name as string | null),
    // jsonb not null: any JSON value. Its shape is checked per kind by describeEvent.
    details: check(v.details !== undefined, v.details),
    createdAt: check(isTimestamp(v.created_at), v.created_at as string),
  };
}

function parseParticipant(v: unknown): BillParticipant {
  if (!isObject(v)) throw new Malformed();
  const profile = v.profile;
  let displayName: string | null = null;
  if (profile !== null && profile !== undefined) {
    if (!isObject(profile) || !isStringOrNull(profile.display_name)) throw new Malformed();
    displayName = profile.display_name;
  }
  return { userId: check(isUuid(v.user_id), v.user_id as string), displayName };
}

function parseList<T>(v: unknown, parse: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Malformed();
  return v.map(parse);
}

/** SQLSTATE only: 42501 is not_allowed, anything else (or none) is network. */
function mapError(error: unknown): BillError {
  const code = isObject(error) ? error.code : undefined;
  return code === '42501' ? 'not_allowed' : 'network';
}

/**
 * The newest ACTIVITY_LIMIT events (created_at desc, ties by id desc, so events from one
 * transaction keep a stable order) and the bill's participants. RLS returns rows only to
 * participants, and a participant always sees their own participant row, so no participants means
 * no access (or no such bill): not_found.
 */
export async function fetchActivity(client: ActivityClient, billId: string): Promise<ActivityResult> {
  if (!isUuid(billId)) return { ok: false, error: 'not_found' };
  let results: [Raw, Raw];
  try {
    results = await Promise.all([
      client
        .from('bill_events')
        .select(EVENT_COLUMNS)
        .eq('bill_id', billId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(ACTIVITY_LIMIT),
      client.from('bill_participants').select(PARTICIPANT_COLUMNS).eq('bill_id', billId),
    ]);
  } catch {
    return { ok: false, error: 'network' };
  }
  const failed = results.find((r) => r.error);
  if (failed) return { ok: false, error: mapError(failed.error) };
  const [eventsRes, participantsRes] = results;
  try {
    const participants = parseList(participantsRes.data, parseParticipant);
    if (participants.length === 0) return { ok: false, error: 'not_found' };
    return { ok: true, events: parseList(eventsRes.data, parseEvent), participants };
  } catch {
    return { ok: false, error: 'network' };
  }
}
