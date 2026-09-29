export function normalizeAndroidTitle(value: string, separator = ''): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/[^a-z0-9]+/g, separator)
    .trim();
}

export function normalizeAndroidTitleWords(value: string): string[] {
  return normalizeAndroidTitle(value, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
