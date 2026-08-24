/**
 * ============================================================================
 *  REVENUE FUNNEL SMOKE SUITE
 *  Playwright + TypeScript
 * ============================================================================
 *
 *  WHAT THIS IS
 *  ------------
 *  The blocking CI gate. Guards the path from arrival to sales lead:
 *
 *    FS-01  Home + API health      Is the featured-vehicles endpoint alive?
 *    FS-02  Browse funnel          Catalog -> filter -> card -> detail page
 *    FS-03  Lead capture           Does the enquiry form reject bad input?
 *
 *  Each maps to a revenue step. If FS-01 fails the landing page is degraded;
 *  if FS-02 fails nobody can reach a vehicle; if FS-03 fails the dealership
 *  collects leads it cannot answer.
 *
 *  Kept deliberately small. A gate slow enough to be inconvenient is a gate
 *  that gets routed around. See docs/TEST_ARCHITECTURE.md.
 *
 *  PRODUCTION SAFETY
 *  -----------------
 *  This suite runs against the live site and is non-destructive by design:
 *    - POST /data/contact-request.php is intercepted and answered locally.
 *      No sales lead is ever created. (src/fixtures.ts, installSafetyGuard)
 *    - Analytics and tag-manager hosts are blocked so the audit never
 *      distorts the owner's conversion reporting.
 *    - Consent is pre-seeded to essential-only; the audit never opts in to
 *      third-party tracking.
 *
 *  KNOWN OPEN DEFECTS (see docs/FINDINGS.md)
 *  ----------------------------------------
 *    FS-01 FAILS  /data/topcars.php returns HTTP 500 on every request.
 *    FS-02 PASSES the browse funnel is healthy end to end.
 *    FS-03 FAILS  `not-an-email` passes validation and is submitted.
 * ============================================================================
 */
import { test, expect } from '../src/fixtures';
import { HomePage } from '../src/pages/HomePage';
import { CatalogPage, CatalogFilter } from '../src/pages/CatalogPage';
import { VDP_TABS } from '../src/pages/VehicleDetailPage';

/** Business framing attached to every test, so a failure explains its own cost. */
type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR';

function businessContext(severity: Severity, funnelStage: string, costOfFailure: string): void {
  test.info().annotations.push(
    { type: 'severity', description: severity },
    { type: 'funnel-stage', description: funnelStage },
    { type: 'cost-of-failure', description: costOfFailure },
  );
}

// ---------------------------------------------------------------------------
// FS-01 | ENTRY POINT + API HEALTH
// ---------------------------------------------------------------------------
test.describe('FS-01 | Entry point: homepage and featured-vehicles API', () => {
  test('homepage loads and /data/topcars.php returns a healthy response', async ({ auditPage, monitor }) => {
    businessContext(
      'CRITICAL',
      'Arrival',
      'The main merchandising slot on the landing page renders empty. Highlighted stock gets zero exposure to arriving traffic.',
    );

    const home = new HomePage(auditPage);

    // Arm the API watcher BEFORE navigating: this request fires during initial
    // page load, so a listener attached afterwards misses it entirely.
    const topCars = await home.gotoAndWatchTopCars();

    // --- Structural health -------------------------------------------------
    await expect(home.header, 'site header should render').toBeVisible();
    await expect(home.logo, 'logo should render').toBeVisible();
    expect(await home.navLinks.count(), 'primary nav should expose its top-level items').toBeGreaterThan(0);

    // --- API health --------------------------------------------------------
    // Soft assertions: we want the full picture in one run, not the first
    // failure. One run should surface every broken thing, not just the first.
    expect
      .soft(topCars.called, 'featured-vehicles endpoint should be called on page load')
      .toBe(true);

    if (topCars.called) {
      expect
        .soft(
          topCars.status,
          [
            `${HomePage.TOP_CARS_ENDPOINT} returned HTTP ${topCars.status}.`,
            'This is the featured-vehicles module on the highest-traffic page.',
            `Response body: ${(topCars.body ?? '').slice(0, 300) || '(empty)'}`,
          ].join('\n'),
        )
        .toBeLessThan(400);
    }

    // --- Collateral damage -------------------------------------------------
    // A failing XHR usually leaves console errors behind. Report them as
    // evidence rather than as a separate mystery failure.
    expect
      .soft(monitor.networkFailures, `failed requests on ${home.path}:\n${monitor.errorDigest()}`)
      .toHaveLength(0);
    expect
      .soft(monitor.consoleErrors, `console errors on ${home.path}:\n${monitor.errorDigest()}`)
      .toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FS-02 | CORE BROWSE FUNNEL
// ---------------------------------------------------------------------------
test.describe('FS-02 | Core funnel: catalog to vehicle detail page', () => {
  test('filter returns matching stock and a card opens its detail page', async ({ auditPage }) => {
    businessContext(
      'CRITICAL',
      'Browse and evaluate',
      'A buyer cannot find or open a vehicle. This is total loss of the browse funnel.',
    );

    const catalog = new CatalogPage(auditPage);
    await catalog.goto();
    await catalog.waitForResults();

    const unfilteredCount = await catalog.resultCount();
    expect(unfilteredCount, 'catalog should render inventory on first load').toBeGreaterThan(0);

    // --- Filter correctness ------------------------------------------------
    // Assert the API and the rendered result separately. When they disagree you
    // have found the highest-value catalog bug: the query ran, the UI ignored it.
    const filterStatus = await catalog.applyFilter(CatalogFilter.Manufacturer, 'BMW');
    expect(filterStatus, `${CatalogPage.FILTER_ENDPOINT} should return 2xx`).toBeLessThan(400);

    const filteredCount = await catalog.resultCount();
    expect(filteredCount, 'filtering by BMW should not empty the result list').toBeGreaterThan(0);

    const manufacturers = await catalog.renderedManufacturers();
    const offBrand = manufacturers.filter((m) => m.toUpperCase() !== 'BMW');
    expect(
      offBrand,
      `filter says BMW but these makes were rendered: ${[...new Set(offBrand)].join(', ')}`,
    ).toHaveLength(0);

    // --- Funnel handoff ----------------------------------------------------
    // Cards are div[vehicle-id], not anchors; navigation is JS-driven.
    const vdp = await catalog.openCard(0);
    expect(auditPage.url(), 'card click should land on a detail page').toContain('/detail/');
    expect(
      vdp.vehicleIdFromUrl(),
      'the detail page opened must be the card that was clicked',
    ).toBe(vdp.expectedVehicleId);

    // --- Detail page completeness -----------------------------------------
    const title = await vdp.title();
    const price = await vdp.price();

    expect(title, 'vehicle title should be populated').not.toHaveLength(0);
    expect(price, 'price should be formatted as EUR currency').toMatch(/\d[\d.,]*\s*€/);
    await expect(vdp.internalNumber, 'internal stock number should be shown').toBeVisible();

    const tabs = await vdp.tabLabels();
    for (const expectedTab of VDP_TABS) {
      expect(tabs, `spec tab "${expectedTab}" should be present`).toContain(expectedTab);
    }

    // --- Media health ------------------------------------------------------
    // naturalWidth is the only trustworthy "did it render" signal: a broken
    // <img> is still visible, still has a src, and passes DOM assertions.
    await vdp.waitForGalleryToSettle();
    const images = await vdp.galleryImageHealth();
    expect(images.length, 'VDP should ship a gallery').toBeGreaterThan(0);

    const broken = images.filter((img) => !img.loaded);
    expect(
      broken,
      `broken gallery images:\n${broken.map((b) => `  ${b.src} (naturalWidth=${b.naturalWidth})`).join('\n')}`,
    ).toHaveLength(0);

    test.info().annotations.push({ type: 'funnel-proof', description: `${title} at ${price}` });
  });
});

// ---------------------------------------------------------------------------
// FS-03 | LEAD CAPTURE
// ---------------------------------------------------------------------------
test.describe('FS-03 | Lead capture: enquiry form validation', () => {
  /**
   * The empty-form case is the control. It proves validation exists and runs,
   * which is what makes the malformed-email result below meaningful rather
   * than merely "the form does nothing".
   */
  test('empty submission is blocked and the invalid fields are flagged', async ({ auditPage }) => {
    businessContext(
      'MAJOR',
      'Lead capture',
      'Empty enquiries reach the sales inbox and cannot be actioned.',
    );

    const catalog = new CatalogPage(auditPage);
    await catalog.goto();
    await catalog.waitForResults();
    const vdp = await catalog.openCard(0);
    const form = await vdp.openInquiryForm();

    const attempt = await form.submitAndCaptureAttempt();

    expect(attempt.submitted, 'an empty enquiry must never be posted').toBe(false);
    expect(attempt.invalidFields, 'required fields should be flagged as missing').not.toHaveLength(0);
    expect(attempt.successShown, 'no success state should be shown for an empty form').toBe(false);
  });

  /**
   * The defect. Validation checks that the email field is non-empty and stops
   * there, so `not-an-email` is accepted and posted. The dealership receives a
   * lead with no reachable address, and the buyer is shown a success message
   * and waits for a call that can never come.
   *
   * Expressed as an assertion of correct behaviour, so it goes green the moment
   * the fix lands. That is what makes it a regression gate rather than a
   * snapshot of today's bug list.
   */
  test('malformed email address is rejected before submission', async ({ auditPage }) => {
    businessContext(
      'MAJOR',
      'Lead capture',
      'Unreachable leads are accepted silently. The buyer believes they made contact; the dealership cannot reply.',
    );

    const catalog = new CatalogPage(auditPage);
    await catalog.goto();
    await catalog.waitForResults();
    const vdp = await catalog.openCard(0);
    const form = await vdp.openInquiryForm();

    await form.fill({
      name: 'QA Automation Test',
      email: 'not-an-email', // no @, no domain
      message: 'Automated validation probe. Please ignore.',
    });

    const attempt = await form.submitAndCaptureAttempt();

    // Primary assertion: a malformed address must not reach the server.
    expect(
      attempt.submitted,
      [
        'A malformed email address was accepted and submitted.',
        `Payload: ${attempt.payload ?? '(none captured)'}`,
        'Root cause: the VehicleRequest view in scripts/detail.min.js checks only',
        'that the field is non-empty. No format validation runs, and the input is',
        'type="text", so native browser constraint validation never applies either.',
        'The ContactRequest view on /kontakt has the identical defect.',
      ].join('\n'),
    ).toBe(false);

    // Supporting assertions: the user should be told, not thanked.
    expect
      .soft(attempt.invalidFields, 'the email field should be flagged as invalid')
      .toContain('request-email');
    expect
      .soft(attempt.successShown, 'a success message must not follow a rejected submission')
      .toBe(false);
  });
});
