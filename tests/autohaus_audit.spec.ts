/**
 * ============================================================================
 *  AUTOHAUS ROYAL GmbH — End-to-End Smoke & Exploratory Audit
 *  Target: https://www.autohaus-royal.de/
 * ============================================================================
 *
 *  Strategy
 *  --------
 *  This is a *production* site for a real dealership, so the suite is
 *  strictly read-only. The one destructive path that exists — the contact /
 *  vehicle-inquiry submission (POST /data/contact-request.php) — is
 *  intercepted by the safety guard in `src/fixtures.ts` and never reaches the
 *  server. Tests assert on *whether the app attempted* the submission, which
 *  is precisely what validation testing needs.
 *
 *  Assertion style
 *  ---------------
 *  `expect.soft` is used deliberately. An exploratory audit should surface
 *  every defect on a page in one run, not stop at the first one. Hard
 *  `expect` is reserved for preconditions that make the rest of a test
 *  meaningless (e.g. "the catalog rendered at least one card").
 *
 *  Every defect is additionally emitted via `recordFinding()` with an explicit
 *  business severity, which is what the Markdown reporter renders.
 */
import { devices, Page, APIRequestContext, Locator } from '@playwright/test';
import {
  test,
  expect,
  BASE_URL,
  ENDPOINTS,
  PageMonitor,
  installSafetyGuard,
  seedConsentCookie,
  dismissConsentIfPresent,
} from '../src/fixtures';
import { SEL, ROUTES } from '../src/selectors';
import { recordFinding, Severity } from '../src/findings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigates and returns the main-document HTTP status (0 if unavailable). */
async function gotoAndStatus(page: Page, path: string): Promise<number> {
  const response = await page.goto(`${BASE_URL}${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await dismissConsentIfPresent(page);
  return response?.status() ?? 0;
}

/**
 * Flushes whatever the monitor collected into findings.
 * Called at the end of navigation-style tests so every page contributes its
 * console + network evidence to the report.
 */
async function reportMonitorNoise(
  testInfo: Parameters<typeof recordFinding>[0],
  monitor: PageMonitor,
  context: { pageName: string; url: string },
): Promise<void> {
  for (const err of monitor.consoleErrors) {
    await recordFinding(testInfo, {
      // An uncaught exception breaks downstream JS; a logged console error may not.
      severity: err.type === 'pageerror' ? 'Major' : 'Minor',
      title:
        err.type === 'pageerror'
          ? `Uncaught JavaScript exception on ${context.pageName}`
          : `Browser console error on ${context.pageName}`,
      url: err.url || context.url,
      detail: 'Captured via page.on("pageerror") / page.on("console").',
      evidence: `${err.text}${err.location ? `\n  at ${err.location}` : ''}`,
    });
  }

  for (const fail of monitor.networkFailures) {
    // A failed document/xhr/fetch breaks a feature; a failed image degrades it.
    const severity =
      fail.resourceType === 'document' || fail.status >= 500
        ? 'Critical'
        : fail.resourceType === 'xhr' || fail.resourceType === 'fetch'
          ? 'Major'
          : 'Minor';
    await recordFinding(testInfo, {
      severity,
      title: `HTTP ${fail.status} on ${fail.resourceType} request (${context.pageName})`,
      url: fail.url,
      detail: `Requested from ${fail.pageUrl}`,
      evidence: `${fail.method} ${fail.url} → ${fail.status} ${fail.statusText}`,
    });
  }
}

/** Reads `naturalWidth`/`naturalHeight` for a set of images. */
async function inspectImages(scope: Locator) {
  return scope.evaluateAll((nodes) =>
    (nodes as HTMLImageElement[]).map((img) => ({
      src: img.currentSrc || img.src,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      alt: img.getAttribute('alt'),
      displayed: img.offsetParent !== null || getComputedStyle(img).display !== 'none',
    })),
  );
}

/** Do two bounding boxes overlap by more than `tolerance` px in both axes? */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  tolerance = 2,
): boolean {
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return xOverlap > tolerance && yOverlap > tolerance;
}

/**
 * Extracts the facts a buyer needs from a vehicle card, independently of which
 * of the site's two card templates is currently rendered. Brand/model come
 * from their semantic classes (stable across both), price and mileage are
 * parsed from the card's rendered text.
 */
async function readCardFacts(card: Locator) {
  const text = ((await card.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
  const readClass = async (cls: string) =>
    ((await card.locator(cls).first().innerText().catch(() => '')) ?? '').trim();

  return {
    text,
    manufacturer: await readClass('.manufacturer'),
    model: await readClass('.model'),
    /** e.g. "20.880,00 €" */
    price: text.match(/[\d.]+,\d{2}\s*€|\d[\d.]*\s*€/)?.[0] ?? '',
    /** e.g. "94.963 km" */
    mileage: text.match(/[\d.]+\s*km/i)?.[0] ?? '',
  };
}

/** Selects an option on the Nth `select.filter-param` and waits for the AJAX round-trip. */
async function applyCatalogFilter(page: Page, filterIndex: number, value: string): Promise<number> {
  const responsePromise = page.waitForResponse(
    (res) => res.url().includes(ENDPOINTS.filter) && res.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await page.locator(SEL.catalog.filterSelect).nth(filterIndex).selectOption(value);
  const response = await responsePromise;
  // The list re-renders asynchronously after the response resolves.
  await page.waitForTimeout(1_000);
  return response.status();
}

// ===========================================================================
// 1. CORE PAGE NAVIGATION & HEALTH CHECKS  (TC-01 … TC-05)
// ===========================================================================

test.describe('1. Core page navigation & health', () => {
  for (const route of ROUTES) {
    test(`${route.id} ${route.name} loads without HTTP or JavaScript errors`, async ({
      auditPage,
      monitor,
    }, testInfo) => {
      const status = await gotoAndStatus(auditPage, route.path);
      const url = auditPage.url();

      // --- Main document must return 2xx/3xx -------------------------------
      if (status >= 400 || status === 0) {
        await recordFinding(testInfo, {
          severity: 'Critical',
          title: `${route.name} is unreachable (HTTP ${status || 'no response'})`,
          url,
          detail: 'Primary navigation target failed to serve a successful document response.',
          evidence: `GET ${BASE_URL}${route.path} → ${status}`,
        });
      }
      expect.soft(status, `${route.name} document status`).toBeLessThan(400);

      // --- Page must actually render content -------------------------------
      const bodyText = ((await auditPage.locator('body').innerText()) ?? '').trim();
      if (bodyText.length < 50) {
        await recordFinding(testInfo, {
          severity: 'Critical',
          title: `${route.name} renders a blank/near-empty page`,
          url,
          detail: `document.body innerText length = ${bodyText.length} characters.`,
        });
      }
      expect.soft(bodyText.length, `${route.name} body content length`).toBeGreaterThan(50);

      // --- Global chrome must be present -----------------------------------
      await expect.soft(auditPage.locator(SEL.layout.header)).toBeVisible();
      await expect.soft(auditPage.locator(SEL.layout.topNav)).toBeAttached();

      // --- Title must be meaningful ----------------------------------------
      const title = await auditPage.title();
      if (!title || title.trim().length < 5) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: `${route.name} has a missing or non-descriptive <title>`,
          url,
          detail: `Actual title: "${title}"`,
        });
      }

      // Let the page settle so late-firing XHR/console errors are captured.
      await auditPage
        .waitForLoadState('networkidle', { timeout: 15_000 })
        .catch(() => { /* long-polling / slideshow keeps the network busy — acceptable */ });

      await reportMonitorNoise(testInfo, monitor, { pageName: route.name, url });

      expect
        .soft(
          monitor.consoleErrors.filter((e) => e.type === 'pageerror'),
          `Uncaught JS exceptions on ${route.name}`,
        )
        .toEqual([]);
      expect
        .soft(
          monitor.networkFailures.filter((f) => f.status >= 500),
          `5xx responses on ${route.name}`,
        )
        .toEqual([]);
    });
  }
});

// ===========================================================================
// 2. INVENTORY SEARCH & FILTER VALIDATION  (TC-06 … TC-08)
// ===========================================================================

test.describe('2. Inventory search & filters', () => {
  test('TC-06 Catalog renders vehicle inventory on first load', async ({ auditPage, monitor }, testInfo) => {
    await gotoAndStatus(auditPage, '/fahrzeuge');
    const url = auditPage.url();

    const cards = auditPage.locator(SEL.catalog.card);
    await expect(cards.first(), 'At least one vehicle card must render').toBeVisible({ timeout: 25_000 });

    const count = await cards.count();
    if (count === 0) {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: 'Vehicle catalog renders zero results on unfiltered load',
        url,
        detail: 'The unfiltered inventory page is the primary conversion surface; an empty state here is a revenue-blocking defect.',
      });
    }

    // Filter sidebar must be usable.
    const filterCount = await auditPage.locator(SEL.catalog.filterSelect).count();
    expect.soft(filterCount, 'Number of dropdown filters in the sidebar').toBeGreaterThanOrEqual(5);

    // Cards must carry the data a buyer needs to make a decision.
    const facts = await readCardFacts(cards.first());
    for (const [label, value] of Object.entries({
      manufacturer: facts.manufacturer,
      model: facts.model,
      price: facts.price,
      mileage: facts.mileage,
    })) {
      if (!value) {
        await recordFinding(testInfo, {
          severity: 'Major',
          title: `Vehicle card is missing its ${label} value`,
          url,
          detail: `The first result card renders no ${label}. A listing without this data cannot be evaluated by a buyer.`,
          evidence: `Rendered card text: "${facts.text.slice(0, 200)}"`,
        });
      }
      expect.soft(value, `First card ${label}`).not.toBe('');
    }

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Vehicle Catalog', url });
  });

  test('TC-07 Manufacturer filter updates results without breaking the list', async ({
    auditPage,
    monitor,
  }, testInfo) => {
    await gotoAndStatus(auditPage, '/fahrzeuge');
    const url = auditPage.url();

    await expect(auditPage.locator(SEL.catalog.card).first()).toBeVisible({ timeout: 25_000 });
    const baselineCount = await auditPage.locator(SEL.catalog.card).count();

    // Pick a manufacturer that the sidebar actually offers, so the test does
    // not go stale when stock rotates.
    const manufacturerSelect = auditPage.locator(SEL.catalog.filterSelect).first();
    const options = await manufacturerSelect.locator('option').evaluateAll((nodes) =>
      (nodes as HTMLOptionElement[]).map((o) => ({ value: o.value, label: o.text.trim() })),
    );
    const target = options.find((o) => o.value === 'BMW') ?? options.find((o) => o.value !== '0');
    expect(target, 'Manufacturer filter must expose at least one selectable brand').toBeTruthy();

    // --- Apply the filter and assert the backing API succeeded -------------
    const status = await applyCatalogFilter(auditPage, 0, target!.value);
    if (status >= 400) {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: `Vehicle search API returned HTTP ${status}`,
        url,
        detail: `POST ${ENDPOINTS.filter} failed while filtering by manufacturer "${target!.label}". Search is unusable.`,
        evidence: `POST ${BASE_URL}${ENDPOINTS.filter} → ${status}`,
      });
    }
    expect.soft(status, 'Vehicle search API status').toBeLessThan(400);

    // --- Results must be non-empty AND correctly filtered ------------------
    const filteredCards = auditPage.locator(SEL.catalog.card);
    const filteredCount = await filteredCards.count();

    if (filteredCount === 0) {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: `Filtering by "${target!.label}" produced an empty result list`,
        url,
        detail: `Baseline (unfiltered) list had ${baselineCount} vehicles. The brand is offered by the filter itself, so zero results indicates a broken query, not genuinely empty stock.`,
      });
    }
    expect.soft(filteredCount, `Result count after filtering by ${target!.label}`).toBeGreaterThan(0);

    // Every returned card must match the selected brand — this catches the
    // classic "filter renders but query is ignored" regression.
    if (filteredCount > 0) {
      const brands = await auditPage
        .locator(SEL.catalog.cardManufacturer)
        .evaluateAll((nodes) => [...new Set(nodes.map((n) => (n.textContent ?? '').trim().toUpperCase()))]);
      const mismatched = brands.filter((b) => b !== target!.value.toUpperCase());
      if (mismatched.length) {
        await recordFinding(testInfo, {
          severity: 'Critical',
          title: `Manufacturer filter is not applied to the returned results`,
          url,
          detail: `Selected "${target!.label}" but the result list also contains: ${mismatched.join(', ')}.`,
          evidence: `Expected only ["${target!.value.toUpperCase()}"], got ${JSON.stringify(brands)}`,
        });
      }
      expect.soft(mismatched, 'Brands present in a brand-filtered result list').toEqual([]);
    }

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Vehicle Catalog (filtered)', url });
  });

  test('TC-08 Over-constrained filter combination shows a proper empty state, not a blank page', async ({
    auditPage,
    monitor,
  }, testInfo) => {
    await gotoAndStatus(auditPage, '/fahrzeuge');
    const url = auditPage.url();
    await expect(auditPage.locator(SEL.catalog.card).first()).toBeVisible({ timeout: 25_000 });

    // Deliberately contradictory: cheapest price band + newest registration year.
    const selects = auditPage.locator(SEL.catalog.filterSelect);
    const total = await selects.count();

    // Price filter is the last dropdown; registration date has a stable id.
    await applyCatalogFilter(auditPage, total - 1, '10000-').catch(() => 0);
    const regDate = auditPage.locator('#erstzullasung-dropdown');
    if (await regDate.count()) {
      const responsePromise = auditPage
        .waitForResponse((r) => r.url().includes(ENDPOINTS.filter), { timeout: 20_000 })
        .catch(() => null);
      await regDate.selectOption('2026+').catch(() => {});
      await responsePromise;
      await auditPage.waitForTimeout(1_000);
    }

    const cardCount = await auditPage.locator(SEL.catalog.card).count();
    const resultsText = ((await auditPage.locator(SEL.catalog.resultsContainer).first().innerText().catch(() => '')) ?? '').trim();
    const pageText = ((await auditPage.locator('body').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');

    /**
     * The site does communicate emptiness — but only via the sidebar counter
     * ("0 Fahrzeug(e) gefunden"), not inside the results column. We grade those
     * two situations differently rather than reporting a blanket defect.
     */
    const hasZeroCounter = /\b0\s+Fahrzeug\(e\)\s+gefunden/i.test(pageText);
    const resultsRegionSpeaks = resultsText.length >= 10;

    if (cardCount === 0 && !hasZeroCounter && !resultsRegionSpeaks) {
      // Nothing anywhere on the page tells the user what happened.
      await recordFinding(testInfo, {
        severity: 'Major',
        title: 'Zero-result search gives the user no feedback at all',
        url,
        detail:
          'Applying a contradictory but legitimate filter combination (price ≤ €10.000 + first registration from 2026) empties the page with no counter and no message. Users cannot tell whether the site is broken or simply has no matching stock.',
        evidence: `Cards rendered: 0 · results container text length: ${resultsText.length} · zero-counter present: no`,
      });
    } else if (cardCount === 0 && hasZeroCounter && !resultsRegionSpeaks) {
      // Feedback exists, but not where the user is looking.
      await recordFinding(testInfo, {
        severity: 'Minor',
        title: 'Zero-result state is only signalled by the sidebar counter, not in the results area',
        url,
        detail:
          'With price ≤ €10.000 + first registration from 2026 the result column goes completely blank. The only feedback is the "0 Fahrzeug(e) gefunden" counter in the filter sidebar. An explicit "Keine Fahrzeuge gefunden — bitte Filter anpassen" message in the (now empty) results column, ideally with a reset-filters action, would remove the ambiguity.',
        evidence: `Cards rendered: 0 · results container text length: ${resultsText.length} · sidebar counter reads "0 Fahrzeug(e) gefunden"`,
      });
    }

    // The page must never be *silently* empty.
    expect
      .soft(
        cardCount > 0 || hasZeroCounter || resultsRegionSpeaks,
        'Zero-result state communicates something to the user',
      )
      .toBe(true);

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Vehicle Catalog (zero-result)', url });
  });
});

// ===========================================================================
// 3. VEHICLE DETAIL PAGE (VDP)  (TC-09 … TC-12)
// ===========================================================================

test.describe('3. Vehicle Detail Page', () => {
  /** Opens the catalog and clicks through to the first vehicle's VDP. */
  async function openFirstVdp(page: Page): Promise<string> {
    await gotoAndStatus(page, '/fahrzeuge');
    const firstCard = page.locator(SEL.catalog.card).first();
    await expect(firstCard, 'Catalog must render a card before we can open a VDP').toBeVisible({
      timeout: 25_000,
    });
    await Promise.all([
      page.waitForURL(/\/detail\//, { timeout: 25_000 }),
      firstCard.click(),
    ]);
    await page.waitForLoadState('domcontentloaded');
    /**
     * The VDP ships as an empty shell; `.head-data` is populated client-side
     * once the vehicle payload arrives. Without this wait every assertion below
     * would race the hydration and report phantom "missing element" defects.
     */
    await page
      .locator(SEL.vdp.headData)
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => { /* genuinely absent — the assertions below will report it */ });
    return page.url();
  }

  test('TC-09 Clicking a vehicle card navigates to its detail page', async ({ auditPage, monitor }, testInfo) => {
    let vdpUrl = '';
    try {
      vdpUrl = await openFirstVdp(auditPage);
    } catch (error) {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: 'Vehicle card click does not navigate to the Vehicle Detail Page',
        url: auditPage.url(),
        detail: 'The card-to-VDP transition is the core funnel step from browsing to enquiry. A failure here blocks every downstream conversion.',
        evidence: String(error),
      });
      throw error;
    }

    expect.soft(vdpUrl, 'VDP URL shape').toMatch(/\/detail\/[\w-]+/);
    await reportMonitorNoise(testInfo, monitor, { pageName: 'Vehicle Detail Page', url: vdpUrl });
  });

  test('TC-10 VDP shows title, price, specifications and a contact CTA', async ({ auditPage, monitor }, testInfo) => {
    const vdpUrl = await openFirstVdp(auditPage);

    const criticalElements: Array<{ label: string; locator: Locator; severity: Severity }> = [
      { label: 'Manufacturer (car title)', locator: auditPage.locator(SEL.vdp.manufacturer), severity: 'Critical' },
      { label: 'Model (car title)', locator: auditPage.locator(SEL.vdp.model), severity: 'Critical' },
      { label: 'Gross price', locator: auditPage.locator(SEL.vdp.priceGross), severity: 'Critical' },
      { label: 'Internal vehicle number', locator: auditPage.locator(SEL.vdp.internalNumber), severity: 'Minor' },
      { label: 'Technical specification tabs', locator: auditPage.locator(SEL.vdp.tabsRoot), severity: 'Major' },
    ];

    for (const { label, locator, severity } of criticalElements) {
      // Auto-waiting check — tolerates the VDP's asynchronous hydration.
      const visible = await locator
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      const text = visible ? (await locator.first().innerText().catch(() => '')).trim() : '';
      if (!visible || !text) {
        await recordFinding(testInfo, {
          severity,
          title: `VDP is missing "${label}"`,
          url: vdpUrl,
          detail: visible
            ? `Element is present but renders empty text.`
            : `Element did not render at all.`,
        });
      }
      expect.soft(visible, `VDP element visible: ${label}`).toBe(true);
    }

    // Price must be a parseable currency value, not a placeholder.
    const priceText = (await auditPage.locator(SEL.vdp.priceGross).first().innerText().catch(() => '')).trim();
    if (priceText && !/\d/.test(priceText)) {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: 'VDP price contains no numeric value',
        url: vdpUrl,
        detail: `Rendered price text: "${priceText}"`,
      });
    }

    // --- Specification tabs must all be reachable -------------------------
    const tabs = auditPage.locator(SEL.vdp.tabHeaders);
    const tabLabels = await tabs.allInnerTexts();
    expect.soft(tabLabels.length, 'Number of VDP tabs').toBeGreaterThanOrEqual(3);

    const panel = auditPage.locator(`${SEL.vdp.tabsRoot} > .body`);
    for (let i = 0; i < tabLabels.length; i++) {
      const label = tabLabels[i].trim();
      await tabs.nth(i).click();
      await auditPage.waitForTimeout(800);
      // A panel is "populated" if it renders text OR media (the Bilder tab is
      // legitimately image-only and carries almost no text).
      const panelText = (await panel.innerText().catch(() => '')).trim();
      const panelMedia = await panel.locator('img, iframe, video').count().catch(() => 0);
      if (panelText.length < 5 && panelMedia === 0) {
        await recordFinding(testInfo, {
          severity: 'Major',
          title: `VDP tab "${label}" renders an empty panel`,
          url: vdpUrl,
          detail: 'Selecting the tab leaves the content area blank, hiding specification data from the buyer.',
          evidence: `panel text length: ${panelText.length} · media elements: ${panelMedia}`,
        });
      }
      expect.soft(panelText.length > 4 || panelMedia > 0, `VDP tab "${label}" has content`).toBe(true);
    }

    // --- Primary CTA: the "Anfrage" (inquiry) form ------------------------
    const anfrageTab = tabs.filter({ hasText: /Anfrage/i });
    if (await anfrageTab.count()) {
      await anfrageTab.first().click();
      await expect
        .soft(auditPage.locator(SEL.requestForm.submit).first(), 'Primary CTA "Anfrage absenden" is visible')
        .toBeVisible();
    } else {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: 'VDP exposes no inquiry (Anfrage) CTA',
        url: vdpUrl,
        detail: 'There is no way for a visitor to contact the dealer about this vehicle from its detail page.',
      });
    }

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Vehicle Detail Page', url: vdpUrl });
  });

  test('TC-11 VDP gallery images actually load (naturalWidth > 0)', async ({ auditPage, monitor }, testInfo) => {
    const vdpUrl = await openFirstVdp(auditPage);

    const mainImage = auditPage.locator(SEL.vdp.galleryMainImage).first();
    await expect(mainImage, 'VDP must render a main gallery image').toBeVisible({ timeout: 20_000 });
    // Give the browser a beat to decode.
    await auditPage.waitForTimeout(1_500);

    const main = (await inspectImages(mainImage))[0];
    if (!main || main.naturalWidth === 0) {
      await recordFinding(testInfo, {
        severity: 'Critical',
        title: 'VDP main vehicle photo fails to load',
        url: vdpUrl,
        detail: 'The <img> element renders but decodes to naturalWidth = 0, i.e. a broken image. Vehicle photos are the primary purchase driver on a dealership VDP.',
        evidence: `src: ${main?.src ?? 'n/a'} · naturalWidth: ${main?.naturalWidth ?? 'n/a'}`,
      });
    }
    expect.soft(main?.naturalWidth ?? 0, 'Main gallery image naturalWidth').toBeGreaterThan(0);

    const thumbs = await inspectImages(auditPage.locator(SEL.vdp.galleryThumbs));
    const brokenThumbs = thumbs.filter((t) => t.naturalWidth === 0);
    if (brokenThumbs.length) {
      await recordFinding(testInfo, {
        severity: 'Major',
        title: `${brokenThumbs.length} of ${thumbs.length} gallery thumbnails are broken`,
        url: vdpUrl,
        detail: 'Thumbnails render as empty boxes, breaking gallery navigation.',
        evidence: brokenThumbs.slice(0, 5).map((t) => `naturalWidth=0 → ${t.src}`).join('\n'),
      });
    }
    expect.soft(brokenThumbs.length, 'Broken gallery thumbnails').toBe(0);

    // Accessibility: vehicle photos with no alt text.
    const missingAlt = [main, ...thumbs].filter((i) => i && (!i.alt || !i.alt.trim()));
    if (missingAlt.length) {
      await recordFinding(testInfo, {
        severity: 'Minor',
        title: `${missingAlt.length} gallery images have no alt attribute`,
        url: vdpUrl,
        detail: 'Screen-reader users get no description of the vehicle photos; also a lost image-SEO signal.',
      });
    }

    // Gallery navigation must advance the main image.
    const nextArrow = auditPage.locator(SEL.vdp.galleryNext).first();
    if ((await nextArrow.count()) && thumbs.length > 1) {
      const before = await mainImage.getAttribute('src');
      await nextArrow.click();
      await auditPage.waitForTimeout(1_000);
      const after = await mainImage.getAttribute('src');
      if (before === after) {
        await recordFinding(testInfo, {
          severity: 'Major',
          title: 'Gallery "next" arrow does not advance the main image',
          url: vdpUrl,
          detail: `Main image src is unchanged after clicking next (${thumbs.length} photos available).`,
          evidence: `src before and after: ${before}`,
        });
      }
      expect.soft(after, 'Main image src changes after clicking "next"').not.toBe(before);
    }

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Vehicle Detail Page (gallery)', url: vdpUrl });
  });

  test('TC-12 Inquiry form validation rejects empty and malformed input', async ({
    auditPage,
    monitor,
  }, testInfo) => {
    // Runs against /kontakt: identical markup and identical validation module
    // as the VDP "Anfrage" tab, but reachable in one navigation.
    await gotoAndStatus(auditPage, '/kontakt');
    const url = auditPage.url();

    const form = auditPage.locator(SEL.requestForm.root);
    await expect(form, 'Contact request form must be present').toBeVisible({ timeout: 20_000 });

    // ---- Case A: empty submission must be blocked client-side ------------
    monitor.blockedRequests.length = 0;
    await form.locator(SEL.requestForm.submit).click();
    await auditPage.waitForTimeout(1_200);

    if (monitor.blockedRequests.length > 0) {
      await recordFinding(testInfo, {
        severity: 'Major',
        title: 'Contact form submits an entirely empty request to the server',
        url,
        detail: 'Client-side validation did not block a submission with no name, no message and no contact details. This produces junk leads and is a spam vector.',
        evidence: `POST ${ENDPOINTS.contactRequest} was attempted (intercepted by the audit safety guard).`,
      });
    }
    expect.soft(monitor.blockedRequests.length, 'Submissions attempted for an empty form').toBe(0);

    const invalidFields = await form.locator(SEL.requestForm.invalidField).count();
    if (invalidFields === 0) {
      await recordFinding(testInfo, {
        severity: 'Major',
        title: 'Empty contact form submission produces no visible validation feedback',
        url,
        detail: `No field received the "${SEL.requestForm.invalidFieldClass}" error class after submitting an empty form. The user gets no indication of what to fix.`,
      });
    }
    expect.soft(invalidFields, 'Fields flagged as invalid after empty submit').toBeGreaterThan(0);

    // ---- Case B: malformed e-mail must be rejected ------------------------
    monitor.blockedRequests.length = 0;
    await form.locator(SEL.requestForm.name).fill('QA Audit Bot');
    await form.locator(SEL.requestForm.text).fill('Automated accessibility and validation check — please ignore.');
    await form.locator(SEL.requestForm.email).fill('not-an-email');
    await form.locator(SEL.requestForm.submit).click();
    await auditPage.waitForTimeout(1_500);

    const emailFlagged = await form
      .locator(SEL.requestForm.email)
      .evaluate((el, cls) => el.classList.contains(cls), SEL.requestForm.invalidFieldClass)
      .catch(() => false);
    const submittedWithBadEmail = monitor.blockedRequests.length > 0;

    if (submittedWithBadEmail && !emailFlagged) {
      await recordFinding(testInfo, {
        severity: 'Major',
        title: 'Contact form accepts a syntactically invalid e-mail address',
        url,
        detail:
          'Submitting "not-an-email" in the e-mail field passes validation and the request is sent. The dealership receives a lead it can never reply to, and the field uses type="text" so the browser\'s native e-mail validation is bypassed as well.',
        evidence: `POST ${ENDPOINTS.contactRequest} was attempted with email="not-an-email" (intercepted by the audit safety guard).`,
      });
    }
    expect
      .soft(emailFlagged || !submittedWithBadEmail, 'Malformed e-mail is rejected before submission')
      .toBe(true);

    // ---- Accessibility of the form itself --------------------------------
    const nativelyRequired = await form.locator('[required]').count();
    if (nativelyRequired === 0) {
      await recordFinding(testInfo, {
        severity: 'Minor',
        title: 'Contact form fields carry no `required` / `aria-required` attributes',
        url,
        detail: 'Mandatory fields are enforced only by a jQuery handler. Assistive technologies cannot announce which fields are mandatory, and validation is lost entirely if the script fails to load.',
      });
    }

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Contact form', url });
  });
});

// ===========================================================================
// 4. BROKEN LINK & RESOURCE CRAWLER  (TC-13, TC-14)
// ===========================================================================

test.describe('4. Link & resource integrity', () => {
  test('TC-13 Homepage internal links resolve without 4xx/5xx', async ({ auditPage, request }, testInfo) => {
    await gotoAndStatus(auditPage, '/start');
    const origin = new URL(BASE_URL).origin;

    const hrefs = await auditPage.locator('a[href]').evaluateAll((nodes) =>
      (nodes as HTMLAnchorElement[]).map((a) => ({
        href: a.getAttribute('href') ?? '',
        resolved: a.href,
        text: (a.textContent ?? '').trim().slice(0, 60),
      })),
    );

    // --- Malformed protocol links (mailto:// / tel: with spaces) ----------
    for (const link of hrefs) {
      if (/^mailto:\/\//i.test(link.href)) {
        await recordFinding(testInfo, {
          severity: 'Major',
          title: 'Malformed `mailto://` link — e-mail client may fail to open',
          url: auditPage.url(),
          detail: `RFC 6068 mailto URIs have no authority component; the correct form is "mailto:user@host", not "mailto://user@host". Several mail clients and mobile browsers refuse to handle the double-slash variant, silently breaking the contact path.`,
          evidence: `<a href="${link.href}">${link.text}</a>`,
        });
      }
      if (/^tel:/i.test(link.href) && /\s/.test(link.href)) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: 'tel: link contains unencoded whitespace',
          url: auditPage.url(),
          detail: 'RFC 3966 tel URIs must not contain raw spaces; some dialers truncate the number.',
          evidence: `<a href="${link.href}">${link.text}</a>`,
        });
      }
      if (link.href === '#' || link.href === '') {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: 'Placeholder link with empty or "#" href',
          url: auditPage.url(),
          detail: 'Dead anchor — clicking does nothing or jumps to the top of the page.',
          evidence: `<a href="${link.href}">${link.text}</a>`,
        });
      }
    }

    // --- Crawl unique internal HTTP(S) targets ----------------------------
    const internal = [
      ...new Set(
        hrefs
          .map((l) => l.resolved)
          .filter((h) => h.startsWith(origin))
          .map((h) => h.split('#')[0]),
      ),
    ];

    expect(internal.length, 'Homepage must expose internal links to crawl').toBeGreaterThan(0);

    const broken: string[] = [];
    // Bounded concurrency keeps the audit polite to a production host.
    const CONCURRENCY = 5;
    for (let i = 0; i < internal.length; i += CONCURRENCY) {
      const batch = internal.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (target) => ({ target, status: await checkUrl(request, target) })),
      );
      for (const { target, status } of results) {
        if (status >= 400 || status === 0) {
          broken.push(`${status || 'ERR'} ${target}`);
          await recordFinding(testInfo, {
            severity: status >= 500 ? 'Critical' : 'Major',
            title: `Broken internal link — HTTP ${status || 'connection error'}`,
            url: target,
            detail: `Linked from the homepage (${BASE_URL}/start).`,
            evidence: `GET ${target} → ${status || 'no response'}`,
          });
        }
      }
    }

    expect.soft(broken, `Broken internal links (of ${internal.length} crawled)`).toEqual([]);
    testInfo.annotations.push({ type: 'crawled', description: `${internal.length} internal links checked` });
  });

  test('TC-14 Homepage media and static assets load successfully', async ({ auditPage, monitor }, testInfo) => {
    await gotoAndStatus(auditPage, '/start');
    const url = auditPage.url();
    await auditPage.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await auditPage.waitForTimeout(1_500);

    const images = await inspectImages(auditPage.locator('img'));
    const brokenImages = images.filter((i) => i.displayed && i.naturalWidth === 0);

    if (brokenImages.length) {
      await recordFinding(testInfo, {
        severity: 'Major',
        title: `${brokenImages.length} of ${images.length} homepage images fail to render`,
        url,
        detail: 'Images are attached to the DOM and displayed but decode to naturalWidth = 0 (broken source).',
        evidence: brokenImages.slice(0, 8).map((i) => i.src).join('\n'),
      });
    }
    expect.soft(brokenImages.map((i) => i.src), 'Broken homepage images').toEqual([]);

    const missingAlt = images.filter((i) => i.displayed && (i.alt === null || !i.alt.trim()));
    if (missingAlt.length) {
      await recordFinding(testInfo, {
        severity: 'Minor',
        title: `${missingAlt.length} of ${images.length} homepage images have no alt text`,
        url,
        detail: 'WCAG 2.1 SC 1.1.1 (Non-text Content) requires a text alternative for meaningful images.',
        evidence: missingAlt.slice(0, 8).map((i) => i.src).join('\n'),
      });
    }

    await reportMonitorNoise(testInfo, monitor, { pageName: 'Homepage assets', url });
  });
});

/** HEAD first (cheap), fall back to GET for servers that reject HEAD. */
async function checkUrl(request: APIRequestContext, url: string): Promise<number> {
  try {
    const head = await request.head(url, { timeout: 20_000, failOnStatusCode: false });
    if (head.status() !== 405 && head.status() !== 501) return head.status();
  } catch {
    /* fall through to GET */
  }
  try {
    const get = await request.get(url, { timeout: 25_000, failOnStatusCode: false });
    return get.status();
  } catch {
    return 0;
  }
}

// ===========================================================================
// 5. RESPONSIVE / MOBILE VIEWPORT  (TC-15, TC-16)
// ===========================================================================

test.describe('5. Responsive design (iPhone 13 — 390×844)', () => {
  const iPhone13 = devices['iPhone 13'];

  /** Builds a fully instrumented mobile context. */
  async function mobileSession(browser: import('@playwright/test').Browser) {
    const monitor = new PageMonitor();
    const context = await browser.newContext({ ...iPhone13 });
    await seedConsentCookie(context);
    await installSafetyGuard(context, monitor);
    const page = await context.newPage();
    monitor.attach(page);
    return { context, page, monitor };
  }

  test('TC-15 No horizontal overflow on key pages at 390px width', async ({ browser }, testInfo) => {
    const { context, page, monitor } = await mobileSession(browser);
    try {
      for (const route of ['/start', '/fahrzeuge', '/kontakt']) {
        await gotoAndStatus(page, route);
        await page.waitForTimeout(1_500);

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          // Widest element that actually pokes past the viewport.
          offenders: [...document.querySelectorAll<HTMLElement>('body *')]
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { sel: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`, right: Math.round(r.right), width: Math.round(r.width) };
            })
            .filter((e) => e.right > window.innerWidth + 2 && e.width > 0)
            .sort((a, b) => b.right - a.right)
            .slice(0, 5),
        }));

        const overflow = metrics.scrollWidth - metrics.innerWidth;
        if (overflow > 3) {
          await recordFinding(testInfo, {
            severity: 'Major',
            title: `Horizontal scroll on mobile (${overflow}px overflow) — ${route}`,
            url: page.url(),
            detail: `document.scrollWidth (${metrics.scrollWidth}px) exceeds the 390px viewport, forcing sideways scrolling and clipping content.`,
            evidence: metrics.offenders.map((o) => `${o.sel} → right edge at ${o.right}px (width ${o.width}px)`).join('\n'),
          });
        }
        expect.soft(overflow, `Horizontal overflow on ${route}`).toBeLessThanOrEqual(3);
      }
      await reportMonitorNoise(testInfo, monitor, { pageName: 'Mobile viewport', url: page.url() });
    } finally {
      await context.close();
    }
  });

  test('TC-16 Mobile header, navigation and CTA are usable and do not overlap', async ({ browser }, testInfo) => {
    const { context, page, monitor } = await mobileSession(browser);
    try {
      await gotoAndStatus(page, '/start');
      await page.waitForTimeout(1_500);
      const url = page.url();

      // --- Header + logo must be visible --------------------------------
      await expect.soft(page.locator(SEL.layout.header), 'Mobile header is visible').toBeVisible();
      const logo = page.locator(SEL.layout.logo).first();
      const opener = page.locator(SEL.layout.mobileMenuOpener).first();

      const logoBox = await logo.boundingBox().catch(() => null);
      const openerBox = (await opener.count()) ? await opener.boundingBox().catch(() => null) : null;

      if (!openerBox) {
        await recordFinding(testInfo, {
          severity: 'Critical',
          title: 'Mobile navigation trigger (hamburger) is not rendered at 390px',
          url,
          detail: `Expected "${SEL.layout.mobileMenuOpener}" to be visible. Without it, mobile users cannot reach Fahrzeuge, Ankauf or Kontakt.`,
        });
      }
      expect.soft(openerBox, 'Mobile menu opener has a layout box').not.toBeNull();

      // --- Overlap check --------------------------------------------------
      if (logoBox && openerBox && overlaps(logoBox, openerBox)) {
        await recordFinding(testInfo, {
          severity: 'Major',
          title: 'Logo and mobile menu button overlap in the header',
          url,
          detail: 'Overlapping hit areas mean taps land on the wrong control.',
          evidence: `logo: ${JSON.stringify(logoBox)}\nmenu: ${JSON.stringify(openerBox)}`,
        });
      }

      // --- Tap target size (WCAG 2.5.8 / 24×24 CSS px minimum) ------------
      if (openerBox && (openerBox.width < 24 || openerBox.height < 24)) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: 'Mobile menu button is below the 24×24px minimum tap-target size',
          url,
          detail: 'WCAG 2.2 SC 2.5.8 (Target Size, Minimum).',
          evidence: `${Math.round(openerBox.width)}×${Math.round(openerBox.height)}px`,
        });
      }

      // --- The menu must actually open ------------------------------------
      if (openerBox) {
        await opener.click();
        // Mobile nav is its own list (#mobile-menu-items), not the desktop
        // top-level nav toggled visible.
        const mobileLinks = page.locator(SEL.layout.mobileMenuLinks);
        const navVisible = await mobileLinks
          .first()
          .waitFor({ state: 'visible', timeout: 5_000 })
          .then(() => true)
          .catch(() => false);

        if (!navVisible) {
          await recordFinding(testInfo, {
            severity: 'Critical',
            title: 'Mobile menu does not open when the hamburger is tapped',
            url,
            detail: 'Primary navigation is unreachable on mobile — every inventory and contact path is blocked.',
          });
        }
        expect.soft(navVisible, 'Navigation links become visible after tapping the menu').toBe(true);

        // The three primary journeys must all be reachable from the mobile menu.
        if (navVisible) {
          const labels = (await mobileLinks.allInnerTexts()).map((t) => t.trim().toLowerCase());
          for (const required of ['fahrzeuge', 'ankauf', 'kontakt']) {
            if (!labels.some((l) => l.includes(required))) {
              await recordFinding(testInfo, {
                severity: 'Major',
                title: `Mobile menu is missing the "${required}" entry`,
                url,
                detail: `Rendered mobile menu items: ${labels.join(', ')}`,
              });
            }
            expect.soft(labels.some((l) => l.includes(required)), `Mobile menu contains "${required}"`).toBe(true);
          }
        }
      }

      // --- Catalog: mobile uses a filter-first flow -----------------------
      // At ≤768px the catalog intentionally shows only the filter panel; the
      // result list is revealed by the "Ergebnis >" control. The test follows
      // that real flow instead of asserting cards are visible on load.
      await gotoAndStatus(page, '/fahrzeuge');
      await page.waitForTimeout(2_500);

      const revealResults = page.locator(SEL.catalog.paginationForward).first();
      const revealed = await revealResults
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);

      if (!revealed) {
        await recordFinding(testInfo, {
          severity: 'Critical',
          title: 'Mobile catalog offers no way to reach the search results',
          url: page.url(),
          detail: `Neither vehicle cards nor the "Ergebnis" reveal control ("${SEL.catalog.paginationForward}") are visible at 390px, leaving mobile users stuck on the filter panel.`,
        });
      }
      expect.soft(revealed, 'Mobile results-reveal control is available').toBe(true);

      if (revealed) {
        await revealResults.click();
        const firstCard = page.locator(SEL.catalog.card).first();
        await expect.soft(firstCard, 'Vehicle cards render after revealing results on mobile').toBeVisible({
          timeout: 25_000,
        });

        const cardBox = await firstCard.boundingBox().catch(() => null);
        const viewportWidth = page.viewportSize()?.width ?? 390;
        // A card narrower than ~60% of the viewport means the desktop
        // 4-column grid (.pure-u-1-4) leaked into the mobile breakpoint.
        if (cardBox && cardBox.width < viewportWidth * 0.6) {
          await recordFinding(testInfo, {
            severity: 'Major',
            title: 'Vehicle cards do not reflow to full width on mobile',
            url: page.url(),
            detail: `Card width is ${Math.round(cardBox.width)}px inside a ${viewportWidth}px viewport — the desktop 4-column grid is still applied, squeezing photos and prices into unreadable columns.`,
            evidence: JSON.stringify(cardBox),
          });
        }
        expect
          .soft(cardBox?.width ?? 0, 'Mobile vehicle card width')
          .toBeGreaterThanOrEqual(viewportWidth * 0.6);
      }

      await reportMonitorNoise(testInfo, monitor, { pageName: 'Mobile layout', url });
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
// 6. MARKUP / SEO HYGIENE  (TC-17)
// ===========================================================================

test.describe('6. Markup & SEO hygiene', () => {
  test('TC-17 Pages have a single H1, unique DOM ids and a meta description', async ({ auditPage }, testInfo) => {
    for (const route of ['/start', '/fahrzeuge', '/ankauf', '/kontakt']) {
      await gotoAndStatus(auditPage, route);
      const url = auditPage.url();

      const audit = await auditPage.evaluate(() => {
        const idCounts: Record<string, number> = {};
        document.querySelectorAll('[id]').forEach((el) => {
          idCounts[el.id] = (idCounts[el.id] ?? 0) + 1;
        });
        return {
          h1Count: document.querySelectorAll('h1').length,
          h1Text: [...document.querySelectorAll('h1')].map((h) => (h.textContent ?? '').trim()),
          duplicateIds: Object.entries(idCounts).filter(([, n]) => n > 1),
          metaDescription:
            document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content?.trim() ?? '',
          lang: document.documentElement.lang,
        };
      });

      if (audit.h1Count === 0) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: `No <h1> heading on ${route}`,
          url,
          detail: 'Every indexable page needs exactly one H1 for search ranking and for screen-reader landmark navigation (WCAG 2.4.6).',
        });
      } else if (audit.h1Count > 1) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: `Multiple <h1> headings on ${route} (${audit.h1Count})`,
          url,
          detail: `Headings found: ${audit.h1Text.join(' | ')}`,
        });
      }

      for (const [id, count] of audit.duplicateIds) {
        await recordFinding(testInfo, {
          severity: 'Major',
          title: `Duplicate DOM id "${id}" used ${count}× on ${route}`,
          url,
          detail:
            'Duplicate ids are invalid HTML. `document.getElementById` and jQuery `#id` selectors resolve only the first match, so any script or label bound to the later element silently targets the wrong control.',
          evidence: `id="${id}" appears ${count} times`,
        });
      }
      expect.soft(audit.duplicateIds, `Duplicate ids on ${route}`).toEqual([]);

      if (!audit.metaDescription) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: `Missing meta description on ${route}`,
          url,
          detail: 'Search engines generate their own snippet, reducing click-through rate.',
        });
      }

      if (!audit.lang) {
        await recordFinding(testInfo, {
          severity: 'Minor',
          title: `<html> element has no lang attribute on ${route}`,
          url,
          detail: 'WCAG 3.1.1 (Language of Page) — screen readers cannot select the correct pronunciation rules.',
        });
      }
    }
  });
});
