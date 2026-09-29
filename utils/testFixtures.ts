import { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Test execution context — holds all runtime state for a single flow
 */
export interface TestContext {
  context: BrowserContext;
  page: Page;
  results: any[];
  eventData: Record<string, string>;
}

/**
 * Create browser context with standard settings
 */
export async function createTestContext(
  browser: Browser,
  existingUser = false
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: null,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    recordVideo: {
      dir: 'test-results/videos/',
      size: { width: 1920, height: 1080 },
    },
  });

  await context.addInitScript(() => {
    try {
      if (!window.location.href.includes('/signin')) {
        localStorage.clear();
        sessionStorage.clear();
      }
      localStorage.setItem('randomABPoint', Math.random().toString());
    } catch {
      console.warn('⚠️  Could not init localStorage');
    }
  });

  const page = await context.newPage();
  return { context, page };
}

/**
 * Close context and log video path
 */
export async function cleanupContext(
  context: BrowserContext,
  page: Page
): Promise<string | null> {
  let videoPath: string | null = null;
  try {
    videoPath = await page.video()?.path() || null;
    if (videoPath) console.log(`🎥 Video: ${videoPath}`);
  } catch {
    console.warn('⚠️  Could not get video path');
  }

  try {
    await context.close();
  } catch {
    console.warn('⚠️  Could not close context');
  }

  return videoPath;
}

/**
 * Type helper for test results
 */
export interface TestResult {
  page: string;
  field: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  variant?: string;
  tier?: string;
  ratePlan?: string;
  flowName?: string;
  source?: string;
}

/**
 * Calculate pass rate from results
 */
export function calculateStats(results: TestResult[]): {
  passed: number;
  failed: number;
  total: number;
  passRate: string;
} {
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const total = passed + failed;
  return {
    passed,
    failed,
    total,
    passRate: total > 0 ? `${((passed / total) * 100).toFixed(1)}%` : 'N/A',
  };
}

/**
 * Log flow summary
 */
export function logFlowSummary(
  name: string,
  results: TestResult[],
  reachedEndPage: boolean,
  error?: string
): void {
  const stats = calculateStats(results);
  const icon = error ? '❌' : stats.failed === 0 ? '✅' : '⚠️';
  console.log(`  ${icon} ${name}`);
  console.log(`     ${stats.passed}/${stats.total} passed (${stats.passRate}) | End page: ${reachedEndPage ? '✅' : '❌'}`);
  if (error) console.log(`     Error: ${error.substring(0, 80)}`);
}