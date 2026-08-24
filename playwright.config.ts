import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://www.autohaus-royal.de';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',

  /**
   * A production site under audit is slower and less predictable than a local
   * app: generous per-test budget, generous per-assertion budget.
   */
  timeout: 120_000,
  expect: { timeout: 15_000 },

  /**
   * Serial-ish by design. This suite hits a real dealership's production
   * server; four workers hammering /data/filter.php would be impolite and
   * would also make timing-sensitive AJAX assertions flaky.
   */
  fullyParallel: false,
  workers: IS_CI ? 2 : 3,

  /**
   * Never fail an audit *silently* because someone left a .only in.
   */
  forbidOnly: IS_CI,

  /**
   * One retry only. An audit's job is to report reality, so we deliberately do
   * not retry defects away — but a single retry filters out genuine network
   * blips against a remote host.
   */
  retries: 1,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'reports/raw-results.json' }],
    // Custom reporter → reports/AUDIT_REPORT.md
    ['./src/markdown-reporter.ts', { outputFile: 'reports/AUDIT_REPORT.md', targetUrl: BASE_URL }],
  ],

  use: {
    baseURL: BASE_URL,

    /** Evidence capture — everything needed to prove a defect. */
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    actionTimeout: 20_000,
    navigationTimeout: 45_000,

    /**
     * Identify the audit honestly in the access log. A production site owner
     * should be able to see what hit their server.
     */
    userAgent:
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/131.0.0.0 Safari/537.36 QA-Audit-Bot/1.0 (Playwright smoke test)`,

    /** German site — request German content explicitly. */
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' },

    ignoreHTTPSErrors: false,
  },

  projects: [
    {
      name: 'desktop-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    /**
     * Mobile coverage lives inside TC-15/TC-16, which build their own iPhone 13
     * context. That keeps the run to a single pass instead of duplicating all
     * 17 test cases across two projects against a production host.
     *
     * To run the whole suite under mobile emulation instead, uncomment:
     */
    // {
    //   name: 'mobile-safari',
    //   use: { ...devices['iPhone 13'] },
    // },
  ],
});
