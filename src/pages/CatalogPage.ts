/**
 * Vehicle catalog (`/fahrzeuge`).
 *
 * Search is a Backbone view posting to `/data/filter.php`; the facet counts in
 * the sidebar come from `/data/group.php`. Nothing is server-rendered into the
 * result list, so every assertion here has to wait on the XHR rather than on
 * navigation.
 *
 * Vehicle cards are `div.list-item[vehicle-id]`, NOT anchors. Navigation to the
 * detail page is JS-driven (`window.location.href = '/detail/' + id`), which is
 * why `openCard()` waits for a URL change instead of a link click.
 */
import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { SEL } from '../selectors';
import { VehicleDetailPage } from './VehicleDetailPage';

/** Filter dropdowns in sidebar order, as rendered by the app. */
export enum CatalogFilter {
  Manufacturer = 0,
  Model = 1,
  BodyType = 2,
  Fuel = 3,
  FirstRegistration = 4,
  Mileage = 5,
  Price = 6,
}

export class CatalogPage extends BasePage {
  readonly path = '/fahrzeuge';

  /** Search endpoint. Asserting on its status separates "API broke" from "UI broke". */
  static readonly FILTER_ENDPOINT = '/data/filter.php';

  readonly sidebar = this.page.locator(SEL.catalog.filterSidebar);
  readonly filters = this.page.locator(SEL.catalog.filterSelect);
  readonly cards = this.page.locator(SEL.catalog.card);

  constructor(page: Page) {
    super(page);
  }

  /** Wait until the first result set has been rendered. */
  async waitForResults(timeoutMs = 30_000): Promise<void> {
    await this.cards.first().waitFor({ state: 'visible', timeout: timeoutMs });
  }

  /**
   * Apply one dropdown filter and wait for the search API round-trip it triggers.
   *
   * Returns the HTTP status of `/data/filter.php` so a caller can assert on the
   * API and the rendered result independently. When those two disagree you have
   * found the most valuable class of bug on a catalog page: the query succeeded
   * but the UI ignored it.
   */
  async applyFilter(filter: CatalogFilter, value: string, timeoutMs = 30_000): Promise<number> {
    const pending = this.page.waitForResponse(
      (res) => res.url().includes(CatalogPage.FILTER_ENDPOINT) && res.request().method() === 'POST',
      { timeout: timeoutMs },
    );

    await this.filters.nth(filter).selectOption(value);
    const response = await pending;

    // The Backbone view re-renders after the promise resolves; give it a beat
    // rather than asserting into a half-painted list.
    await this.page.waitForTimeout(750);
    return response.status();
  }

  /** Number of vehicle cards currently rendered. */
  async resultCount(): Promise<number> {
    return this.cards.count();
  }

  /** Manufacturer label of every rendered card, for filter-correctness assertions. */
  async renderedManufacturers(): Promise<string[]> {
    return (await this.page.locator(SEL.catalog.cardManufacturer).allTextContents())
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /**
   * Open a vehicle card and return the resulting detail page object.
   *
   * The card's `vehicle-id` attribute is read first so the test can assert that
   * the URL we land on belongs to the card we actually clicked, rather than
   * merely checking that some detail page opened.
   */
  async openCard(index = 0): Promise<VehicleDetailPage> {
    const card = this.cards.nth(index);
    await card.waitFor({ state: 'visible' });

    const vehicleId = await card.getAttribute('vehicle-id');
    await card.scrollIntoViewIfNeeded();
    await card.click();

    await this.page.waitForURL(/\/detail\//, { timeout: 30_000 });
    return new VehicleDetailPage(this.page, vehicleId);
  }
}
