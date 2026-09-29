# UAT-PPV-End-to-End-Automation
## Repository Analysis & PPV Integration Guide

---

## 1. What This Repository Does

`UAT-PPV-End-to-End-Automation` is a **dedicated Playwright E2E test suite** for DAZN's Pay-Per-View (PPV) purchase journeys. It is not a unit test suite, not a component library, and not a shared platform package.

**Core purpose:** Simulate real user journeys — from landing page through sign-up, plan selection, payment, and post-purchase success — for PPV events across multiple regions, user states, and subscription plans. All tests run against **production** (and some against staging) environments on real DAZN URLs.

---

## 2. Tech Stack

| Area | Technology |
|---|---|
| **Test framework** | Playwright 1.49+ (TypeScript) |
| **Language** | TypeScript 5 |
| **Runner** | Chromium (Chrome channel), 1920×1080, headless in CI |
| **CI** | GitHub Actions — `self-hosted` macOS ARM64 runners |
| **Mobile** | Appium (separate `appium/` subfolder, separate npm workspace) |
| **Data** | Excel (`.xlsx`) via `exceljs`/`xlsx` — `data/PPV_Input.xlsx` |
| **Reporting** | Playwright HTML reporter + custom Excel report writer |
| **Package manager** | npm |

---

## 3. Architecture

### Pattern: Page Object Model (POM) + Config-Driven Testing

The repo follows a clean **POM architecture**:

BasePage (base class)
├── HomePage.ts            — DAZN homepage, rail interactions
├── LandingPage.ts         — /welcome & marketing landing pages
├── BoxingPage.ts          — Boxing event pages
├── BoxingHomePage.ts      — Boxing homepage variant
├── GloryPage.ts           — GLORY kickboxing event page
├── PPVPage.ts             — Core PPV selection page
├── PPVUpsellPaymentPage.ts — Upsell PPV payment flow
├── PPVUpsellSuccessPage.ts — Upsell PPV success page
├── PaymentPage.ts         — Plan + payment step (109KB — most complex page)
├── PaymentFillPage.ts     — Credit card / Google Pay form fill
├── StandalonePPVPage.ts   — GLORY-style standalone PPV
├── SignupPage.ts          — Account creation
├── MyAccountPage.ts       — My Account subscription management
├── SearchPage.ts          — Search surfacing point
└── schedulepage.ts        — Schedule surfacing point
### Test Organisation

tests/
├── new_user/
│   └── newuser.ppv.spec.ts     — Full sign-up + PPV purchase (98KB)
├── existing_user/
│   └── existinguser.ppv.spec.ts — Existing user PPV purchase (170KB)
├── generated/                  — Auto-generated test variants
└── mobile/                     — Mobile test variants (Appium)
### Flow Engine

flows/
├── detectVariant.ts     — Detects which PPV page variant is showing
│                          (variant1 / variant2 / variant3)
│                          Config-driven detection strings from PPV.json
└── validateVariant.ts   — Validates page content against expected
values from config (21KB — core assertion engine)
### Utils Layer (20+ utilities)
| File | Purpose |
|---|---|
| `helpers.ts` | Cookie handling, page stabilisation, common actions |
| `testHelpers.ts` | Test setup, auth helpers, environment resolution |
| `configLoader.ts` | Loads PPV JSON config per event + region + env |
| `excelReader.ts` | Reads test data rows from PPV_Input.xlsx |
| `excelWriter.ts` | Writes test results back into the Excel report |
| `reportGenerator.ts` | Generates structured test reports |
| `buildEventData.ts` | Constructs the expected data object per test case |
| `resolveExpected.ts` | Resolves expected text values with env/region overrides |
| `compare.ts` | Deep comparison logic for actual vs expected values |
| `getActualValue.ts` | Scrapes actual values from the page (294KB — largest file) |
| `railsInterceptor.ts` | Intercepts network requests to validate rail content |
| `flowHelpers.ts` | High-level flow orchestration utilities |
| `dateUtils.ts` | Date/time computation for PPV dates |
| `browserHelpers.ts` | Browser-level helpers (viewport, cookies, etc.) |
| `failureCapture.ts` | Screenshot + trace capture on failure |
| `validator.ts` | Assertion wrappers |
| `cookieManager.ts` | Cookie consent handling |

---

## 4. Configuration System

All tests are **config-driven** — no hardcoded fight names, prices, or URLs.

### `config/PPV.json` — Event Config
Each PPV event is a top-level key (e.g. `beauty_and_beast`, `aj_joshua_prenga`). Each event contains:
- `PPV_NAME`, `PPV_TYPE` (`boxing` | `standalone`), `SPORT`
- `regions` — per-region pricing, dates, bundle details, offers
- `variants` — detection strings + CSS selectors per UI variant
- `pages` — page-level detection strings

**Currently configured events:**
- `beauty_and_beast` — Fury vs. Hall (GB, AU)
- `standalone_collision` — GLORY Collision 9 (GB)
- `upsell_flow` — Zayas vs. Boots with upsell (GB)
- `aj_joshua_prenga` — Joshua vs. Prenga (GB, US, AU, AE) ← _active/upcoming_

### `config/DaznPlan.json` — Plan Config
Subscription plan pricing and terms per region and plan type:
- `standard_monthly`, `standard_apm`, `ultimate_apm`, `ultimate_upfront`

### `config/surfacingpoint.json` — Surfacing Points
23 defined entry points to the PPV funnel:
- `home-page-banner`, `home-boxing-tile`, `landing-page-banner`, `boxing-page-bundle`, `schedule`, `search`, `myaccount`, etc.
- Each maps to an `endPage` (always `payment`) and optional flags (`defaultSignup`, `enableDevMode`)

### `config/userstatus.json` — Test User Accounts
Pre-provisioned test accounts per status × region × environment:
- `freemium`, `frozen`, `active_standard_monthly`, `active_standard_apm`, `active_ultimate_apm`, `active_ultimate_upfront`
- Regions: GB, US, AU, AE, IN

### `config/events/` and `config/stag/` — Per-Event Config Files
Historical event config files (Usyk, Wardley PPV configs archived in `config/prod/`).

### `data/PPV_Input.xlsx` — Excel Test Matrix
The primary data-driven input. Contains test cases mapped to surfacing points, regions, plans, and expected values.

---

## 5. GitHub Actions CI — Workflow Architecture

The repo has **21 GitHub Actions workflows**, all `workflow_dispatch` (manually triggered or event-scheduled). Pattern: `{region}-{env}-{scenario}-e2e.yml`.

**Regions covered:** `gb`, `us`, `au`, `ae`, `br`

**Three scenario types per region:**
1. `new-user-e2e` — Full sign-up → PPV purchase journey
2. `existing-sign-in-during-flow-e2e` — Anonymous browsing → PPV page → sign in mid-flow
3. `existing-already-signed-in-e2e` — Pre-authenticated user → PPV purchase

**Inputs per workflow:**
- `PPV_CONFIG` — which fight config to use (e.g. `ppv_t_joshua_prenga.json`)
- `PAYMENT_METHOD` — `credit_card` | `gpay`
- `SWITCH` — whether to switch to Ultimate plan during flow

**Test matrix per workflow (GB new-user example):**
- **Sources (surfacing points):** 20 entry points × 4 plans = **up to 80 parallel jobs**
- **Plans:** `standard_monthly`, `standard_apm`, `ultimate_apm`, `ultimate_upfront`
- Exclusions applied for ultimate-only sources
- `max-parallel: 8`, `fail-fast: false`

**Runners:** `self-hosted macOS ARM64` machines (not GitHub-hosted)

**Report archival:** Reports saved to `$HOME/DAZN-CI-Reports/` on the runner machine (GitHub Artifact upload is disabled — `if: ${{ false }}`).

**Special event workflows:**
- `gb-prod-joshua-prenga-ppv.yml` — Fight-specific workflow
- `au-prod-schedule-ppv.yml` — Schedule page PPV
- `homepage-dont-miss-uk-ppv.yml` / `uk-prod-dont-miss-ppv.yml` — Homepage "Don't Miss" rail
- `us-prod-zayas-boots-*` — Zayas/Boots-specific US workflows

---

## 6. PPV Variant Detection System

PPV purchase pages can render in 3 variants (different UI layouts):

| Variant | Detection Signal | PPV Selector | UI Description |
|---|---|---|---|
| `variant1` | `"to watch your pay-per-view"` | `input[type='radio']` | Radio button PPV selection |
| `variant2` | `"choose your subscription"` | `input[type='checkbox']` | Checkbox PPV with subscription |
| `variant3` | `"2 fight"` / `"bundle"` | `input[type='radio']` | Bundle / multi-fight page |

Detection is config-driven (reads from `PPV.json`), with fallback hardcoded strings. `detectVariant.ts` is called before any assertion to ensure the test validates the correct UI path.

---

## 7. User Journey Coverage

### New User Flow
Landing/Source Page
→ Click PPV CTA
→ Sign Up (email + password)
→ PPV Page (detectVariant)
→ Plan Selection
→ Payment Page (credit card / Google Pay)
→ Success Page
→ [Optional] Upsell PPV (second purchase)
### Existing User Flow (Already Signed In)
Navigate to DAZN (with saved auth state)
→ Source Page
→ Click PPV CTA
→ PPV Page (detectVariant)
→ Plan Selection (or direct payment if active subscriber)
→ Payment Page
→ Success Page
→ [Optional] My Account verification
### Existing User Flow (Sign In During Flow)
Source Page (anonymous)
→ Click PPV CTA
→ Sign In modal/page
→ PPV Page (detectVariant)
→ Payment
→ Success
### Upsell PPV Flow (Active Subscriber)
Watch homepage after purchase
→ "Don't Miss" rail / upsell tile
→ PPVUpsellPaymentPage (saved card, CVV re-entry)
→ PPVUpsellSuccessPage
---

## 8. Active Branches

| Branch | Purpose |
|---|---|
| `main` | Stable production branch |
| `feature/android-integration-v2` | Android/Appium integration |
| `feature/my-account-subscription-status` | My Account verification |
| `feature/ppv-active-standard-ultimate-fix` | Active sub PPV flow fixes |
| `feature/ppv-ultimate-tier-flow` | Ultimate tier PPV flow |
| `feature/schedule-navigator-v2` | Schedule page navigation v2 |
| `gopi/ppv-local-regression-20260705` | Local regression run |
| `sridevi/home-boxing-mobile-flows` | Mobile boxing flows |
| `integrate-gopi-my-account` | My Account integration work |

---

## 9. How to Integrate with PPV Automation

### 9.1 — Adding a New PPV Event

**Step 1: Add event config to `config/PPV.json`**
```json
"your_event_key": {
  "PPV_NAME": "Fighter A vs. Fighter B",
  "PPV_DISPLAY_NAME": "A vs. B",
  "SPORT": "Boxing",
  "PPV_TYPE": "boxing",
  "OFFER_TYPE": "7_day_trial",
  "global": { ... },
  "regions": {
    "GB": {
      "PPV_DATE": "...",
      "PPV_PRICE": "£XX.XX",
      ...
    }
  },
  "variants": {
    "variant1": {
      "detection": "to watch your pay-per-view",
      "ppvSelector": "input[type='radio']",
      "ctaText": "Continue with pay-per-view"
    }
  }
}
Step 2: Create a per-event config file in config/prod/
(Following the pattern of Usyk PPV config/ or Wardley PPV config/)Step 3: Update data/PPV_Input.xlsx
Add test data rows for the new event with expected values per surfacing point × region × plan.Step 4: Create or update a GitHub Actions workflow
Clone an existing fight-specific workflow (e.g. gb-prod-joshua-prenga-ppv.yml) and update:
Workflow name
PPV_CONFIG default value
Matrix sources (if surfacing points differ for this event)
9.2 — Adding a New Surfacing PointStep 1: Add to config/surfacingpoint.json"my-new-source": {
  "source": "my-new-source",
  "endPage": "payment"
}
Step 2: Implement navigation in the appropriate page object
The surfacing point name maps to navigation logic in HomePage.ts, LandingPage.ts, BoxingPage.ts, etc. Add the handler in the relevant page object.Step 3: Add to the workflow matrix
Add "my-new-source" to the source array in relevant workflows.9.3 — Adding a New RegionStep 1: Add region data to config/PPV.json under regionsStep 2: Add test accounts to config/userstatus.json under each status:"BR": {
  "environments": {
    "prod": {
      "USER_EMAIL": "brtest@yopmail.com",
      "USER_PASSWORD": "Dazn@123"
    }
  }
}
Step 3: Create new workflow files following the {region}-prod-* pattern:
br-prod-new-user-e2e.yml
br-prod-existing-already-signed-in-e2e.yml
br-prod-existing-sign-in-during-flow-e2e.yml
Set DAZN_REGION: BR in the workflow env.9.4 — Integrating with auth-web-chapter or payments-library-webThis repo tests the live production output of those chapters — it does not import or depend on their source code. Integration is implicit:This repo validatesOwned bySign-up page selectors & flowsauth-web-chapterPlan selection UIauth-web-chapterPayment form (credit card, Google Pay)payments-library-webPPV upsell UIauth-web-chapter + catalog-web-chapterMy Account subscription statusmyaccount-web-chapterHomepage/landing railscatalog-web-chapter + landing-page-web-chapterWhen a chapter deploys a breaking UI change:
Identify which Page Object is affected
Update selectors in the relevant pages/*.ts file
Update detection strings in config/PPV.json if the PPV page copy changes
Re-run the relevant workflow to validate
9.5 — Running Locally# Install
npm ci

# Set up env file
cp .env.template .env
# Edit .env with real credentials

# Run all tests (headed)
npm run test:headed

# Run specific spec
npx playwright test tests/new_user/newuser.ppv.spec.ts --project=chromium

# Run with specific env vars
DAZN_REGION=GB DAZN_ENV=prod PLAN=standard_monthly SOURCE=landing-page-banner \
  PPV_CONFIG=ppv_t_joshua_prenga.json \
  npx playwright test tests/new_user/newuser.ppv.spec.ts --project=chromium

# Debug mode
npm run test:debug

# View last report
npm run test:report
10. Known Issues & RisksIssueSeverityNotesTest accounts committed to repo🔴 Highconfig/userstatus.json contains plaintext prod credentials (email+password). Should be migrated to GitHub Secrets.auth/dazn-storage-state.json committed🔴 HighContains real browser auth session state (cookies/localStorage). Should be in .gitignore and generated at runtime.node_modules/ committed🟡 Mediumnode_modules/ directory committed to git — increases repo size, causes conflicts. Should be in .gitignore.upload-artifact disabled🟡 Mediumif: ${{ false }} on all artifact uploads — reports only persist on self-hosted runner disk, not portable.No stag/beta coverage🟡 MediumAlmost all workflows target prod. Staging test account coverage has many TODO_ADD_* placeholders..DS_Store committed🟢 LowMac metadata file committed. Should be in .gitignore.Stale files in utils🟢 LowdateUtils.js.stale-bak, reportGenerator.ts.bad are leftover draft files.ae-prod-new-user workflow is minimal🟢 Lowae-prod-new-user-e2e.yml is significantly smaller than other regions — may have incomplete coverage for AE.11. SummaryAttributeValueTypePlaywright E2E test suite (not a frontend app)PurposePPV purchase journey automation across regions, user states, plans, surfacing pointsEnvironmentsPrimarily Production; some StagingRegionsGB, US, AU, AE, BRUser typesNew user, freemium, frozen, standard monthly, standard APM, ultimate APM, ultimate upfrontSurfacing points23 entry points (homepage, landing page, boxing page, schedule, search, my account)CI21 GitHub Actions workflows, self-hosted macOS ARM64, up to 80 parallel jobsDAZN chapters testedauth-web-chapter, catalog-web-chapter, landing-page-web-chapter, myaccount-web-chapter, payments-library-webKey integration fileconfig/PPV.json — add new events here first
