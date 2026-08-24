# QA Automation Architecture: autohaus-royal.de

A test strategy organised around the revenue funnel rather than around the
codebase. Every test in the suite answers a business question, and the diagram
below shows which one.

Render the diagram to PNG/SVG with `npm run diagram`. The source of truth is
[`architecture.mmd`](./architecture.mmd).

---

## The strategy in one sentence

Guard the four steps a buyer takes to become a lead, assert the APIs each step
depends on, and block a merge the moment any of them regresses.

## Why layered this way

| Layer | What it holds | Why it is a separate layer |
| :--- | :--- | :--- |
| 1. Entry points | Organic, paid, direct, mobile | Traffic arrives in different shapes. Mobile is a distinct risk surface, not a variant. |
| 2. Conversion funnel | `/start` to `/fahrzeuge` to `/detail/:id` to enquiry | This is the revenue path. Everything else exists to protect it. |
| 3. API dependencies | The five PHP endpoints behind the funnel | Each funnel step has exactly one backend it cannot survive without. Naming them makes failure attribution instant. |
| 4. Automation | Page objects, three funnel tests, cross-cutting probes, safety guard | Tests depend on page objects, never on raw selectors. One markup change costs one edit. |
| 5. CI/CD gate | PR smoke gate plus a nightly production audit | Two different jobs: stop regressions before merge, and catch production rot that no commit caused. |

## The diagram

```mermaid
%%{init: {
  "theme": "base",
  "themeVariables": {
    "fontFamily": "-apple-system, Segoe UI, Helvetica, Arial, sans-serif",
    "fontSize": "14px",
    "primaryColor": "#ffffff",
    "primaryTextColor": "#1a1d21",
    "primaryBorderColor": "#b8c0c8",
    "lineColor": "#8b95a1",
    "clusterBkg": "#fbfcfd",
    "clusterBorder": "#d8dde2"
  },
  "flowchart": { "curve": "basis", "nodeSpacing": 45, "rankSpacing": 60, "htmlLabels": true }
} }%%
flowchart TB

%% =====================================================================
%%  AUTOHAUS ROYAL  ·  QA AUTOMATION ARCHITECTURE
%%  Layered, revenue-funnel-first test strategy for the live platform.
%%  Colour = live status as of 17 Aug 2026 (red = broken, green = green).
%% =====================================================================

subgraph L1["&nbsp;&nbsp;🌐 &nbsp;LAYER 1 &nbsp;·&nbsp; USER ENTRY POINTS&nbsp;&nbsp;"]
    direction LR
    E1["Organic Search<br/><small><i>mobile-first index</i></small>"]
    E2["Paid / Google Ads<br/><small><i>gclid tracked</i></small>"]
    E3["Direct &amp; Brand"]
    E4["Mobile Web<br/><small><i>390 x 844</i></small>"]
end

subgraph L2["&nbsp;&nbsp;💰 &nbsp;LAYER 2 &nbsp;·&nbsp; CORE CONVERSION FUNNEL&nbsp;&nbsp;"]
    direction LR
    F1["<b>/start</b><br/><small>Home &amp; featured stock</small>"]
    F2["<b>/fahrzeuge</b><br/><small>Catalog &amp; filters</small>"]
    F3["<b>/detail/:id</b><br/><small>Vehicle Detail Page</small>"]
    F4["<b>Anfrage &nbsp;/&nbsp; /kontakt</b><br/><small>Lead capture</small>"]
    F5(["💶 &nbsp;<b>QUALIFIED LEAD</b>"])
    F1 --> F2 --> F3 --> F4 --> F5
end

subgraph L3["&nbsp;&nbsp;🔌 &nbsp;LAYER 3 &nbsp;·&nbsp; API &amp; DATA DEPENDENCIES&nbsp;&nbsp;"]
    direction LR
    A1["<b>topcars.php</b><br/><small>featured vehicles</small>"]
    A2["<b>filter.php</b><br/><small>search results</small>"]
    A3["<b>group.php</b><br/><small>facet counts</small>"]
    A4["<b>vehicle-request.php</b><br/><small>VDP enquiry &rarr; sales inbox</small>"]
    A5["<b>contact-request.php</b><br/><small>contact enquiry &rarr; sales inbox</small>"]
end

subgraph L4["&nbsp;&nbsp;🧪 &nbsp;LAYER 4 &nbsp;·&nbsp; AUTOMATION &nbsp;·&nbsp; Playwright + TypeScript&nbsp;&nbsp;"]
    direction LR
    P1[/"<b>Page Objects</b><br/><small>Home · Catalog · VDP · RequestForm</small>"/]
    T1["<b>PW-01</b> &nbsp;Entry &amp; API health<br/><small><i>listener armed pre-navigation</i></small>"]
    T2["<b>PW-02</b> &nbsp;Browse funnel<br/><small><i>filter correctness · VDP integrity</i></small>"]
    T3["<b>PW-03</b> &nbsp;Lead capture<br/><small><i>validation contract, both forms</i></small>"]
    X1["<b>Cross-cutting probes</b><br/><small><i>console · 4xx/5xx · naturalWidth · overflow</i></small>"]
    G1{{"🛡️ <b>Production safety guard</b><br/><small><i>lead endpoints intercepted<br/>analytics blocked · consent essential-only</i></small>"}}
    P1 --> T1 & T2 & T3
end

subgraph L5["&nbsp;&nbsp;⚙️ &nbsp;LAYER 5 &nbsp;·&nbsp; CI/CD QUALITY GATE&nbsp;&nbsp;"]
    direction LR
    C1["Pull Request"] --> C2["<b>GitHub Actions</b><br/><small><i>matrix: chromium + iPhone 13</i></small>"]
    C2 --> C3{"<b>Smoke gate</b><br/><small>PW-01 · PW-02 · PW-03</small>"}
    C3 -->|pass| C4["✅ <b>Merge allowed</b>"]
    C3 -->|fail| C5["🚫 <b>Merge blocked</b><br/><small><i>trace + video attached</i></small>"]
    C6["🌙 Nightly full audit<br/><small><i>17 cases, scheduled</i></small>"]
    C7[["📊 Markdown + PDF report"]]
    C8(["🔔 Severity-routed alert"])
    C5 --> C7 --> C8
end

%% ---------- traffic enters the funnel ----------
E1 & E2 & E3 & E4 ==> F1

%% ---------- each funnel step depends on an API ----------
F1 -->|XHR| A1
F2 -->|XHR| A2
F2 -->|XHR| A3
F3 -->|XHR| A2
F4 -->|POST| A4
F4 -->|POST| A5

%% ---------- what each test guards ----------
T1 -.->|"status &lt; 400"| A1
T2 -.->|"API vs rendered"| A2
T3 -.->|"must NOT submit"| A4
T3 -.->|"must NOT submit"| A5
G1 ==>|intercepts| A4
G1 ==>|intercepts| A5
X1 -.->|"every page"| F1

%% ---------- CI drives the suite ----------
C2 ==> T1 & T2 & T3
C6 ==> X1

%% ---------- live status as of 17 Aug 2026 ----------
class A1 broken
class A4,A5 guarded
class T1,T3 failing
class T2 passing
class F5 goal
class G1 guard

classDef broken  fill:#fdecec,stroke:#c0392b,stroke-width:2.5px,color:#7b1a12
classDef failing fill:#fff4e5,stroke:#e67e22,stroke-width:2.5px,color:#8a4b08
classDef passing fill:#eaf7ee,stroke:#27ae60,stroke-width:2.5px,color:#17603a
classDef guarded fill:#fff9e6,stroke:#c9a227,stroke-width:2px,color:#6b5310
classDef goal    fill:#8b0000,stroke:#5e0000,stroke-width:2px,color:#ffffff
classDef guard   fill:#eef2fb,stroke:#3b5bdb,stroke-width:2.5px,color:#1c2f6b

style L2 fill:#fdf8f8,stroke:#d9b3b3,stroke-width:2px
style L4 fill:#f7f9fc,stroke:#aebedd,stroke-width:2px
```

---

## Reading the colours

| Colour | Meaning | Current occupants |
| :--- | :--- | :--- |
| 🔴 Red | Broken in production right now | `topcars.php` returns HTTP 500 on every homepage load |
| 🟠 Amber | Test currently failing, defect open | PW-01 (API health), PW-03 (email validation) |
| 🟢 Green | Test passing, behaviour protected | PW-02 (browse funnel end to end) |
| 🟡 Yellow | Lead endpoint, intercepted by the safety guard | `vehicle-request.php`, `contact-request.php` |
| 🔵 Blue | Safety infrastructure | Production safety guard |

## Three design decisions worth defending

**1. The API layer is asserted separately from the UI.**
`PW-02` checks the status of `filter.php` *and* the rendered result list, then
compares them. When those two disagree you have found the most expensive class
of catalog bug: the query ran correctly and the UI ignored the answer. A test
that only counts cards cannot tell the difference between that and an empty
inventory.

**2. Response listeners are armed before navigation, never after.**
`topcars.php` fires during initial page load. A listener attached after
`goto()` resolves misses it completely, and the suite reports a healthy
homepage while the merchandising module is dark. This is the single most common
way an automated smoke test lies to you.

**3. The suite cannot create a sales lead, by construction.**
Both lead endpoints are intercepted at the browser-context level and answered
locally with a synthetic 200. The application's success branch still runs, so
the resulting UI state stays assertable, but nothing reaches the dealership.
This matters more than it sounds: the two enquiry forms look identical and share
their markup, but they post to *different* URLs. Guarding only the obvious one
leaves a live path into the sales inbox.

## What the gate costs

| Job | Trigger | Duration | Blocking |
| :--- | :--- | :--- | :---: |
| Funnel smoke gate | Every pull request | Under 2 minutes | Yes |
| Nightly production audit | 04:15 Europe/Berlin | Around 3 minutes | No, reports only |

Both are defined in [`.github/workflows/qa-gate.yml`](../.github/workflows/qa-gate.yml).
The smoke gate is deliberately small. A gate that takes fifteen minutes is a
gate people learn to bypass.
