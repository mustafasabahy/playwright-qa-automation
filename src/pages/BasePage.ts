/**
 * Shared behaviour for every page object.
 *
 * Deliberately thin: it owns navigation and the two cross-cutting concerns that
 * every page on this site shares (consent overlay, network settling). Anything
 * page-specific belongs in the subclass, not here.
 */
import type { Page, Response } from '@playwright/test';
import { dismissConsentIfPresent } from '../fixtures';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  /** Route this page object represents, e.g. `/fahrzeuge`. */
  abstract readonly path: string;

  /**
   * Navigate to this page and bring it to a state where a user could act on it.
   *
   * `domcontentloaded` rather than `networkidle`: the site polls analytics and
   * lazy-loads slideshow imagery, so `networkidle` is both slow and flaky here.
   * Readiness is asserted per-page instead, by the element that actually matters.
   */
  async goto(): Promise<Response | null> {
    const response = await this.page.goto(this.path, { waitUntil: 'domcontentloaded' });
    await dismissConsentIfPresent(this.page);
    return response;
  }

  /** Current URL path, without origin or query string. */
  currentPath(): string {
    return new URL(this.page.url()).pathname;
  }
}
