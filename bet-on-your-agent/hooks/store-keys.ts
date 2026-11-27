/**
 * The store keys more than one module uses, in one place so a rename on one
 * side cannot leave the other reading an empty history. It holds nothing
 * else, so register.tsx shares a key with record.ts without loading the
 * reader.
 *
 * Each value is the key on disk and stays as it is: a new one would find no
 * turns in any history saved before it.
 */

/** The turn history: register.tsx writes and reads it, and record.ts only reads it. */
export const TURNS_STORE_KEY = 'turns'
