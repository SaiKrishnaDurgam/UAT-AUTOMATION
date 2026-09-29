import { Locator, Page } from '@playwright/test';

const normalise = (value: string): string => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const isVariant = (value: string): boolean =>
  /\b(press conference|weigh[\s-]?in|prelims?|preliminary|undercard|workout|replay|highlights?|preview|promo|interview|behind the scenes|episode|documentary|face[\s-]?off|kickboxing)\b/i.test(String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2'));

/**
 * Scores a result against the configured PPV name.  A named tile is preferred
 * over containers which happen to contain several search results.
 */
export function scoreSearchPPVTile(
  tileText: string,
  eventName: string,
  targetTitle = ''
): number {
  const eventPart = eventName.includes(':')
    ? eventName.split(':').slice(1).join(':').trim()
    : eventName.trim();
  const expected = normalise(eventPart || eventName);
  const fullExpected = normalise(eventName);
  const text = normalise(tileText);
  const title = normalise(targetTitle);
  if (!expected || !text) return 0;

  const words = expected
    .split(' ')
    .filter(word => word.length > 2 && !['the', 'and', 'for', 'with', 'from'].includes(word));
  if (words.length && !words.every(word => text.includes(word))) return 0;

  const variant = isVariant(tileText) || isVariant(targetTitle);
  if (title === expected || title === fullExpected) return variant ? 30 : 120;

  const lines = tileText.split(/\n+/).map(normalise).filter(Boolean);
  if (lines.some(line => line === expected || line === fullExpected)) return variant ? 35 : 100;
  if (lines.some(line =>
    line.startsWith(`${expected} `) ||
    line.startsWith(`${fullExpected} `) ||
    line.startsWith(`${expected}:`) ||
    line.startsWith(`${fullExpected}:`)
  )) return variant ? 25 : 90;
  if (text.includes(expected) || text.includes(fullExpected)) return variant ? 20 : 75;
  return variant ? 10 : 60;
}

/**
 * The single source of truth for Search PPV selection.  Both the action and
 * all tile validations use this exact locator, preventing a parent container,
 * competitor result, or ancillary programme from being validated instead.
 */
export async function resolveSearchPPVTile(page: Page, eventName: string): Promise<Locator | null> {
  let matchPattern = eventName;
  if (eventName.includes(':')) {
    matchPattern = eventName.split(':').pop()?.trim() || eventName;
  }

  const normalisedPattern = normalise(matchPattern).replace(/\s+/g, '.*');
  const regexes = [
    new RegExp(matchPattern.replace(/\s+/g, '.*'), 'i'),
    ...(normalisedPattern !== matchPattern.toLowerCase()
      ? [new RegExp(normalisedPattern, 'i')]
      : []),
  ];
  const isStaging = (process.env.DAZN_ENV || 'prod').toLowerCase() === 'stag';
  if (isStaging) {
    const firstWord = matchPattern.split(/\s+/)[0]?.trim();
    if (firstWord && firstWord.length > 2 && firstWord.toLowerCase() !== 'the') {
      regexes.push(new RegExp(firstWord, 'i'));
    }
  }

  const selectors = [
    'article',
    '[class*="EventTile" i]',
    '[class*="event-tile" i]',
    '[class*="SearchResult" i]',
    '[class*="search-result" i]',
    '[class*="tile" i]',
    '[class*="card" i]',
    'li[class*="result" i]',
    'li',
  ];

  let bestTile: Locator | null = null;
  let bestScore = 0;

  for (const regex of regexes) {
    for (const selector of selectors) {
      const tiles = page.locator(selector).filter({ hasText: regex });
      const count = await tiles.count().catch(() => 0);

      for (let i = 0; i < count; i++) {
        const tile = tiles.nth(i);
        if (!await tile.isVisible().catch(() => false)) continue;

        const text = await tile.textContent().catch(() => '');
        if (!text || text.length > 800) continue;

        const targetTitle = await tile.getAttribute('data-target-title').catch(() => '') || '';
        if (isVariant(text) || isVariant(targetTitle)) continue;

        const hasDate = await tile.locator('[class*="badge" i], [class*="date" i], time').isVisible({ timeout: 500 }).catch(() => false);
        const hasLock = await tile.locator('[class*="lock" i], [class*="ppv" i]').isVisible({ timeout: 500 }).catch(() => false);
        const hasTestMarker = /\b(?:may|test)\b/i.test(text) || /\b(?:9\s*may|20:30)\b/i.test(text);
        if (!hasDate && !hasLock && !hasTestMarker) continue;

        const score = scoreSearchPPVTile(text, eventName, targetTitle);
        if (score > bestScore) {
          bestTile = tile;
          bestScore = score;
        }
      }
    }
  }

  return bestScore >= 60 ? bestTile : null;
}
