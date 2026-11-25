# People and membership (pointer)

The full write-up of "people you've split with" lives in **[ADR 0016](../decisions/0016-people-come-from-shared-bills.md)**. This note is a short map of the same ideas so you can find them from the concepts list.

- **Who counts as "split with" (rule L1).** Two people are linked through a bill once both of them took part: hosted it, joined with the link, or claimed something. Being *added* by the host doesn't count on its own. Opening the link after being added counts as joining (R6). The rule lives once, in `private.my_links()` (`supabase/migrations/20261124091041_people.sql`).
- **Adding someone.** Only the host, and only someone already linked to them. A missing user and an unlinked user get the same `not_linked` answer, so the call can't be used to find out who has an account: see [row-level security](row-level-security.md), "`not_linked`: a privacy story".
- **Removing and leaving (rule L3).** Allowed only for someone with no claims, no "I paid" mark, who isn't the payer or the host, so nobody's share ever changes. The same rule is in `lib/membership.ts` and `private.is_removable` (`supabase/migrations/20261124091042_membership.sql`), tested on the same cases M1–M8 on both sides.
- **Lock order.** Every function that touches a bill locks the bill row first; see [database functions](database-functions.md), "One lock order for every bill".
- **Contacts.** Picked on the phone, never uploaded; native code stays out of web: see [platform-specific files](platform-specific-files.md).

## Check yourself
1. Hana adds Sam to her bill, and Ali is also on it. Can Ali now add Sam to Ali's own bill? Why not?
2. Why does `add_participant` give the same error for a made-up user id as for a real person you've never split with?
