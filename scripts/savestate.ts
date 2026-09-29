import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.dazn.com/en-AU');

  // wait a bit for OneTrust to initialize
  await page.waitForTimeout(3000);

  const banner = page.locator('#onetrust-consent-sdk');
  const accept = page.locator('button:has-text("Accept")');

  // 👉 Only click if visible
  if (await accept.isVisible().catch(() => false)) {
    console.log('🍪 Accepting cookies...');
    await accept.click();

    await banner.waitFor({ state: 'hidden' });
  } else {
    console.log('✅ Cookies already handled / banner not visible');
  }

  // give time for state to persist
  await page.waitForTimeout(2000);

  await context.storageState({
    path: 'auth/dazn-storage-state.json'
  });

  console.log('✅ storage updated');

  await browser.close();
})();