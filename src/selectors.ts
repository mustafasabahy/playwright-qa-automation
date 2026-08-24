/**
 * Selector contract for autohaus-royal.de.
 *
 * All selectors below were verified against the live DOM during
 * reconnaissance. The app is a jQuery/Backbone SSR site (no test ids), so we
 * anchor on semantic class names that carry meaning for the app itself and are
 * therefore unlikely to churn.
 *
 * Keeping them in one file means a markup change costs one edit, not fifteen.
 */
export const SEL = {
  layout: {
    header: 'header',
    logo: '#logo img',
    topNav: 'nav ul.top-level',
    topNavLinks: 'nav ul.top-level > li > a',
    mobileMenuOpener: '#mobile-menu-opener',
    /**
     * Mobile navigation is a *separate* list injected into the page body — it
     * is NOT the desktop `nav ul.top-level` toggled to visible. Asserting on
     * the desktop selector at 390px produces a false "menu never opens".
     */
    mobileMenuItems: '#mobile-menu-items',
    mobileMenuLinks: '#mobile-menu-items li a',
    footer: 'footer',
  },

  consent: {
    container: '#cb-buttonContainer',
    essentialOnly: '#cb-buttonContainer .cb-button-secondary',
  },

  catalog: {
    /** Sidebar container holding all dropdown filters. */
    filterSidebar: '#search-filter',
    /** Every dropdown filter shares this class (Hersteller, Modell, Karosserie, …). */
    filterSelect: 'select.filter-param',
    /** Equipment checkboxes (Automatik, Xenon, Leder, …). */
    accessoryCheckbox: 'input.check-acc',
    resultsContainer: '.content.results, #results',
    /** A single vehicle card. Not an <a> — navigation is JS-driven. */
    card: '.list-item[vehicle-id]',
    /**
     * NOTE: the catalog ships two different card templates and picks one at
     * runtime from `UTILS.screenIsSmall()/screenIsMedium()`:
     *   narrow → .pic-and-data > .vehicle-data > p.manufacturer|.model|.price|.mileage
     *   wide   → .header > .manufacturer|.model  +  .footer .footer-main span
     * Selectors below therefore match on the semantic class only, and the
     * numeric fields are validated from the card's text content instead of a
     * fixed element path. See `readCardFacts()` in the spec.
     */
    cardImage: '.list-item img',
    cardManufacturer: '.list-item .manufacturer',
    cardModel: '.list-item .model',
    paginationForward: '.results .forward',
  },

  vdp: {
    headData: '.head-data',
    manufacturer: '.manufacturer-and-model .manufacturer',
    model: '.manufacturer-and-model .model',
    internalNumber: '.vehicle-id .intno',
    priceGross: '.price.gross',
    priceNet: '.price.net',
    topEquipments: '.top-equipments',
    tabsRoot: '.tabs.vehicle',
    tabHeaders: '.tabs.vehicle > .head > div',
    galleryMainImage: '.images .main-picture img',
    galleryThumbs: '.images .thumbnails .img img',
    galleryNext: '.main-picture .next',
    galleryPrev: '.main-picture .prev',
  },

  /**
   * Shared by the VDP "Anfrage" tab and the standalone /kontakt page.
   *
   * The two mount points differ: /kontakt renders `#contact-request`, the VDP
   * renders `#detail .request-form`. The field ids are identical on both, but
   * the ROOT is not, so it matches either. They also post to DIFFERENT
   * endpoints (contact-request.php vs vehicle-request.php) - see ENDPOINTS.
   */
  requestForm: {
    root: '#contact-request, #detail .request-form',
    name: '#request-name',
    email: '#request-email',
    phone: '#request-phone',
    fax: '#request-fax',
    text: '#request-text',
    submit: '.button.send-request',
    /** Class the app adds to fields that failed validation. */
    invalidFieldClass: 'missing',
    invalidField: '.missing',
    missingHint: '.missing-hint',
    successMessage: '.send-successful',
  },
} as const;

/** Canonical routes under audit. */
export const ROUTES = [
  { id: 'TC-01', name: 'Home / Startseite', path: '/start' },
  { id: 'TC-02', name: 'Vehicle Catalog (Fahrzeuge)', path: '/fahrzeuge' },
  { id: 'TC-03', name: 'Vehicle Purchase (Ankauf)', path: '/ankauf' },
  { id: 'TC-04', name: 'Contact (Kontakt)', path: '/kontakt' },
  { id: 'TC-05', name: 'Legal Notice (Impressum)', path: '/impressum' },
] as const;
