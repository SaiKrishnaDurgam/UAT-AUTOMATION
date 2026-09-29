import { defineConfig } from '@playwright/test';

const isHeadless = process.env.HEADLESS === 'true';

const REGION = (process.env.DAZN_REGION || 'GB').toUpperCase();
const regionLocaleMap: Record<string, { locale: string; timezoneId: string }> = {
  GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
  US: { locale: 'en-US', timezoneId: 'America/New_York' },
  AE: { locale: 'en-AE', timezoneId: 'Asia/Dubai' },
  SA: { locale: 'en-SA', timezoneId: 'Asia/Riyadh' },
  AU: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
  BR: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  CA: { locale: 'en-CA', timezoneId: 'America/Toronto' },
  NO: { locale: 'en-GB', timezoneId: 'Europe/Oslo' },
};
const { locale: regionLocale, timezoneId: regionTimezone } =
  regionLocaleMap[REGION] ?? { locale: 'en-GB', timezoneId: 'Europe/London' };

export default defineConfig({
  testDir: './tests',
  // End-to-end runs include browser/video finalisation plus HTML/PDF/Excel
  // evidence generation. Keep that work inside a realistic shared deadline.
  timeout: 420_000,
  retries: 0,
  workers: process.env.CI ? 4 : 4,
  outputDir: 'test-results',

  use: {
    headless: isHeadless,

    // Headless (CI): retain the fixed desktop viewport used by the workflows.
    // Headed (laptop/desktop): use the actual maximised window, so a 1920×1080
    // emulated page is not clipped by a smaller physical display.
    ...(isHeadless
      ? { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }
      : { viewport: null }),
    isMobile: false,
    hasTouch: false,

    timezoneId: regionTimezone,
    locale: regionLocale,

    launchOptions: {
      args: [
        // Keep CI's virtual 1920×1080 display. Locally, maximise the browser
        // and let viewport: null follow the available desktop space.
        ...(isHeadless ? ['--window-size=1920,1080'] : ['--start-maximized']),
        '--disable-infobars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-popup-blocking',
      ],
    },

    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    video: {
      mode: 'retain-on-failure',
      // Preserve CI recordings. In headed mode, inherit the real window size.
      ...(isHeadless ? { size: { width: 1920, height: 1080 } } : {}),
    },

    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'always' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
});
