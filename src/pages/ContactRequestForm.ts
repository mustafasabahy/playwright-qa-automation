/**
 * Contact / vehicle-enquiry form component (`#contact-request`).
 *
 * The same Backbone view is mounted on `/kontakt` and inside the VDP "Anfrage"
 * tab, so one component object covers both. Modelled as a component rather than
 * a page precisely because it is not tied to a single route.
 *
 * Two views implement the same contract and the same defect:
 *   /kontakt -> ContactRequest  (scripts/pages/kontakt.min.js) -> contact-request.php
 *   VDP tab  -> VehicleRequest  (scripts/detail.min.js)        -> vehicle-request.php
 *
 * Validation contract, read from both sources:
 *   - `name` must be non-empty
 *   - `text` must be non-empty
 *   - at least ONE of `email` / `phone` / `fax` must be non-empty
 *   - invalid fields receive the CSS class `missing`
 *   - NO format validation is applied to the email value  <-- the defect
 */
import type { Page, Locator } from '@playwright/test';
import { SEL } from '../selectors';
import { LEAD_ENDPOINTS } from '../fixtures';

export interface ContactFormData {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
}

/** What the application did when the submit button was pressed. */
export interface SubmissionAttempt {
  /** True when the app fired a POST to the submission endpoint. */
  submitted: boolean;
  /** Raw request body, when a submission was attempted. */
  payload: string | null;
  /** Field names the app flagged with the `missing` class. */
  invalidFields: string[];
  /** True when the app rendered its success state to the user. */
  successShown: boolean;
}

export class ContactRequestForm {
  readonly root: Locator;
  readonly name: Locator;
  readonly email: Locator;
  readonly phone: Locator;
  readonly message: Locator;
  readonly submitButton: Locator;
  readonly missingHint: Locator;
  readonly successMessage: Locator;

  constructor(private readonly page: Page) {
    // `.first()`: the root selector matches either mount point (see SEL.requestForm).
    this.root = page.locator(SEL.requestForm.root).first();
    this.name = page.locator(SEL.requestForm.name);
    this.email = page.locator(SEL.requestForm.email);
    this.phone = page.locator(SEL.requestForm.phone);
    this.message = page.locator(SEL.requestForm.text);
    this.submitButton = page.locator(SEL.requestForm.submit);
    this.missingHint = page.locator(SEL.requestForm.missingHint);
    this.successMessage = page.locator(SEL.requestForm.successMessage);
  }

  async fill(data: ContactFormData): Promise<void> {
    if (data.name !== undefined) await this.name.fill(data.name);
    if (data.email !== undefined) await this.email.fill(data.email);
    if (data.phone !== undefined) await this.phone.fill(data.phone);
    if (data.message !== undefined) await this.message.fill(data.message);
  }

  /**
   * Press submit and report what the application actually did.
   *
   * This is the heart of the form test. Asserting on the UI alone is not enough:
   * a form can show a success message without ever posting, and can post while
   * showing an error. So we watch the wire and the DOM at the same time.
   *
   * SAFETY: the request never reaches the dealership. The context-level route
   * guard in `fixtures.ts` intercepts BOTH lead endpoints (contact-request.php
   * for /kontakt, vehicle-request.php for the VDP) and fulfils them locally with
   * a synthetic 200, so the success branch still runs and stays assertable while
   * no real sales lead is ever created.
   */
  async submitAndCaptureAttempt(settleMs = 1_500): Promise<SubmissionAttempt> {
    let payload: string | null = null;
    let submitted = false;

    const onRequest = (request: { url(): string; postData(): string | null }): void => {
      if (LEAD_ENDPOINTS.some((endpoint) => request.url().includes(endpoint))) {
        submitted = true;
        payload = request.postData();
      }
    };

    this.page.on('request', onRequest);
    try {
      await this.submitButton.click();
      // The handler is synchronous, but the XHR and the re-render are not.
      await this.page.waitForTimeout(settleMs);
    } finally {
      this.page.off('request', onRequest);
    }

    return {
      submitted,
      payload,
      invalidFields: await this.invalidFieldNames(),
      successShown: await this.successMessage.isVisible().catch(() => false),
    };
  }

  /** Field ids the app marked invalid, e.g. `['request-name', 'request-text']`. */
  async invalidFieldNames(): Promise<string[]> {
    return this.page.$$eval(
      `${SEL.requestForm.root} .${SEL.requestForm.invalidFieldClass}`,
      (nodes) => nodes.map((n) => n.id || n.tagName.toLowerCase()),
    );
  }

  /** True when the app is showing its "please complete the form" hint. */
  async isValidationHintVisible(): Promise<boolean> {
    return this.missingHint.isVisible().catch(() => false);
  }
}
