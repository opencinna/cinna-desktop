# Guest Aliases (Easter Egg)

## Purpose

On every app restart, the default/guest user gets a random cyberpunk-themed display name instead of a static "Default User" label. A small personality touch that makes the guest experience feel less generic.

## Behavior

- The alias rotates once per app launch during `initSession()`
- The new name is written to the `users` table (`display_name` column for `__default__`)
- It persists until the next restart — consistent within a single session
- The alias shows in the UserMenu dropdown, LoginScreen "Continue as Guest" flow, and anywhere the guest user's display name is rendered

## Alias Pool

Cyberpunk / unknown-entity themed names:

Chosen One, John Doe, Ghost in the Shell, Neon Drifter, Rogue Signal, Zero Day, Phantom Node, Shadow Runner, Unknown Entity, Null Pointer, Net Walker, Glitch, Cipher, Echo, Sleeper Agent, Jane Doe, Stray Voltage, Lost Packet, Anon, Wanderer

## Implementation

- Alias list and rotation logic live in `src/main/auth/session.ts:rotateGuestAlias()`
- Called from `initSession()` on every app startup
- Updates the DB row directly via Drizzle `update().set({ displayName }).where(id = '__default__')`
- Migration seeds the initial display name as "Unknown Entity" (`src/main/db/migrations/users.ts`)

## Adding New Aliases

Add entries to the `GUEST_ALIASES` array in `src/main/auth/session.ts`. No other changes needed — selection is uniform random.
