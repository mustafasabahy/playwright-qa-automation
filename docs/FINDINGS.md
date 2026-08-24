# Findings

Defects detected by the suite against production. Regenerate with `npm test`.

Last full run: 17 August 2026. `topcars.php` re-verified 22 August 2026, still failing.

| Severity | Count |
| :--- | :---: |
| Critical | 1 |
| Major | 4 |
| Minor | 7 |

29 raw findings, consolidated to 12 by root cause. The duplicate-ID defect alone
accounts for seven raw findings across three pages.

---

## Critical

### F-01 · `topcars.php` returns HTTP 500 on every request

**Endpoint:** `GET /data/topcars.php`
**Surface:** `/start`, featured-vehicles module
**Covered by:** `funnel_smoke.spec.ts` FS-01

```
GET  /data/topcars.php  ->  500 Internal Server Error
POST /data/topcars.php  ->  500 Internal Server Error
Content-Length: 0
```

The response carries no body. `#top-cars` is server-rendered, so it stays in the
DOM holding three empty slots (`#top-car-1` … `#top-car-3`), collapses to roughly
20 px, and renders no error state. The only client-side signal is one console line.

This is why the detection has to sit on the network layer. Nothing about the
rendered page indicates a failure.

**Note on test design:** the request fires *during* page load. Response listeners
attached after `goto()` resolves will miss it and report a healthy homepage.
`src/fixtures.ts` attaches them before the first navigation for this reason.

---

## Major

### F-02 · Enquiry form accepts malformed email addresses

**Surface:** `/kontakt` and the `Anfrage` tab on every vehicle detail page
**Covered by:** `funnel_smoke.spec.ts` FS-03

`not-an-email` passes validation, is POSTed, and the user is shown the success
state. Validation checks only that the field is non-empty; the input is
`type="text"`, so native constraint validation does not apply either.

The logic exists **twice**: `ContactRequest` in `kontakt.min.js` and
`VehicleRequest` in `detail.min.js`, posting to two different endpoints. A fix
applied to one form will not reach the other.

### F-03 · Email links use the malformed `mailto://` scheme

Three addresses affected across `/start`, `/kontakt` and vehicle detail pages.
RFC 6068 defines no authority component for `mailto:`, so the `//` is invalid and
handling varies by client. Template-level, so it recurs on any new page.

### F-04 · Horizontal overflow at mobile viewport

**Surface:** `/kontakt` at 390 x 844

```
document.scrollWidth : 746px
window.innerWidth    : 390px
iframe#gmap_canvas   : width 730px, no max-width constraint
```

`/start` and `/fahrzeuge` pass the same check.

### F-05 · Duplicate DOM `id` attributes

Seven violations across three pages. `#erstzulassung-ankauf` on `/ankauf` is the
highest risk: it is a form control in the purchase wizard, duplicated twice, so
any handler reading that id resolves only the first.

---

## Minor

| ID | Defect | Surface |
| :--- | :--- | :--- |
| F-06 | No `alt` attribute on any image | `/start` (10/10), VDP gallery (23) |
| F-07 | No `<h1>` element | `/start`, `/fahrzeuge` |
| F-08 | No `meta description` | all four primary pages |
| F-09 | No `lang` attribute on `<html>` | all four primary pages |
| F-10 | Form fields lack `required` / `aria-required` | `/kontakt`, VDP enquiry |
| F-11 | `tel:` links contain unencoded whitespace | `/start`, `/kontakt`, VDP |
| F-12 | Zero-result search renders a blank column | `/fahrzeuge` |

---

## Verified healthy

Recorded as a regression baseline.

- `POST /data/filter.php` returns 200 and every rendered card matches the selected manufacturer
- Catalog to `/detail/:id` navigation
- VDP title, price, internal number, all four spec tabs, enquiry CTA
- Gallery images decode (`naturalWidth > 0`), gallery navigation advances
- All internal homepage links resolve 2xx/3xx
- Mobile menu opens and meets the 24 x 24 px tap-target minimum
- `/fahrzeuge`, `/ankauf`, `/kontakt`, `/impressum` load with no JS exceptions
