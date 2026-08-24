/**
 * Home / Startseite (`/start`).
 *
 * Carries the featured-vehicles ("Top-Fahrzeuge") merchandising module, which
 * is populated asynchronously from `/data/topcars.php`. That endpoint is the
 * single highest-value thing to monitor on this site: it is on the highest-
 * traffic page, it fails silently in the UI, and it was returning HTTP 500
 * during the audit on 17 Aug 2026.
 */
import type { Page, Request, Response } from '@playwright/test';
import { BasePage } from './BasePage';
import { SEL } from '../selectors';

/** Outcome of watching a single API call, in a shape that reads well in an assertion. */
export interface ApiCallResult {
  /** False when the endpoint was never called at all. */
  called: boolean;
  status: number | null;
  method: string | null;
  url: string | null;
  /** Response body, when it could be read. Non-JSON or empty bodies come back as null. */
  body: string | null;
}

export class HomePage extends BasePage {
  readonly path = '/start';

  /** Endpoint that fills the featured-vehicles module. */
  static readonly TOP_CARS_ENDPOINT = '/data/topcars.php';

  readonly header = this.page.locator(SEL.layout.header);
  readonly logo = this.page.locator(SEL.layout.logo);
  readonly navLinks = this.page.locator(SEL.layout.topNavLinks);

  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate while watching the featured-vehicles API.
   *
   * The watcher is armed BEFORE `goto()`, because the request fires during
   * initial page load. Arming it afterwards is the classic way to miss the very
   * failure you are trying to catch.
   *
   * Resolves rather than throwing when the endpoint is never called, so the
   * test can distinguish "API returned 500" from "API was never invoked" and
   * report each precisely.
   */
  async gotoAndWatchTopCars(timeoutMs = 20_000): Promise<ApiCallResult> {
    const pending = this.page
      .waitForResponse((res) => res.url().includes(HomePage.TOP_CARS_ENDPOINT), { timeout: timeoutMs })
      .catch(() => null);

    await this.goto();

    const response: Response | null = await pending;
    if (!response) {
      return { called: false, status: null, method: null, url: null, body: null };
    }

    const request: Request = response.request();
    return {
      called: true,
      status: response.status(),
      method: request.method(),
      url: response.url(),
      // A 5xx often carries a PHP stack trace or error page; capture it as evidence.
      body: await response.text().catch(() => null),
    };
  }
}
