/**
 * Handoff utility — writes the web checkout URL captured from the native app
 * to a file that the Playwright mobile spec reads automatically.
 */
import * as fs from 'fs';
import * as path from 'path';

// Path that Playwright mobile.ppv.spec.ts reads
const HANDOFF_FILE = path.resolve(__dirname, '../../mobile_entry_url.txt');

export function writeHandoffUrl(url: string): void {
  fs.writeFileSync(HANDOFF_FILE, url.trim(), 'utf-8');
  console.log(`\n📝 Handoff URL written to: ${HANDOFF_FILE}`);
  console.log(`   URL: ${url}`);
}

export function readHandoffUrl(): string | null {
  if (!fs.existsSync(HANDOFF_FILE)) return null;
  const url = fs.readFileSync(HANDOFF_FILE, 'utf-8').trim();
  return url.startsWith('http') ? url : null;
}

export function clearHandoffUrl(): void {
  if (fs.existsSync(HANDOFF_FILE)) {
    fs.unlinkSync(HANDOFF_FILE);
  }
}
