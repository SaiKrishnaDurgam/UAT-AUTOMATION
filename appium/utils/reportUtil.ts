import * as fs from 'fs';
import * as path from 'path';
import ReportGenerator from './reportGenerator';
import { TestResult, ReportConfig } from './reportTypes';

/**
 * Report Utility - Generate HTML and PDF reports from test results
 */
export class ReportUtil {
  /**
   * Generate reports from a test result file
   */
  static async generateReportsFromFile(
    resultFilePath: string,
    outputDir?: string,
    config?: ReportConfig,
  ): Promise<{ htmlPath: string; pdfPath?: string }> {
    if (!fs.existsSync(resultFilePath)) {
      throw new Error(`Result file not found: ${resultFilePath}`);
    }

    const resultData = JSON.parse(fs.readFileSync(resultFilePath, 'utf-8')) as TestResult;
    const outDir = outputDir || path.join(path.dirname(resultFilePath), '../reports');

    return ReportUtil.generateReports(resultData, outDir, config);
  }

  /**
   * Generate reports from test result object
   */
  static async generateReports(
    testResult: TestResult,
    outputDir: string,
    config?: ReportConfig,
  ): Promise<{ htmlPath: string; pdfPath?: string }> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const reportConfig: ReportConfig = {
      title: `${testResult.testName} - Test Report`,
      companyName: 'DAZN',
      includeGraphs: true,
      highlightFailures: true,
      includeScreenshots: true,
      ...config,
    };

    const generator = new ReportGenerator(testResult, reportConfig);

    // Generate HTML
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const htmlPath = path.join(outputDir, `report-${timestamp}.html`);
    const finalHtmlPath = generator.saveHTML(htmlPath);

    // Try to generate PDF
    let pdfPath: string | undefined;
    try {
      const pdfOutPath = path.join(outputDir, `report-${timestamp}.pdf`);
      pdfPath = await generator.generatePDF(pdfOutPath);
    } catch (error) {
      console.warn('PDF generation skipped. Install puppeteer for PDF support: npm install puppeteer');
    }

    console.log('\n✓ Reports Generated Successfully!');
    console.log(`  HTML: ${finalHtmlPath}`);
    if (pdfPath) console.log(`  PDF:  ${pdfPath}`);

    return { htmlPath: finalHtmlPath, pdfPath };
  }

  /**
   * Create test result from logs and checks
   */
  static createTestResult(
    testName: string,
    startTime: Date,
    endTime: Date,
    pageResults: Array<{
      pageName: string;
      checks: Array<{
        checkName: string;
        expected: string;
        actual?: string;
        status: 'PASS' | 'FAIL' | 'SKIP';
        mandatory: boolean;
      }>;
    }>,
    environment?: {
      name: string;
      region: string;
      surfacingPoint: string;
    },
    device?: {
      platform: string;
      version: string;
      deviceType: string;
    },
  ): TestResult {
    const durationMs = endTime.getTime() - startTime.getTime();
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);

    let totalChecks = 0;
    let passedChecks = 0;
    let failedChecks = 0;
    const failedTests: TestResult['failedTests'] = [];

    const processedPageResults = pageResults.map((page) => {
      let pagePass = 0;
      let pageFail = 0;

      const processedChecks = page.checks.map((check) => {
        totalChecks++;
        if (check.status === 'PASS') {
          pagePass++;
          passedChecks++;
        } else if (check.status === 'FAIL') {
          pageFail++;
          failedChecks++;
          failedTests.push({
            page: page.pageName,
            check: check.checkName,
            expected: check.expected,
            actual: check.actual || 'N/A',
            failureReason: `Check failed during test execution`,
          });
        }

        return {
          checkName: check.checkName,
          expected: check.expected,
          actual: check.actual,
          status: check.status,
          mandatory: check.mandatory,
          timestamp: startTime.toISOString(),
        };
      });

      const passPercentage = page.checks.length > 0 ? Math.round((pagePass / page.checks.length) * 100) : 0;

      return {
        pageName: page.pageName,
        checks: processedChecks,
        passCount: pagePass,
        failCount: pageFail,
        totalCount: page.checks.length,
        passPercentage,
      };
    });

    const overallPassPercentage = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;
    const status: 'PASS' | 'FAIL' | 'PARTIAL' = failedChecks === 0 ? 'PASS' : failedChecks === passedChecks ? 'FAIL' : 'PARTIAL';

    return {
      testName,
      status,
      startTime: startTime.toLocaleString(),
      endTime: endTime.toLocaleString(),
      duration: `${minutes}m ${seconds}s`,
      totalChecks,
      passedChecks,
      failedChecks,
      passPercentage: overallPassPercentage,
      environment: environment || { name: 'TEST', region: 'US', surfacingPoint: 'N/A' },
      device,
      pageResults: processedPageResults,
      failedTests,
      reportGeneratedAt: new Date().toLocaleString(),
    };
  }
}

/**
 * CLI Usage
 * Run with: npx ts-node src/utils/report-util.ts <resultFilePath> [outputDir]
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const resultFile = args[0];
  const outputDir = args[1];

  if (!resultFile) {
    console.log('Usage: npx ts-node src/utils/report-util.ts <resultFilePath> [outputDir]');
    console.log('Example: npx ts-node src/utils/report-util.ts test/data/sample-test-result.json test/reports');
    process.exit(1);
  }

  ReportUtil.generateReportsFromFile(resultFile, outputDir)
    .then(() => {
      console.log('Report generation completed!');
    })
    .catch((error) => {
      console.error('Error generating reports:', error);
      process.exit(1);
    });
}

export default ReportUtil;
