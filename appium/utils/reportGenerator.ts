import * as fs from 'fs';
import * as path from 'path';
import { TestResult, PageResult, ReportConfig } from './reportTypes';

export class ReportGenerator {
  private testResult: TestResult;
  private config: ReportConfig;

  constructor(testResult: TestResult, config?: ReportConfig) {
    this.testResult = testResult;
    this.config = {
      title: 'Test Execution Report',
      companyName: 'DAZN',
      includeGraphs: true,
      highlightFailures: true,
      includeScreenshots: true,
      ...config,
    };
  }

  /**
   * Generate HTML5 Report
   */
  generateHTML(): string {
    const passPercentage = this.testResult.passPercentage;
    const statusColor = passPercentage === 100 ? '#28a745' : passPercentage >= 80 ? '#ffc107' : '#dc3545';
    const statusText = this.testResult.status === 'PASS' ? 'ALL PASSED' : this.testResult.status === 'PARTIAL' ? 'PARTIAL' : 'FAILED';

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.config.title}</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 20px;
            color: #333;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
            overflow: hidden;
        }
        
        header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        
        header h1 {
            font-size: 28px;
            margin-bottom: 10px;
        }
        
        header p {
            font-size: 14px;
            opacity: 0.9;
        }
        
        .execution-summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
            border-bottom: 1px solid #e9ecef;
        }
        
        .summary-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            text-align: center;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            border-top: 4px solid #667eea;
        }
        
        .summary-card.passed {
            border-top-color: #28a745;
        }
        
        .summary-card.failed {
            border-top-color: #dc3545;
        }
        
        .summary-card h3 {
            font-size: 32px;
            font-weight: bold;
            color: ${statusColor};
            margin-bottom: 5px;
        }
        
        .summary-card p {
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .status-badge {
            display: inline-block;
            padding: 10px 20px;
            border-radius: 20px;
            font-weight: bold;
            background: ${statusColor};
            color: white;
            margin: 10px 0;
        }
        
        .charts-section {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            padding: 30px;
            background: #f8f9fa;
        }
        
        .chart-container {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        .chart-container h3 {
            margin-bottom: 20px;
            color: #333;
            font-size: 16px;
        }
        
        canvas {
            max-width: 100%;
        }
        
        .run-configuration {
            padding: 30px;
            background: white;
        }
        
        .config-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .config-item {
            padding: 15px;
            background: #f8f9fa;
            border-left: 4px solid #667eea;
            border-radius: 4px;
        }
        
        .config-item label {
            display: block;
            font-size: 12px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 5px;
        }
        
        .config-item value {
            display: block;
            font-size: 16px;
            font-weight: bold;
            color: #333;
        }
        
        .per-page-results {
            padding: 30px;
            background: white;
        }
        
        .page-result {
            margin-bottom: 30px;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        .page-header {
            background: #667eea;
            color: white;
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .page-header h3 {
            margin: 0;
        }
        
        .page-stats {
            display: flex;
            gap: 20px;
            font-size: 13px;
        }
        
        .page-stats span {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .stat-pass { color: #90EE90; }
        .stat-fail { color: #FFB6C6; }
        
        .checks-table {
            width: 100%;
            border-collapse: collapse;
        }
        
        .checks-table thead {
            background: #f8f9fa;
            border-bottom: 2px solid #dee2e6;
        }
        
        .checks-table th {
            padding: 12px;
            text-align: left;
            font-weight: 600;
            font-size: 13px;
            color: #333;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .checks-table td {
            padding: 12px;
            border-bottom: 1px solid #dee2e6;
        }
        
        .checks-table tbody tr:hover {
            background: #f8f9fa;
        }
        
        .status-pass {
            color: #28a745;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .status-pass::before {
            content: '✓';
            display: inline-block;
            width: 20px;
            height: 20px;
            background: #28a745;
            color: white;
            border-radius: 50%;
            text-align: center;
            line-height: 20px;
            font-size: 12px;
        }
        
        .status-fail {
            color: #dc3545;
            font-weight: bold;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        
        .status-fail::before {
            content: '✕';
            display: inline-block;
            width: 20px;
            height: 20px;
            background: #dc3545;
            color: white;
            border-radius: 50%;
            text-align: center;
            line-height: 20px;
            font-size: 12px;
        }
        
        .mandatory {
            background: #fff3cd;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: bold;
            color: #856404;
        }
        
        .failure-section {
            padding: 20px;
            background: #fff5f5;
            border: 2px solid #dc3545;
            border-radius: 8px;
            margin-top: 30px;
        }
        
        .failure-section h3 {
            color: #dc3545;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .failure-item {
            background: white;
            padding: 15px;
            margin-bottom: 15px;
            border-left: 4px solid #dc3545;
            border-radius: 4px;
        }
        
        .failure-item h4 {
            color: #333;
            margin-bottom: 8px;
        }
        
        .failure-details {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            font-size: 13px;
            margin-bottom: 10px;
        }
        
        .detail-item label {
            display: block;
            color: #666;
            font-weight: bold;
            margin-bottom: 3px;
        }
        
        .detail-item value {
            display: block;
            background: #f8f9fa;
            padding: 8px;
            border-radius: 4px;
            font-family: monospace;
        }
        
        .failure-screenshot {
            margin-top: 15px;
            position: relative;
        }
        
        .failure-screenshot img {
            max-width: 100%;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        .highlight-box {
            position: absolute;
            border: 3px solid #dc3545;
            background: transparent;
        }
        
        .highlight-label {
            position: absolute;
            background: #dc3545;
            color: white;
            padding: 5px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            white-space: nowrap;
        }
        
        footer {
            background: #f8f9fa;
            padding: 20px;
            text-align: center;
            border-top: 1px solid #dee2e6;
            color: #666;
            font-size: 12px;
        }
        
        .print-button {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 10px 20px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            z-index: 1000;
        }
        
        .print-button:hover {
            background: #764ba2;
        }
        
        @media print {
            .print-button {
                display: none;
            }
            body {
                background: white;
                padding: 0;
            }
            .container {
                box-shadow: none;
                max-width: 100%;
            }
        }
        
        @media (max-width: 768px) {
            header h1 {
                font-size: 20px;
            }
            .config-grid {
                grid-template-columns: 1fr;
            }
            .failure-details {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <button class="print-button" onclick="window.print()">📥 Print / Save as PDF</button>
    
    <div class="container">
        <header>
            <h1>${this.config.title}</h1>
            <p>Generated: ${this.testResult.reportGeneratedAt || new Date().toLocaleString()}</p>
            <p>Start: ${this.testResult.startTime} | Duration: ${this.testResult.duration}</p>
            <div class="status-badge">${statusText}</div>
        </header>
        
        <div class="execution-summary">
            <div class="summary-card">
                <h3>${this.testResult.totalChecks}</h3>
                <p>Total Checks</p>
            </div>
            <div class="summary-card passed">
                <h3>${this.testResult.passedChecks}</h3>
                <p>Passed</p>
            </div>
            <div class="summary-card failed">
                <h3>${this.testResult.failedChecks}</h3>
                <p>Failed</p>
            </div>
            <div class="summary-card">
                <h3>${this.testResult.passPercentage}%</h3>
                <p>Pass Rate</p>
            </div>
        </div>
        
        ${this.config.includeGraphs ? this.generateChartsHTML() : ''}
        
        ${this.generateRunConfigurationHTML()}
        
        ${this.generatePerPageResultsHTML()}
        
        ${this.testResult.failedChecks > 0 ? this.generateFailuresHTML() : ''}
        
        <footer>
            <p>${this.config.companyName} | Report Generated on ${new Date().toLocaleString()}</p>
            <p>${this.config.footerText || ''}</p>
        </footer>
    </div>
    
    ${this.config.includeGraphs ? this.generateChartScripts() : ''}
</body>
</html>
    `;

    return html;
  }

  private generateChartsHTML(): string {
    const passFailLabels = this.testResult.pageResults.map(p => p.pageName);
    const passData = this.testResult.pageResults.map(p => p.passCount);
    const failData = this.testResult.pageResults.map(p => p.failCount);

    return `
        <div class="charts-section">
            <div class="chart-container">
                <h3>Overall Test Results</h3>
                <canvas id="overallChart"></canvas>
            </div>
            <div class="chart-container">
                <h3>Pass/Fail by Page</h3>
                <canvas id="pageChart"></canvas>
            </div>
            <div class="chart-container">
                <h3>Pass Rate Distribution</h3>
                <canvas id="rateChart"></canvas>
            </div>
        </div>
        
        <script>
        document.addEventListener('DOMContentLoaded', function() {
            // Overall Results - Doughnut Chart
            const overallCtx = document.getElementById('overallChart')?.getContext('2d');
            if (overallCtx) {
                new Chart(overallCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Passed', 'Failed'],
                        datasets: [{
                            data: [${this.testResult.passedChecks}, ${this.testResult.failedChecks}],
                            backgroundColor: ['#28a745', '#dc3545'],
                            borderColor: ['#20c997', '#bd2130'],
                            borderWidth: 2
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            legend: {
                                position: 'bottom'
                            }
                        }
                    }
                });
            }
            
            // Page Results - Bar Chart
            const pageCtx = document.getElementById('pageChart')?.getContext('2d');
            if (pageCtx) {
                new Chart(pageCtx, {
                    type: 'bar',
                    data: {
                        labels: ${JSON.stringify(passFailLabels)},
                        datasets: [
                            {
                                label: 'Passed',
                                data: ${JSON.stringify(passData)},
                                backgroundColor: '#28a745'
                            },
                            {
                                label: 'Failed',
                                data: ${JSON.stringify(failData)},
                                backgroundColor: '#dc3545'
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        }
                    }
                });
            }
            
            // Pass Rate - Line Chart
            const rateCtx = document.getElementById('rateChart')?.getContext('2d');
            if (rateCtx) {
                new Chart(rateCtx, {
                    type: 'line',
                    data: {
                        labels: ${JSON.stringify(passFailLabels)},
                        datasets: [{
                            label: 'Pass Rate %',
                            data: ${JSON.stringify(this.testResult.pageResults.map(p => p.passPercentage))},
                            borderColor: '#667eea',
                            backgroundColor: 'rgba(102, 126, 234, 0.1)',
                            borderWidth: 3,
                            tension: 0.4,
                            fill: true,
                            pointRadius: 5,
                            pointBackgroundColor: '#667eea'
                        }]
                    },
                    options: {
                        responsive: true,
                        scales: {
                            y: {
                                beginAtZero: true,
                                max: 100
                            }
                        }
                    }
                });
            }
        });
        </script>
    `;
  }

  private generateChartScripts(): string {
    return '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/3.9.1/chart.min.js"></script>';
  }

  private generateRunConfigurationHTML(): string {
    const config = this.testResult;
    return `
        <div class="run-configuration">
            <h2 style="margin-bottom: 20px; color: #333;">Run Configuration</h2>
            <div class="config-grid">
                ${config.environment ? `
                <div class="config-item">
                    <label>Environment</label>
                    <value>${config.environment.name}</value>
                </div>
                <div class="config-item">
                    <label>Region</label>
                    <value>${config.environment.region}</value>
                </div>
                <div class="config-item">
                    <label>Surfacing Point</label>
                    <value>${config.environment.surfacingPoint}</value>
                </div>
                ` : ''}
                ${config.device ? `
                <div class="config-item">
                    <label>Platform</label>
                    <value>${config.device.platform} ${config.device.version}</value>
                </div>
                <div class="config-item">
                    <label>Device</label>
                    <value>${config.device.deviceType}</value>
                </div>
                ` : ''}
                ${config.ppvEvent ? `
                <div class="config-item">
                    <label>PPV Event</label>
                    <value>${config.ppvEvent.name}</value>
                </div>
                <div class="config-item">
                    <label>Event Date</label>
                    <value>${config.ppvEvent.eventDate}</value>
                </div>
                ` : ''}
                ${config.tierAndPlan ? `
                <div class="config-item">
                    <label>Tier & Plan</label>
                    <value>${config.tierAndPlan.tier}</value>
                </div>
                <div class="config-item">
                    <label>Billing Cycle</label>
                    <value>${config.tierAndPlan.billingCycle}</value>
                </div>
                ` : ''}
                ${config.flow ? `
                <div class="config-item">
                    <label>Flow</label>
                    <value>${config.flow.name}</value>
                </div>
                ` : ''}
            </div>
        </div>
    `;
  }

  private generatePerPageResultsHTML(): string {
    return `
        <div class="per-page-results">
            <h2 style="margin-bottom: 20px; color: #333;">Per-Page Results</h2>
            ${this.testResult.pageResults
              .map((page) => this.generatePageResultHTML(page))
              .join('')}
        </div>
    `;
  }

  private generatePageResultHTML(page: PageResult): string {
    const checksHTML = page.checks
      .map(
        (check) => `
        <tr>
            <td><strong>${check.checkName}</strong>${check.mandatory ? ' <span class="mandatory">MANDATORY</span>' : ''}</td>
            <td>${check.expected}</td>
            <td>${check.actual || 'N/A'}</td>
            <td class="status-${check.status.toLowerCase()}">${check.status}</td>
        </tr>
    `,
      )
      .join('');

    return `
        <div class="page-result">
            <div class="page-header">
                <h3>${page.pageName}</h3>
                <div class="page-stats">
                    <span class="stat-pass">✓ ${page.passCount} Passed</span>
                    <span class="stat-fail">✕ ${page.failCount} Failed</span>
                    <span>Pass Rate: ${page.passPercentage}%</span>
                </div>
            </div>
            <table class="checks-table">
                <thead>
                    <tr>
                        <th>Check Name</th>
                        <th>Expected</th>
                        <th>Actual</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${checksHTML}
                </tbody>
            </table>
        </div>
    `;
  }

  private generateFailuresHTML(): string {
    if (this.testResult.failedTests.length === 0) {
      return '';
    }

    return `
        <div class="failure-section">
            <h3>⚠️ Failed Tests Details</h3>
            ${this.testResult.failedTests
              .map((failure) => this.generateFailureItemHTML(failure))
              .join('')}
        </div>
    `;
  }

  private generateFailureItemHTML(failure: {
    page: string;
    check: string;
    expected: string;
    actual: string;
    screenshot?: string;
    failureReason?: string;
  }): string {
    return `
        <div class="failure-item">
            <h4>${failure.page} → ${failure.check}</h4>
            <div class="failure-details">
                <div class="detail-item">
                    <label>Expected:</label>
                    <value>${failure.expected}</value>
                </div>
                <div class="detail-item">
                    <label>Actual:</label>
                    <value>${failure.actual}</value>
                </div>
            </div>
            ${failure.failureReason ? `<p><strong>Reason:</strong> ${failure.failureReason}</p>` : ''}
            ${
              failure.screenshot && this.config.includeScreenshots
                ? `
            <div class="failure-screenshot">
                <img src="${failure.screenshot}" alt="Failure Screenshot" style="max-width: 100%; border-radius: 4px; border: 2px solid #dc3545;">
            </div>
            `
                : ''
            }
        </div>
    `;
  }

  /**
   * Save HTML report to file
   */
  saveHTML(outputPath: string): string {
    const html = this.generateHTML();
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, html, 'utf-8');
    console.log(`HTML Report saved to: ${outputPath}`);
    return outputPath;
  }

  /**
   * Generate PDF Report (requires additional library)
   * Install: npm install puppeteer
   */
  async generatePDF(outputPath: string): Promise<string> {
    try {
      // Dynamic import to avoid hard dependency
      const puppeteer = require('puppeteer');
      const html = this.generateHTML();

      const browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      await page.pdf({
        path: outputPath,
        format: 'A4',
        margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size: 10px; width: 100%; text-align: center; padding: 10px;">${this.config.title}</div>`,
        footerTemplate: '<div style="font-size: 10px; width: 100%; text-align: center; padding: 10px;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      });

      await browser.close();
      console.log(`PDF Report saved to: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('PDF generation failed. Ensure puppeteer is installed: npm install puppeteer');
      throw error;
    }
  }
}

export default ReportGenerator;
