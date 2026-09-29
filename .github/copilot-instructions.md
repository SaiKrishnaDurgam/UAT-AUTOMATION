# DAZN PPV Automation Instructions

## Priorities

Apply these in order: correctness, no regression, smallest diff, compatibility,
maintainability, readability, performance.

Before changing code, inspect the affected implementation, its callers, existing
helpers, selectors, configuration, and relevant tests. State the reason for a
change before making it. If a material requirement is unclear, ask; do not guess.

## General

- Change only code required for the request; do not refactor or reformat unrelated code.
- Preserve architecture, public APIs, names, logging, reporting, screenshots, videos,
  assertions, and existing test coverage unless removal is explicitly requested.
- Reuse existing helpers and patterns. Avoid duplicate logic and new dependencies.
- Keep PPV flows data-driven: never hardcode PPV names, prices, accounts, regions,
  device identifiers, or environment URLs.
- Verify the smallest relevant test, type check, lint, or workflow validation after a change.

## Playwright (TypeScript web)

- Keep a working selector. Reuse existing specific locators; introduce a new locator only
  when the current one is proven insufficient.
- Prefer accessible, stable, scoped locators and existing page-object methods.
- Use web-first assertions and deterministic conditions (`expect`, locator waits, URL or
  response waits); do not use `waitForTimeout()` as synchronization or add blind retries.
- Do not increase timeouts without evidence. Fix the readiness condition or root cause.
- Preserve coverage across supported DAZN regions, surfaces, browsers, and web flows.

## WebdriverIO + Appium (TypeScript: iOS, Android, web)

- Reuse existing page objects, commands, capabilities, selectors, and device configuration.
- Prefer platform accessibility IDs, resource IDs, or iOS predicates/class chains already in
  use. Do not replace a specific working mobile selector with a generic XPath.
- Wait for observable app or element state (`waitForDisplayed`, `waitForEnabled`,
  `waitUntil` with a meaningful condition); never synchronize with fixed sleeps.
- Keep platform-specific behavior isolated. A shared change must remain compatible with iOS,
  Android, and WebdriverIO web runs.
- Do not alter reset, install, session, capability, or test-data behavior unless required and
  validated against the affected platform.

## GitHub Actions

- Before proposing a matrix change, calculate the product of all matrix dimensions.
- GitHub Actions permits at most 256 matrix jobs. If the result exceeds 256, split the
  workflow or reduce combinations; never propose an invalid matrix.

## Reviews and Generation

- Focus reviews on regressions, synchronization flakiness, missing validation, duplicated or
  dead code, complexity, and performance impact—not subjective style.
- Prefer the safest production-ready solution with the least behavioral change.
