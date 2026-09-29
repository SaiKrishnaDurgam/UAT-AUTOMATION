export interface TestCheck {
  checkName: string;
  expected: string;
  actual?: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  mandatory: boolean;
  screenshot?: string; // Base64 or file path
  failureReason?: string;
  timestamp?: string;
}

export interface PageResult {
  pageName: string;
  checks: TestCheck[];
  passCount: number;
  failCount: number;
  totalCount: number;
  passPercentage: number;
  duration?: number;
}

export interface TestResult {
  testName: string;
  status: 'PASS' | 'FAIL' | 'PARTIAL';
  startTime: string;
  endTime: string;
  duration: string;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  passPercentage: number;
  environment: {
    name: string;
    region: string;
    surfacingPoint: string;
  };
  device?: {
    platform: string;
    version: string;
    deviceType: string;
  };
  ppvEvent?: {
    name: string;
    eventDate: string;
    currency: string;
  };
  tierAndPlan?: {
    tier: string;
    billingCycle: string;
  };
  flow?: {
    name: string;
    steps: string[];
  };
  pageResults: PageResult[];
  failedTests: {
    page: string;
    check: string;
    expected: string;
    actual: string;
    screenshot?: string;
    failureReason?: string;
  }[];
  reportGeneratedAt?: string;
}

export interface ReportConfig {
  title?: string;
  logoUrl?: string;
  companyName?: string;
  footerText?: string;
  includeGraphs?: boolean;
  highlightFailures?: boolean;
  includeScreenshots?: boolean;
}
