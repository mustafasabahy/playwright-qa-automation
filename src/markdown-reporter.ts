/**
 * Custom Playwright reporter → executive Markdown audit report.
 *
 * Reads two sources per test:
 *   1. `audit-finding` attachments  — explicit, severity-tagged defects.
 *   2. Playwright's own error output — for tests that crashed outright.
 *
 * Emits `reports/AUDIT_REPORT.md`, structured so the summary table can be
 * pasted straight into an e-mail without editing.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { Finding, FINDING_ATTACHMENT, Severity, SEVERITY_ORDER, extractTestId, truncate } from './findings';

type Status = 'PASSED' | 'FAILED' | 'FLAKY' | 'SKIPPED' | 'TIMED OUT';

interface TestRow {
  testId: string;
  title: string;
  status: Status;
  durationMs: number;
  findings: Finding[];
  /** Playwright's own failure message, if the test itself blew up. */
  runtimeError?: string;
}

interface ReporterOptions {
  outputFile?: string;
  targetUrl?: string;
}

export default class MarkdownAuditReporter implements Reporter {
  /**
   * Keyed by TestCase.id so a retry *replaces* its earlier attempt instead of
   * appearing twice. The report must describe the final state of each test
   * case, not the history of the run.
   */
  private rowsByTestId = new Map<string, TestRow>();
  private startedAt = Date.now();
  private readonly outputFile: string;
  private readonly targetUrl: string;

  constructor(options: ReporterOptions = {}) {
    this.outputFile = options.outputFile ?? path.join('reports', 'AUDIT_REPORT.md');
    this.targetUrl = options.targetUrl ?? process.env.BASE_URL ?? 'https://www.autohaus-royal.de';
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startedAt = Date.now();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const findings: Finding[] = [];
    for (const attachment of result.attachments) {
      if (attachment.name !== FINDING_ATTACHMENT || !attachment.body) continue;
      try {
        findings.push(JSON.parse(attachment.body.toString('utf-8')) as Finding);
      } catch {
        /* malformed attachment — ignore rather than crash the run */
      }
    }

    const runtimeError = result.errors.length
      ? result.errors
          .map((e) => stripAnsi(e.message ?? e.value ?? ''))
          .filter(Boolean)
          .join('\n---\n')
      : undefined;

    this.rowsByTestId.set(test.id, {
      testId: extractTestId(test.title),
      title: test.title,
      status: toStatus(test, result),
      durationMs: result.duration,
      findings,
      runtimeError: truncate(runtimeError, 1500),
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    const markdown = this.render(result);
    const outPath = path.resolve(this.outputFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf-8');

    // eslint-disable-next-line no-console
    console.log(`\n📄 Markdown audit report written to: ${outPath}\n`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(result: FullResult): string {
    // Stable ordering by test id, then severity.
    const rows = [...this.rowsByTestId.values()].sort((a, b) =>
      a.testId.localeCompare(b.testId, 'en', { numeric: true }),
    );
    const allFindings = rows.flatMap((r) => r.findings);
    const deduped = dedupe(allFindings);

    const counts: Record<Severity, number> = { Critical: 0, Major: 0, Minor: 0 };
    for (const f of deduped) counts[f.severity]++;

    const passed = rows.filter((r) => r.status === 'PASSED').length;
    const failed = rows.filter((r) => r.status === 'FAILED' || r.status === 'TIMED OUT').length;
    const durationMin = ((Date.now() - this.startedAt) / 60_000).toFixed(1);
    const runDate = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    const lines: string[] = [];

    // ---- Header -----------------------------------------------------------
    lines.push(`# QA Audit Report — Autohaus Royal GmbH`);
    lines.push('');
    lines.push(`**Target:** ${this.targetUrl}  `);
    lines.push(`**Run date:** ${runDate}  `);
    lines.push(`**Tooling:** Playwright + TypeScript (Chromium desktop 1440×900 · iPhone 13 emulation 390×844)  `);
    lines.push(`**Duration:** ${durationMin} min · **Overall result:** ${result.status.toUpperCase()}`);
    lines.push('');

    // ---- Executive summary ------------------------------------------------
    lines.push('## Executive summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Test cases executed | ${rows.length} |`);
    lines.push(`| Passed | ${passed} |`);
    lines.push(`| Failed | ${failed} |`);
    lines.push(`| **Total distinct issues found** | **${deduped.length}** |`);
    lines.push(`| 🔴 Critical | ${counts.Critical} |`);
    lines.push(`| 🟠 Major | ${counts.Major} |`);
    lines.push(`| 🟡 Minor | ${counts.Minor} |`);
    lines.push('');

    // ---- Test execution table --------------------------------------------
    lines.push('## Test execution overview');
    lines.push('');
    lines.push('| # | Test case | Status | Highest severity | Issues |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const top = highestSeverity(row.findings);
      lines.push(
        `| ${row.testId} | ${escapePipes(stripId(row.title))} | ${statusBadge(row.status)} | ${top ? severityBadge(top) : '—'} | ${row.findings.length} |`,
      );
    }
    lines.push('');

    // ---- Issue table (the stakeholder-facing artefact) ----------------------
    lines.push('## Defect log');
    lines.push('');
    if (deduped.length === 0) {
      lines.push('_No defects detected in this run._');
    } else {
      lines.push('| ID | Severity | Test case | Issue description | URL | Evidence |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      deduped
        .slice()
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
        .forEach((f, index) => {
          const id = `BUG-${String(index + 1).padStart(2, '0')}`;
          const description = [f.title, f.detail].filter(Boolean).join(' — ');
          lines.push(
            `| ${id} | ${severityBadge(f.severity)} | ${f.testId} | ${escapePipes(truncate(description, 400)!)} | ${linkCell(f.url)} | ${f.evidence ? `\`${escapePipes(truncate(f.evidence, 180)!)}\`` : '—'} |`,
          );
        });
    }
    lines.push('');

    // ---- Detailed appendix ------------------------------------------------
    lines.push('## Appendix — full evidence');
    lines.push('');
    for (const row of rows) {
      if (!row.findings.length && !row.runtimeError) continue;
      lines.push(`### ${row.testId} · ${stripId(row.title)} — ${statusBadge(row.status)}`);
      lines.push('');
      for (const f of row.findings) {
        lines.push(`- **[${f.severity}] ${f.title}**`);
        lines.push(`  - URL: ${f.url}`);
        if (f.detail) lines.push(`  - Impact: ${f.detail}`);
        if (f.evidence) {
          lines.push('  - Evidence:');
          lines.push('');
          lines.push('    ```');
          for (const evidenceLine of f.evidence.split('\n')) lines.push(`    ${evidenceLine}`);
          lines.push('    ```');
          lines.push('');
        }
      }
      if (row.runtimeError) {
        lines.push('- **Playwright failure output:**');
        lines.push('');
        lines.push('  ```text');
        for (const errLine of row.runtimeError.split('\n')) lines.push(`  ${errLine}`);
        lines.push('  ```');
        lines.push('');
      }
      lines.push('');
    }

    // ---- Methodology ------------------------------------------------------
    lines.push('## Methodology & scope notes');
    lines.push('');
    lines.push('- Runs against the **live production site**; the suite is strictly read-only.');
    lines.push('- `POST /data/contact-request.php` is intercepted by a route guard, so **no real enquiry is ever delivered** to the dealership. Form tests assert on whether the application *attempted* the submission.');
    lines.push('- Analytics and tag-manager requests are blocked so the audit does not distort the owner\'s reporting data.');
    lines.push('- Cookie consent is pre-set to **essential only** — the audit never opts into third-party tracking.');
    lines.push('');
    lines.push('**Severity definitions**');
    lines.push('');
    lines.push('| Severity | Definition |');
    lines.push('| --- | --- |');
    lines.push('| 🔴 Critical | Blocks a core user journey or loses revenue: page down, search broken, VDP unreachable, 5xx. |');
    lines.push('| 🟠 Major | A feature is degraded or produces wrong data, but a workaround exists. |');
    lines.push('| 🟡 Minor | Cosmetic, SEO or accessibility gap with no functional blockage. |');
    lines.push('');

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function toStatus(test: TestCase, result: TestResult): Status {
  if (result.status === 'skipped') return 'SKIPPED';
  if (result.status === 'timedOut') return 'TIMED OUT';
  if (result.status === 'passed') {
    return test.outcome() === 'flaky' ? 'FLAKY' : 'PASSED';
  }
  return 'FAILED';
}

function statusBadge(status: Status): string {
  switch (status) {
    case 'PASSED':
      return '✅ PASSED';
    case 'FLAKY':
      return '⚠️ FLAKY';
    case 'SKIPPED':
      return '⏭️ SKIPPED';
    case 'TIMED OUT':
      return '⏱️ TIMED OUT';
    default:
      return '❌ FAILED';
  }
}

function severityBadge(severity: Severity): string {
  return { Critical: '🔴 Critical', Major: '🟠 Major', Minor: '🟡 Minor' }[severity];
}

function highestSeverity(findings: Finding[]): Severity | null {
  if (!findings.length) return null;
  return findings.reduce<Severity>(
    (worst, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst] ? f.severity : worst),
    'Minor',
  );
}

/** Collapses identical defects reported from several pages/tests. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.severity}|${f.title}|${f.url}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

function stripId(title: string): string {
  return title.replace(/^TC-\d+[a-z]?\s*/i, '');
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function linkCell(url: string): string {
  if (!url) return '—';
  const short = url.replace(/^https?:\/\/(www\.)?/, '');
  return `[${escapePipes(short.length > 60 ? `${short.slice(0, 57)}…` : short)}](${url})`;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/g, '');
}
