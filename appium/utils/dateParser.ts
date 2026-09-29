/**
 * dateParser.ts
 *
 * Re-exports the canonical parsePPVDate implementation from eventLoader.ts.
 * This file exists only for backward compatibility — do not add new logic here.
 * All PPV date parsing is authoritative in eventLoader.ts.
 */

export type { ParsedPPVDate as ParsedDate } from './eventLoader';
export { parsePPVDate } from './eventLoader';