import type { TestCase } from './testCase.js';
import { renderTestCase } from './testCase.js';
import type { Classification } from '../failure/rules.js';
import type { NormalizedFailure } from '../tools/exec/parseReport.js';
import type { FixAttempt } from './state.js';

interface BrowseCreds { email?: string; password?: string; baseUrl?: string; }

function credentialsHint(browse?: BrowseCreds): string {
  if (!browse?.email || !browse?.password) return '';
  return `\n\nApp credentials (use these if you need to log in while browsing):\n  Email: ${browse.email}\n  Password: ${browse.password}`;
}

function buildGenerateSystem(browse?: BrowseCreds): string {
  return `You are a QA automation agent in the GENERATE phase.

Your job: translate a structured test case into a Playwright test that ACTUALLY exercises the assertion described in 'Expected'.

Available tools:
  - pages.getStructure: returns the full inventory of page-object files under src/pages/, grouped by subdirectory. The "locales" key maps each locale code to its override files. Call this ONCE before the companion locale check (step 9) to know exactly which locales exist — never guess locale names.
  - testData.getSchema: returns the exact field names for a testData dataset (e.g. 'users'). Call this BEFORE writing any test that uses testData — never guess field names like 'email' or 'name'.
  - fs.read: read any file in the repo to understand existing POMs and conventions
  - test.createSpec: create a new spec file (refuses if file exists)
  - test.addCase: add a test to an existing spec file (refuses on duplicate title)
  - ast.addImport: add imports to a spec or POM file
  - pom.createPage: create a NEW Page Object class file (use when the POM does not exist yet)
  - fixture.addPage: register a POM class as a fixture in src/fixtures/pages.fixture.ts (call this immediately after pom.createPage)
  - pom.addSelector: add a new readonly selector field to an existing page object (use when the POM exists but is missing a field the test needs)
  - pom.updateSelector: update a selector on an existing page object
  - pom.editMethod: replace the body of a flow method on an existing page object

The following tools may also be available depending on configuration:
  - browse.navigate: open a URL in a live browser (use to inspect the real app)
  - browse.snapshot: get the accessibility tree of the current page
  - browse.click / browse.type / browse.hover: drive the live page to reach the state you need to inspect
  - browse.evaluate: run JavaScript on the current page — use this to find id/class/data-testid attributes
    that are not visible in the snapshot. Pass a function string, e.g.:
      function: "() => document.querySelector('button').id"
      function: "() => document.querySelector('input[placeholder*=Search]').getAttribute('data-testid')"

## Framework structure

Page objects live in two tiers:
  - src/pages/common/<Page>.ts              — default implementation used by all locales
  - src/pages/locales/<locale>/<Page>.ts    — locale-specific subclass, overrides only what differs

When reading a POM, always check common/ first, then check locales/<locale>/ for an override.
The override extends the common class and only redefines what differs — the rest is inherited.

Fixtures (always import tests from here, never directly from @playwright/test):
  - src/fixtures/pages.fixture.ts — exports test, expect, and all page object fixtures
    Fixtures available in every test: page, appLocale, testData, loginPage, checkoutPage
  - appLocale  (string, worker-scoped) — the locale this worker is running for (e.g. 'en-gb')
  - testData   (function, test-scoped) — call testData<User>('users') to get the next unused user for this worker

Test locations:
  - tests/generic/          — runs for every locale; use appLocale/testData for locale-aware behaviour
  - tests/locales/<locale>/ — runs only for that locale; add test.describe.configure({ mode: 'serial' }) at the top

## Locale overrides

Any locale-specific POM overrides live under src/pages/locales/<locale>/.
Any locale-specific spec files belong in tests/locales/<locale>/.
Use fs.read to discover which locales have override folders when needed.

## Locale scope rules

The test case carries a 'Locale scope' field:

  generic       → Write the test to tests/generic/.
                  After writing it, check each configured locale for POM overrides of the POMs
                  the test uses. If a locale has overrides that change selectors or behaviour
                  relevant to this test, scaffold a companion spec in tests/locales/<locale>/
                  that exercises the locale-specific variation. Add test.describe.configure({ mode: 'serial' })
                  at the top of every locale-specific spec.

  <locale>      → Write the test directly to tests/locales/<locale>/.
                  Read src/pages/locales/<locale>/<Page>.ts for every POM the test uses.
                  Use the override's field/method names where they differ from common/.
                  Add test.describe.configure({ mode: 'serial' }) at the top of the spec.

## Rules

  - The generated test MUST exercise the assertion in 'Expected'. Generic assertions like 'expect(page).toHaveTitle(/.*/)' are FORBIDDEN unless the case is explicitly about the page title.
  - Always import { test, expect } from the pages fixture file, never from @playwright/test directly.
  - Before writing the test body, fs.read the relevant POM(s). Check common/ first, then locales/<locale>/ for any override. Use the exact field/method names from whichever class applies.
  - If 'Expected' names a POM field (e.g. 'LoginPage.continueButton'), reference it directly: 'await expect(checkoutPage.continueButton).toBeVisible()'.
  - If a POM file does not exist yet, create it with pom.createPage, then immediately call fixture.addPage to register it in src/fixtures/pages.fixture.ts. This lets tests destructure the page object from fixture args instead of calling new ClassName(page) inline.
  - If a POM exists but is missing a field the test needs, add it with pom.addSelector — do NOT inline raw selectors in the spec.
  - If a POM field exists but has the wrong selector, fix it with pom.updateSelector.
  - If a POM is missing a method you need, extend it via pom.editMethod. Do NOT inline raw selectors in the spec when a POM exists.
  - Click-to-navigate rule: when a test step requires clicking an element to navigate to another page,
    you MUST use a POM field whose selector targets an anchor element (contains 'a[', 'a:', 'a.', or starts with 'a ')
    OR whose name ends in 'Link' or 'Button'. Never use a field targeting an image (img, .product-image, etc.)
    or a plain container div for a navigation click — those elements do not fire navigation events.
    If the POM has multiple candidates, pick the one whose selector is an anchor over any other.
  - Strict-mode / list-page rule: Playwright strict mode requires a locator to resolve to EXACTLY ONE element.
    On list pages (products, search results, etc.) a POM field like viewProductLink or productCards will match
    every item on the page. You MUST append .first() when clicking such a field:
        CORRECT: await productsPage.viewProductLink.first().click();
        WRONG:   await productsPage.viewProductLink.click();   ← strict mode violation
    If browse.* tools are available, always browse the list page BEFORE writing the test body to confirm
    how many elements a locator matches — do not rely on field names alone to judge cardinality.
  - Step budget rule: you have at most 40 steps total. Read at most 4–5 files, then WRITE the test (test.createSpec + test.addCase). Do not keep reading or browsing after you have enough information to write. If you are on step 8+ and have not yet called test.createSpec or test.addCase, stop reading and write now.
  - Only fs.read files that are directly named in the test case steps or Expected outcome (the POMs you are creating/editing, the target spec file). Do NOT read unrelated POMs, BasePage, or other framework files to "understand conventions" — this wastes steps. Do NOT re-read a file you have already read in this session.
  - Authentication rule: if the test requires login or involves pages only reachable after authentication (order confirmation, payment, account pages), DO NOT browse those pages — you cannot reach them without credentials. Write the test directly from the POM files and test case steps. Only browse publicly accessible pages (products list, product detail, cart, login page itself).
  - If browse.* tools are present and you cannot tell whether a POM selector is correct, use browse.navigate directly to the relevant URL. The navigate response already includes the FULL page snapshot — call it once and use what you get.
  - HARD RULE: NEVER call browse.snapshot after browse.navigate. They return the same data. browse.snapshot is only for re-checking a page you are ALREADY on without navigating again.
  - HARD RULE: NEVER call browse.click to navigate between pages. Use browse.navigate directly to each target URL. Reserve browse.click only for interactions that genuinely cannot be done with a direct URL (e.g. opening a modal on the current page). If browse.click fails to navigate, recover by calling browse.navigate once to the target URL — do NOT retry the click.
  - STRICT RULE: Each URL must be visited at most once. Once you receive a snapshot for a URL, that page is done — never call browse.navigate for the same URL again in the same session.
  - NEVER use browse.* tools to inspect the file system or check for locale overrides. For locale checks, call pages.getStructure first to get the real list of locales and override files — then only fs.read the files that are listed in the result. NEVER guess locale names or attempt to read a file that was not returned by pages.getStructure.
  - ARIA vs CSS: browse snapshots use ARIA notation like 'textbox "Search Product"' or 'button "Submit"'.
    These are NOT valid CSS selectors. Always convert to real CSS: 'input[placeholder="Search Product"]',
    '#search-input', '[data-testid="search"]', etc. Never pass snapshot ARIA strings to this.loc() or pom.addSelector.
  - Selector preference order (highest to lowest): data-testid → id → class → placeholder/type/role → text → xpath.
    1. data-testid: '[data-testid="search-btn"]'
    2. id:          '#search_product'
    3. class:       '.search-btn' (pick the most specific single class, not a chained path like 'button.search-btn svg')
    4. placeholder/type/attribute: 'input[placeholder="Search Product"]', 'button[type="submit"]'
    5. text/role:   only when nothing above is available
    If the snapshot does not show id/class/data-testid for an element, use browse.evaluate to query the DOM.
    Pass a function string, e.g.: "() => document.querySelector('button[type=submit]').getAttribute('data-testid')"
    or "() => document.querySelector('input').id" — then use the result as the selector.
  - Selector quality rule: selectors must work for ANY instance of the page, not just the one you browsed. Do NOT hardcode dynamic values (product names, prices, specific text that changes per item) into selectors. Use structural CSS paths instead. Examples:
      BAD:  this.loc('h2:has-text("Blue Top")')       — breaks on every other product
      BAD:  this.loc('h2:has-text("Rs. 500")')        — breaks on every other price
      GOOD: this.loc('.product-information h2')       — works for any product name
      GOOD: this.loc('.product-information span span') — works for any price
    Only use :has-text() for stable labels that never change: 'Category:', 'Brand:', 'Availability:', 'Condition:'.
  - File download assertion: when a test step says "assert the file is downloaded", use Playwright's download event — do NOT look for a POM selector. Write it inline in the test body:
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        orderConfirmationPage.downloadInvoiceButton.click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/invoice/i);
    This is the ONLY place where inline page API usage in the test body is allowed.
  - testData fixture: when a test requires a registered user account (login credentials, user details), use the testData fixture.
    BEFORE writing the test body, call testData.getSchema('users') (or the relevant key) to get the exact field names.
    NEVER guess field names like 'email', 'name', 'username' — always use the fields returned by testData.getSchema.
    Usage pattern (field names filled in from testData.getSchema result):
      const user = await testData<{ <field1>: string; <field2>: string }>('<key>');
    Add 'testData' to the fixtures array when calling test.addCase.
  - Always ensure imports exist via ast.addImport before referencing a symbol.
  - Stop as soon as all required spec files are written. DO NOT run the test — execution happens outside this phase.
  - Batch independent tool calls into a single response — read the spec file AND the POM in the same turn, not one after the other. Every unnecessary round-trip wastes a step.

Output: after your last tool call, produce no further tool calls. The orchestrator takes over.${credentialsHint(browse)}`;
}

function buildFixSystem(browse?: BrowseCreds): string {
  return `You are a QA automation agent in the FIX phase.

A test you wrote (or an existing one) just failed. A rule-based classifier has identified the cause and suggested an action. Your job: apply the minimal fix.

Available tools:
  - fs.read: read any file to inspect current state
  - test.editCase: replace the body of a test
  - pom.updateSelector: swap a selector string on a page object field
  - pom.editMethod: replace the body of a flow method on a page object
  - ast.addImport: add an import if the fix requires a new symbol

The following tools may also be available depending on configuration:
  - browse.navigate: open a URL in a live browser (use to find the correct selector)
  - browse.snapshot: get the accessibility tree of the current page (shows real selectors that work)
  - browse.click / browse.type / browse.hover: drive the live page to reach the failing state

## Framework structure

Page objects live in two tiers:
  - src/pages/common/<Page>.ts              — default for all locales
  - src/pages/locales/<locale>/<Page>.ts    — locale-specific override; extends the common class

When fixing a selector or method:
  - If the failing file is under src/pages/locales/<locale>/, fix it there — the fix is locale-specific.
  - If the failing file is under src/pages/common/, check first whether the fix applies to ALL locales
    or only to one. If it applies to all, fix common/. If it applies only to one locale, create or
    update the locale-specific override in src/pages/locales/<locale>/ rather than changing common/
    in a way that would break other locales.
  - If a generic test fails only for one locale (the failing file path or test title hints at the locale),
    do NOT change common/. Instead, create or update src/pages/locales/<locale>/<Page>.ts.

## Rules

  - Respect the suggested action. If action == 'update_pom', edit the POM, not the test.
    NEVER inline raw selectors into the test body — if the POM is missing a field, use pom.addSelector to add it,
    then reference that field name in the test via pom.updateSelector or test.editCase if needed.
  - If action == 'update_test', edit the test, not the POM.
    When editing the test body, always reference POM fields (e.g. productsPage.searchResultsHeading) —
    NEVER inline page.locator(), page.getByRole() or raw selectors directly in the test.
  - If action == 'retry', make NO edits — produce no tool calls. The orchestrator will re-run.
  - When the failing locator does not match anything (kind == 'selector' and action == 'update_pom'),
    and browse.* tools are present, you MUST use browse.navigate to the app's base URL and
    browse.snapshot to find a working selector BEFORE calling pom.updateSelector.
    Do not guess a replacement selector — confirm against the live DOM.
  - Make the smallest correct change. Do not refactor unrelated code.

Stop as soon as the fix is applied. DO NOT re-run tests — execution happens outside this phase.${credentialsHint(browse)}`;
}

export function generateSystemPrompt(browse?: BrowseCreds): string {
  return buildGenerateSystem(browse);
}

export function fixSystemPrompt(browse?: BrowseCreds): string {
  return buildFixSystem(browse);
}

// Resolve the effective single locale from localeScope.
// Used for spec file path and prompt context — not for browse URL (see browseUrl.ts).
function resolveTargetLocale(localeScope: string | string[]): string | null {
  if (localeScope === 'generic' || localeScope === 'global') return null;
  if (Array.isArray(localeScope)) return localeScope.length > 0 ? localeScope[0] : null;
  return localeScope;
}

// Infer a spec file base name from the test title.
// Examples: "user can register" → "auth", "product is added to cart" → "cart"
const SPEC_FILE_KEYWORDS: Array<[RegExp, string]> = [
  [/register|sign.?up|signup/i, 'auth'],
  [/log.?in|sign.?in|logout|sign.?out/i, 'auth'],
  [/password|credential/i, 'auth'],
  [/cart|basket|add.to.cart|remove.from.cart/i, 'cart'],
  [/checkout|payment|order|purchase/i, 'checkout'],
  [/product|search|filter|categor/i, 'products'],
  [/contact|form|submit/i, 'contact'],
  [/home|landing|hero/i, 'home'],
  [/profile|account|settings/i, 'account'],
];

function inferSpecBaseName(title: string): string {
  for (const [pattern, name] of SPEC_FILE_KEYWORDS) {
    if (pattern.test(title)) return name;
  }
  return 'general';
}

export function generateTask(tc: TestCase, defaultSpecFile: string, baseUrl?: string): string {
  const targetLocale = resolveTargetLocale(tc.localeScope ?? 'generic');
  const isGeneric = targetLocale === null;

  // Derive spec path: prefer test-subject inference over a blanket fallback file.
  const specFile = tc.specFile ?? (() => {
    const base = inferSpecBaseName(tc.title);
    if (targetLocale) return `tests/locales/${targetLocale}/${base}.spec.ts`;
    // Keep caller's defaultSpecFile only when it isn't the generic catch-all name.
    if (!defaultSpecFile.endsWith('agent-generated.spec.ts')) return defaultSpecFile;
    return `tests/generic/${base}.spec.ts`;
  })();

  const companionStep = isGeneric
    ? [
        `  9. Companion locale specs (generic tests only — only after test.addCase has succeeded):`,
        `       a. Call pages.getStructure ONCE to get the real list of locales and their override files.`,
        `          If pages.getStructure returns an empty "locales" object, there are no locale overrides — skip to step 10.`,
        `       b. For each locale returned by pages.getStructure that has at least one override file:`,
        `          - fs.read src/pages/locales/<locale>/<Page>.ts ONLY for POMs that appear in that locale's file list.`,
        `            Do NOT attempt to read a POM that is not listed — it does not exist.`,
        `          - If the override changes selectors or methods that this test exercises,`,
        `            scaffold a companion spec at tests/locales/<locale>/<same-filename> using`,
        `            test.createSpec (with serial:true), then use test.addCase to write the locale-specific test.`,
        `          - If none of the locale's overrides affect this test, skip that locale entirely.`,
        `  10. Stop.`,
      ]
    : [
        `  9. Stop.`,
      ];

  return [
    'Create a Playwright test for the following test case.',
    '',
    renderTestCase(tc),
    '',
    `Write the test to: ${specFile}`,
    `(Spec file is inferred from the test subject. Group related tests: auth.spec.ts for login/register,`,
    ` cart.spec.ts for cart operations, products.spec.ts for browsing/search, checkout.spec.ts for orders.)`,
    '',
    'Steps:',
    '  1. fs.read the target spec file (if it exists) to understand existing conventions.',
    isGeneric
      ? '  2. Locale scope is GENERIC — the test runs for every locale.'
      : `  2. Locale scope is ${targetLocale} — the test runs only for that locale.`,
    '  3. fs.read the POM(s) the Expected outcome references:',
    '       a. Read src/pages/common/<Page>.ts first — this is the base implementation.',
    targetLocale
      ? `       b. Read src/pages/locales/${targetLocale}/<Page>.ts — use its field/method names where they differ from common/.`
      : '       b. For generic tests the fixture picks the right class at runtime — read common/ for field names.',
    '  IMPORTANT: complete steps 4–8 (browse + write the test) BEFORE doing step 9 (locale companion specs).',
    '  Do NOT attempt locale checks until test.addCase has succeeded. fs.read does not work on directories.',
    '  4. If browse.* tools are available, use browse.navigate to the relevant page URL before writing the test body.',
    '     This is REQUIRED (not optional) whenever the test involves clicking on a list page item to navigate to a detail page.',
    '     Confirm how many elements a locator matches — if it matches more than one, use .first() in the test body.',
    `     Go directly to the full URL (e.g. ${baseUrl ?? 'https://your-app.com'}/products) — never navigate to base URL first.`,
    '     Visit each URL at most once. The navigate response already includes the full page snapshot — use it directly.',
    '     Do NOT call browse.snapshot right after navigate; it returns the same data.',
    '     Use pom.updateSelector (or pom.createPage with correct selectors) based on what you see.',
    '  5. If any POM from step 3 did not exist and was created with pom.createPage, call fixture.addPage',
    '     to register it. Batch this with the pom.createPage call if possible.',
    '  6. Use test.createSpec if the spec file does not yet exist.',
    targetLocale
      ? '     Pass serial:true — locale-specific specs always run serially. test.createSpec handles the mode:serial line automatically.'
      : '     Generic specs do not need serial:true.',
    '     test.createSpec always emits the correct `import { test, expect } from \'...\' ` — do NOT add that import yourself with ast.addImport.',
    '  7. Use ast.addImport ONLY for non-fixture symbols (e.g. a type alias used in the test body).',
    '     NEVER import page-object fixture names (productsPage, loginPage, etc.) at module level.',
    '     Page object fixtures are injected by Playwright at runtime — they are NOT named exports of the fixture file.',
    '     Only `test` and `expect` are real exports of pages.fixture.ts.',
    '  8. Use test.addCase to insert the test.',
    '     Pass fixtures: ["productsPage", "productDetailPage"] (every page object the test body uses).',
    '     The tool generates the correct `async ({ page, productsPage, productDetailPage }) => {` signature for you.',
    '     Write only the body statements in the body field — no function signature, no surrounding braces.',
    '     Do NOT import fixture names at module level — they are injected by Playwright via the fixtures array.',
    '     Do NOT call `new ClassName(page)` inline — use the fixture names directly in the body.',
    '     Start the body with `await <fixtureName>.goto();`, then assert using POM fields.',
    ...companionStep,
  ].join('\n');
}

export function fixTask(
  failure: NormalizedFailure,
  classification: Classification,
  history: FixAttempt[],
): string {
  const targetLine = failure.line !== undefined ? `:${failure.line}` : '';
  const locatorHint = classification.fixTarget?.locator
    ? `Failing locator: ${classification.fixTarget.locator}`
    : '';
  const fileHint = classification.fixTarget?.file
    ? `Suspected file: ${classification.fixTarget.file}`
    : '';

  const historySection =
    history.length === 0
      ? []
      : [
          '',
          `## Previous fix attempts (${history.length} so far — do NOT repeat what already failed)`,
          ...history.map((h, i) =>
            [
              `  Attempt ${i + 1}:`,
              `    Kind: ${h.classification.kind}  Action: ${h.classification.action}`,
              `    Cause: ${h.classification.cause}`,
              `    Error: ${h.failure.message.split('\n')[0]}`,
            ].join('\n'),
          ),
          '',
          'Study the pattern above. If the same action was tried and failed, try a different approach.',
          'If the selector was updated but still fails, the replacement was wrong — use browse.snapshot to confirm.',
          'If the test logic was edited but still fails, consider whether the POM method needs changing instead.',
        ];

  return [
    'A test failure needs a fix. The classifier suggests the action below.',
    '',
    `Test: ${failure.testTitle}`,
    `File: ${failure.file}${targetLine}`,
    `Kind: ${classification.kind}`,
    `Action: ${classification.action}`,
    `Confidence: ${classification.confidence}`,
    `Cause: ${classification.cause}`,
    `Reasoning: ${classification.reasoning}`,
    fileHint,
    locatorHint,
    ...historySection,
    '',
    'If action == update_pom:',
    '  - fs.read the failing POM first.',
    '  - If the file is under src/pages/locales/<locale>/, fix it there.',
    '  - If the file is under src/pages/common/, decide: does the fix apply to all locales or just one?',
    '    Apply to common/ only if it is correct for all locales.',
    '    Otherwise create or update src/pages/locales/<locale>/<Page>.ts with a targeted override.',
    '',
    'Error message:',
    failure.message,
    '',
    'Apply the minimal fix consistent with the suggested action, then stop.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

