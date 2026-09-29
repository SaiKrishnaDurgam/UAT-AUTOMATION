import { expect, test } from '@playwright/test';
import { validateBannerImage } from '../../utils/geminiBannerValidator';
import { handleCookies } from '../../utils/helpers';
import { readFileSync } from 'fs';

const nflWelcomeUrl = 'https://stag.dazn.com/en-GB/welcome/nfl';

function getFighterNames(): string[] {
  try {
    const config = JSON.parse(readFileSync('config/events/ppv_t_joshua_prenga.json', 'utf8'));
    const title = config.PPV_CARD_TITLE || '';
    const parts = title.split(/\s+vs\.?\s+/i);
    return parts.length === 2 ? parts : [];
  } catch {
    return [];
  }
}

test('Gemini rejects degraded NFL welcome banner artwork on staging', async ({ page }) => {
  if (!process.env.GEMINI_API_KEY) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      throw new Error('GEMINI_API_KEY is required for the staging NFL visual assessment');
    }
    test.skip(true, 'GEMINI_API_KEY is required for the local visual assessment');
  }

  await page.goto(nflWelcomeUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('body').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await handleCookies(page, 5000);
  await page.waitForTimeout(2_000);

  const result = await validateBannerImage(page, {
    region: 'GB',
    flow: 'stag-nfl-welcome',
    url: nflWelcomeUrl,
    fighterNames: getFighterNames(),
  });

  expect(result, 'Gemini did not return a banner assessment').not.toBeNull();
  expect(result?.passed, result?.assessment.findings.join(' | ')).toBe(true);
});
