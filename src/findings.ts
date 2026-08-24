/**
 * Shared vocabulary for the audit.
 *
 * A "Finding" is a defect the suite observed. It is deliberately decoupled from
 * Playwright's pass/fail model: a test can PASS its hard assertions while still
 * emitting Minor findings (e.g. an SEO gap), and a single FAILED test can emit
 * several findings.
 *
 * Findings travel from the worker process to the reporter process as test
 * attachments. Attachments (unlike ad-hoc file writes) are race-free across
 * parallel workers and are part of Playwright's stable public API.
 */
import { TestInfo } from '@playwright/test';

/** Business impact, not technical noisiness. Drives the stakeholder-facing report. */
export type Severity = 'Critical' | 'Major' | 'Minor';

export interface Finding {
  /** Stable test-case id, e.g. "TC-05". */
  testId: string;
  /** Human-readable test case name. */
  testName: string;
  severity: Severity;
  /** One-line defect statement — what is broken, in user terms. */
  title: string;
  /** Where it happened. */
  url: string;
  /** Optional reproduction / evidence detail. */
  detail?: string;
  /** Raw console message, HTTP status line, or JS stack trace. */
  evidence?: string;
}

export const FINDING_ATTACHMENT = 'audit-finding';

/**
 * Records a finding against the currently running test.
 * Safe to call many times per test.
 */
export async function recordFinding(
  testInfo: TestInfo,
  finding: Omit<Finding, 'testId' | 'testName'> & { testId?: string; testName?: string },
): Promise<void> {
  const payload: Finding = {
    testId: finding.testId ?? extractTestId(testInfo.title),
    testName: finding.testName ?? testInfo.title,
    severity: finding.severity,
    title: finding.title,
    url: finding.url,
    detail: finding.detail,
    evidence: truncate(finding.evidence, 1200),
  };

  await testInfo.attach(FINDING_ATTACHMENT, {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(payload), 'utf-8'),
  });
}

/** "TC-05 Filter updates results" -> "TC-05"; falls back to "TC-??". */
export function extractTestId(title: string): string {
  const match = title.match(/\b(TC-\d+[a-z]?)\b/i);
  return match ? match[1].toUpperCase() : 'TC-??';
}

export function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}… [truncated]` : flat;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  Critical: 0,
  Major: 1,
  Minor: 2,
};
