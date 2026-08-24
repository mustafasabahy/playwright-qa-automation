# Autohaus Royal · QA Automation Suite

End-to-end test automation for **https://www.autohaus-royal.de/**, built with
[Playwright](https://playwright.dev/) and TypeScript.

The platform is server-rendered PHP with a jQuery/Backbone front end and JSON
form endpoints. On that stack most failures are invisible in the DOM: a `500`
with an empty body leaves a server-rendered container sitting there empty, and a
form can show a success message without ever posting. **This suite therefore
asserts on the network layer, not on appearance.**

---

## Quick start

```bash
npm ci
```

```bash
npx playwright install --with-deps chromium
```

Run the blocking gate (3 tests, under 2 minutes):

```bash
npm run test:smoke
```

Run the full audit (17 cases) and generate the report:

```bash
npm test
```

Point the suite at any environment:

```bash
BASE_URL=https://staging.example.com npm test
```

---

## Layout

```
src/
  selectors.ts          Single selector contract. The app ships no data-testid,
                        so selectors anchor on semantic class names.
  fixtures.ts           Instrumented page fixture: response/console/pageerror
                        listeners, production safety guard, consent seeding.
  findings.ts           Severity-graded finding model, decoupled from pass/fail.
  markdown-reporter.ts  Custom reporter -> reports/AUDIT_REPORT.md
  pages/                Page objects: Home, Catalog, VehicleDetail, RequestForm.

tests/
  funnel_smoke.spec.ts    3 tests. Blocking CI gate. Revenue funnel only.
  autohaus_audit.spec.ts  17 cases. Full audit, runs nightly.

docs/
  TEST_ARCHITECTURE.md  Design rationale and layer diagram.
  FINDINGS.md           Defects currently detected against production.
  architecture.mmd      Diagram source. Rebuild with `npm run diagram`.
```

---

## Production safety

The suite runs against a live commercial site and is non-destructive by construction.

- **No enquiry is ever delivered.** `contact-request.php` and `vehicle-request.php`
  are intercepted at browser-context level and fulfilled locally with a synthetic
  `200`, so the application's success branch still executes and stays assertable
  while nothing reaches the dealership. Both endpoints are guarded: the two forms
  share markup but post to different URLs.
- **No analytics pollution.** Tag manager, GA4 and DoubleClick hosts are blocked
  so runs do not distort conversion reporting.
- **Consent is essential-only.** The suite never opts in to third-party tracking.
- **Polite load.** Serial execution, low worker count, link checks batched.
- **Honest identification.** Requests identify as `QA-Audit-Bot/1.0` in the access log.

A permanent suite belongs on staging with seeded inventory. Production execution
is a stopgap, guarded as above.

---

## CI

`.github/workflows/qa-gate.yml` defines two jobs with different jobs to do.

| Job | Trigger | Runtime | Blocking |
| :--- | :--- | :---: | :---: |
| `smoke` | every pull request | < 2 min | **yes** |
| `audit` | nightly, 04:15 Europe/Berlin | ~3 min | no, reports only |

The nightly job exists because `topcars.php` did not break from a deploy. It broke
on its own, and a pull-request gate would never have caught it. Failing runs upload
trace, video and screenshot so a developer gets the diagnosis rather than a red cross.

---

## Test design notes

**Listeners are attached before the first navigation.** The highest-value endpoint
fires during page load; a listener attached afterwards misses it and reports health.

**Image checks use `naturalWidth > 0`.** A broken `<img>` is still present, still
visible and still has a `src`. Presence assertions pass straight through the defect.

**Form tests assert on the wire.** A form can render success without posting, and
can post while rendering an error. The test watches whether the POST fires.

**Filter tests assert API and UI separately.** When the two disagree you have found
the most valuable class of catalog bug: the query ran and the UI ignored it.

**Findings are decoupled from pass/fail.** A test can pass its hard assertions and
still emit Minor findings; one failed test can emit several. Findings travel to the
reporter as attachments, which is race-free across parallel workers.
