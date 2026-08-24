/**
 * Instrumented test fixtures.
 *
 * Every page handed to a test already has:
 *   1. Console / pageerror / response listeners attached BEFORE the first
 *      navigation (so nothing that fires during initial load is missed).
 *   2. A safety route-guard that hard-blocks destructive or noise-generating
 *      requests (see SAFETY GUARD below).
 *   3. The cookie-consent decision pre-seeded to "essential only", so the
 *      consent overlay never intercepts clicks and we never opt the audit into
 *      third-party tracking.
 */
import { test as base, expect, Page, BrowserContext, ConsoleMessage } from '@playwright/test';

export const BASE_URL = process.env.BASE_URL ?? 'https://www.autohaus-royal.de';

/** Site endpoints discovered during reconnaissance of the live app. */
export const ENDPOINTS = {
  /** Vehicle search — returns the result list. */
  filter: '/data/filter.php',
  /** Facet counts for the filter sidebar. */
  group: '/data/group.php',
  /** Contact-page submission (/kontakt). NEVER allowed to reach the server. */
  contactRequest: '/data/contact-request.php',
  /**
   * VDP "Anfrage" tab submission. A DIFFERENT endpoint from the contact page:
   * `VehicleRequest` in scripts/detail.min.js posts here, while `ContactRequest`
   * in scripts/pages/kontakt.min.js posts to contact-request.php. Blocking only
   * one of the two leaves a live path to the dealership's sales inbox.
   * NEVER allowed to reach the server.
   */
  vehicleRequest: '/data/vehicle-request.php',
} as const;

/** Every endpoint that creates a real sales lead. All are hard-blocked. */
export const LEAD_ENDPOINTS: readonly string[] = [
  ENDPOINTS.contactRequest,
  ENDPOINTS.vehicleRequest,
];

/**
 * SAFETY GUARD
 * ------------
 * This suite runs against a LIVE production site belonging to a real business.
 *  - Every lead-creating endpoint (contact-request.php AND vehicle-request.php)
 *    is intercepted unconditionally: a passing test must never generate a real
 *    sales lead in the dealership's inbox. The two forms look identical and
 *    share their markup, but they post to different URLs.
 *  - Analytics/tag-manager hosts are aborted so the audit does not pollute the
 *    owner's GA4 / Ads conversion data.
 * Aborted URLs are recorded so tests can assert "the app *tried* to submit",
 * which is exactly what the form-validation tests need.
 */
const BLOCKED_HOST_PATTERNS = [
  /googletagmanager\.com/,
  /google-analytics\.com/,
  /analytics\.google\.com/,
  /doubleclick\.net/,
];

export interface ConsoleError {
  type: 'console' | 'pageerror';
  text: string;
  location?: string;
  url: string;
}

export interface NetworkFailure {
  url: string;
  status: number;
  statusText: string;
  method: string;
  resourceType: string;
  /** Page URL the request originated from. */
  pageUrl: string;
}

/** Per-test recorder of everything the browser complained about. */
export class PageMonitor {
  readonly consoleErrors: ConsoleError[] = [];
  readonly networkFailures: NetworkFailure[] = [];
  /** Requests intercepted by the safety guard, e.g. a blocked form submission. */
  readonly blockedRequests: { url: string; method: string; postData: string | null }[] = [];

  /** Console noise that is not worth reporting as a defect. */
  private static readonly IGNORED_CONSOLE = [
    /favicon/i,
    /net::ERR_BLOCKED_BY_CLIENT/i, // caused by our own safety guard
    /googletagmanager|google-analytics|doubleclick/i,
    /Failed to load resource: net::ERR_FAILED/i, // aborted-by-guard side effect
  ];

  /** Third-party/expected network noise that should not fail the audit. */
  private static readonly IGNORED_NETWORK = [
    /favicon\.ico/i,
    /googletagmanager|google-analytics|doubleclick|gstatic|google\.com\/maps/i,
  ];

  attach(page: Page): void {
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (PageMonitor.IGNORED_CONSOLE.some((re) => re.test(text))) return;
      const loc = msg.location();
      this.consoleErrors.push({
        type: 'console',
        text,
        location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
        url: page.url(),
      });
    });

    page.on('pageerror', (err) => {
      this.consoleErrors.push({
        type: 'pageerror',
        text: `${err.name}: ${err.message}`,
        location: err.stack?.split('\n').slice(0, 4).join(' | '),
        url: page.url(),
      });
    });

    page.on('response', (res) => {
      const status = res.status();
      if (status < 400) return;
      const url = res.url();
      if (PageMonitor.IGNORED_NETWORK.some((re) => re.test(url))) return;
      const req = res.request();
      this.networkFailures.push({
        url,
        status,
        statusText: res.statusText(),
        method: req.method(),
        resourceType: req.resourceType(),
        pageUrl: page.url(),
      });
    });
  }

  /** Formatted evidence block for the Markdown report. */
  errorDigest(): string {
    const lines: string[] = [];
    for (const e of this.consoleErrors) {
      lines.push(`[${e.type}] ${e.text}${e.location ? ` (${e.location})` : ''}`);
    }
    for (const n of this.networkFailures) {
      lines.push(`[HTTP ${n.status}] ${n.method} ${n.url}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.consoleErrors.length = 0;
    this.networkFailures.length = 0;
    this.blockedRequests.length = 0;
  }
}

/** Installs the safety guard on a context and wires blocked-request recording. */
export async function installSafetyGuard(context: BrowserContext, monitor: PageMonitor): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (LEAD_ENDPOINTS.some((endpoint) => url.includes(endpoint))) {
      monitor.blockedRequests.push({
        url,
        method: request.method(),
        postData: request.postData(),
      });
      // Answer with a realistic success payload so the page's success branch
      // still runs and we can assert on the resulting UI state.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, blockedBy: 'audit-safety-guard' }),
      });
      return;
    }

    if (BLOCKED_HOST_PATTERNS.some((re) => re.test(url))) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}

/**
 * Pre-seeds the consent decision (essential cookies only). The site reads
 * `CookieDecision_bitMap` and suppresses the overlay when it is present.
 */
export async function seedConsentCookie(context: BrowserContext): Promise<void> {
  const host = new URL(BASE_URL).hostname;
  await context.addCookies([
    { name: 'CookieDecision_bitMap', value: '1', domain: host, path: '/' },
    { name: 'CookieDecision_bitMap', value: '1', domain: `.${host.replace(/^www\./, '')}`, path: '/' },
  ]);
}

/**
 * Belt-and-braces: if the overlay still renders (e.g. cookie policy changed),
 * dismiss it with the privacy-preserving option, never "Accept all".
 */
export async function dismissConsentIfPresent(page: Page): Promise<void> {
  const essentialOnly = page.locator('#cb-buttonContainer .cb-button-secondary');
  if (await essentialOnly.count()) {
    try {
      await essentialOnly.first().click({ timeout: 3_000 });
    } catch {
      /* overlay disappeared on its own — nothing to do */
    }
  }
}

type AuditFixtures = {
  monitor: PageMonitor;
  auditPage: Page;
};

export const test = base.extend<AuditFixtures>({
  monitor: async ({}, use) => {
    await use(new PageMonitor());
  },

  auditPage: async ({ context, page, monitor }, use) => {
    await seedConsentCookie(context);
    await installSafetyGuard(context, monitor);
    monitor.attach(page); // attached before any navigation happens
    await use(page);
  },
});

export { expect };
