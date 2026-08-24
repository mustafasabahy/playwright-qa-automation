/**
 * Vehicle Detail Page (`/detail/<vehicle-id>`).
 *
 * The end of the browse funnel and the start of the lead funnel: everything a
 * buyer needs to decide, plus the enquiry form that turns them into a lead.
 * Four tabs (Bilder, Daten, Ausstattung, Anfrage) are rendered up front and
 * toggled client-side, so tab content exists in the DOM before it is visible.
 */
import type { Page, Locator } from '@playwright/test';
import { SEL } from '../selectors';
import { ContactRequestForm } from './ContactRequestForm';

/** VDP tabs, in render order. */
export const VDP_TABS = ['Bilder', 'Daten', 'Ausstattung', 'Anfrage'] as const;
export type VdpTab = (typeof VDP_TABS)[number];

/** One gallery image and whether the browser actually decoded it. */
export interface ImageHealth {
  src: string;
  naturalWidth: number;
  loaded: boolean;
}

export class VehicleDetailPage {
  readonly manufacturer: Locator;
  readonly model: Locator;
  readonly internalNumber: Locator;
  readonly priceGross: Locator;
  readonly tabHeaders: Locator;
  readonly galleryMainImage: Locator;
  readonly galleryThumbs: Locator;
  readonly galleryNext: Locator;

  /**
   * @param expectedVehicleId `vehicle-id` of the card that was clicked, when the
   *        VDP was reached through the funnel. Null on direct navigation.
   */
  constructor(
    private readonly page: Page,
    readonly expectedVehicleId: string | null = null,
  ) {
    this.manufacturer = page.locator(SEL.vdp.manufacturer);
    this.model = page.locator(SEL.vdp.model);
    this.internalNumber = page.locator(SEL.vdp.internalNumber);
    this.priceGross = page.locator(SEL.vdp.priceGross);
    this.tabHeaders = page.locator(SEL.vdp.tabHeaders);
    this.galleryMainImage = page.locator(SEL.vdp.galleryMainImage);
    this.galleryThumbs = page.locator(SEL.vdp.galleryThumbs);
    this.galleryNext = page.locator(SEL.vdp.galleryNext);
  }

  /** Vehicle id taken from the current URL, e.g. `685-394`. */
  vehicleIdFromUrl(): string | null {
    return new URL(this.page.url()).pathname.match(/\/detail\/(.+)$/)?.[1] ?? null;
  }

  /** Headline as a buyer reads it: manufacturer plus model. */
  async title(): Promise<string> {
    const [make, model] = await Promise.all([
      this.manufacturer.first().innerText(),
      this.model.first().innerText(),
    ]);
    return `${make.trim()} ${model.trim()}`.replace(/\s+/g, ' ').trim();
  }

  /** Gross price as displayed, e.g. `20.880,00 €`. */
  async price(): Promise<string> {
    return (await this.priceGross.first().innerText()).trim();
  }

  /** Visible tab labels, used to assert the spec sections are all present. */
  async tabLabels(): Promise<string[]> {
    return (await this.tabHeaders.allTextContents()).map((t) => t.trim()).filter(Boolean);
  }

  async openTab(tab: VdpTab): Promise<void> {
    await this.tabHeaders.filter({ hasText: tab }).first().click();
  }

  /**
   * Block until every gallery image has finished loading, successfully or not.
   *
   * `HTMLImageElement.complete` flips to true on BOTH success and error, so once
   * this resolves a `naturalWidth` of 0 means genuinely broken rather than
   * merely not-downloaded-yet. This replaces the usual arbitrary sleep, which
   * either flakes on a slow connection or wastes time on a fast one.
   *
   * Resolves rather than throwing on timeout: a stuck image IS the finding, and
   * `galleryImageHealth()` reports it with its src attached.
   */
  async waitForGalleryToSettle(timeoutMs = 15_000): Promise<void> {
    const selector = `${SEL.vdp.galleryMainImage}, ${SEL.vdp.galleryThumbs}`;
    await this.page
      .waitForFunction(
        (sel) => {
          const images = Array.from(document.querySelectorAll(sel)) as HTMLImageElement[];
          return images.length > 0 && images.every((img) => img.complete);
        },
        selector,
        { timeout: timeoutMs },
      )
      .catch(() => { /* timed out: galleryImageHealth() will report what is stuck */ });
  }

  /**
   * Decode state of every gallery image.
   *
   * `naturalWidth > 0` is the only reliable "did this image actually render"
   * signal. A broken <img> is still present, still visible and still has a src,
   * so DOM-presence assertions pass straight through the bug.
   */
  async galleryImageHealth(): Promise<ImageHealth[]> {
    const selector = `${SEL.vdp.galleryMainImage}, ${SEL.vdp.galleryThumbs}`;
    return this.page.$$eval(selector, (nodes) =>
      (nodes as HTMLImageElement[]).map((img) => ({
        src: img.currentSrc || img.src,
        naturalWidth: img.naturalWidth,
        loaded: img.complete && img.naturalWidth > 0,
      })),
    );
  }

  /** Open the "Anfrage" tab and return the enquiry form component. */
  async openInquiryForm(): Promise<ContactRequestForm> {
    await this.openTab('Anfrage');
    const form = new ContactRequestForm(this.page);
    await form.root.waitFor({ state: 'visible' });
    return form;
  }
}
