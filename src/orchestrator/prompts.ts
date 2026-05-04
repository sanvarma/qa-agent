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
  return `You are a QA automation agent. Translate the test case into a passing Playwright test.

## Tools
framework.getGraph — complete POM inventory (fields, method signatures, fixture status, locale overrides). Call ONCE at step 1. Never guess POM names, field names, or locale names — only use what appears here.
testData.getSchema — real field names for a dataset; call BEFORE using testData, never guess fields.
fs.read — read repo files (spec files, method bodies when editing). pom.createPage+fixture.addPage — create/register new POMs.
pom.addSelector / pom.updateSelector / pom.editMethod — modify existing POMs.
test.createSpec / test.addCase — scaffold and populate spec files.
ast.addImport — add non-fixture imports only.${browse ? `
browse.navigate / browse.snapshot / browse.click / browse.type / browse.hover / browse.evaluate — live browser.` : ''}

## Framework
POMs: src/pages/common/<Page>.ts (base) · src/pages/locales/<locale>/<Page>.ts (override, extends common).
Fixtures: import { test, expect } from src/fixtures/pages.fixture.ts — NEVER from @playwright/test.
  page · appLocale (worker locale string) · testData (function) · all registered page fixtures.
Tests: tests/generic/ (all locales) · tests/locales/<locale>/ (locale-only, always serial).

## Locale scope
generic → write to tests/generic/. After test.addCase succeeds, run step 9 (companion check).
<locale> → write to tests/locales/<locale>/; read locale POM overrides; pass serial:true to test.createSpec.

## Rules
ASSERTIONS: test MUST assert what 'Expected' describes. Trivial title checks are forbidden.
FIXTURES: framework.getGraph tells you the fixture name for every POM (the "fixture" field). If a POM you need
  has fixture: null, call fixture.addPage to register it before test.addCase. Never use a fixture name not
  listed in the graph — Playwright will throw "unknown parameter".
POMS: use field and method names EXACTLY as returned by framework.getGraph. Never guess names.
  Method signatures are in the graph — if goto() has no parameters in the signature, call it with no arguments.
  Never assume parameters from a method body (super.goto('/login') inside goto() does NOT mean the caller
  passes a URL — it is hardcoded). fs.read a POM only when you need to edit its method body.
  Missing POM → pom.createPage + fixture.addPage. Missing field → pom.addSelector. Wrong selector → pom.updateSelector.
  Never inline raw selectors or page.locator() in the spec body.
NAVIGATION CLICKS: use a POM field whose selector is an anchor (a[, a:, a., starts with 'a ') or name ends in Link/Button. Never click images or divs to navigate.
LIST PAGES: locators on list pages match multiple elements — append .first() when clicking.
  CORRECT: productsPage.viewProductLink.first().click()  WRONG: productsPage.viewProductLink.click()
STEP BUDGET: max 40 steps. Read ≤5 files then write. If on step 8+ without test.addCase, write now.
READS: only read files named in the test case or Expected. No BasePage, no "convention" reads. No re-reads.
AUTH: never browse pages behind login (order confirmation, payment, account). Write from POM + steps only.
  Public pages are fine to browse: login page, products, product detail, cart.${browse ? `
BROWSE NAVIGATE: use browse.navigate to go to URLs — never browse.click on links/anchors.
  browse.snapshot after browse.navigate is redundant — navigate already returns the full snapshot.
  Each URL once only. browse.navigate returns complete snapshot — use it, don't re-fetch.
BROWSE CLICK: allowed only when a URL cannot reach the state — form submissions (login errors, order confirm),
  modals, dropdowns. After a click causes navigation, call browse.snapshot once; never browse.navigate again.
LOCALE FS: never use browse.* for file checks. Use framework.getGraph for locale discovery.
ARIA→CSS: snapshots use ARIA ('textbox "Email"') — convert to CSS ('input[data-qa="email"]') before using in selectors.
SELECTOR ORDER: data-testid > id > class > placeholder/type/attr > text. Use browse.evaluate when id/class/testid not visible.
SELECTOR QUALITY: no dynamic values in selectors (product names, prices). Use structural paths.
  BAD: this.loc('h2:has-text("Blue Top")')  GOOD: this.loc('.product-information h2')` : ''}
DOWNLOAD: for download assertions use the download event inline (only allowed inline page API):
  const [download] = await Promise.all([page.waitForEvent('download'), page.downloadButton.click()]);
  expect(download.suggestedFilename()).toMatch(/invoice/i);
TESTDATA: call testData.getSchema('users') before writing — use returned fields, never guess.
  const user = await testData<{ <field1>: string; <field2>: string }>('users');
  Add 'testData' to fixtures array in test.addCase.
PAGE ACCESS: never access pom.page directly in a test — it is protected. Use the 'page' fixture from test args instead (it is the same Playwright Page instance).
ASSERTIONS: toBeGreaterThan() takes a plain number — toBeGreaterThan(0), NOT toBeGreaterThan({ min: 0 }).
IMPORTS: ast.addImport for non-fixture symbols only. test.createSpec emits the fixture import automatically.
BATCH: combine independent tool calls in one response. Stop after last tool call.${credentialsHint(browse)}`;
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
        `       a. Use the framework.getGraph result from step 1. If all pages have empty localeOverrides, skip to step 10.`,
        `       b. For each locale that has overrides in at least one POM this test uses:`,
        `          - The override fields and methods are already in the graph — no additional fs.read needed.`,
        `          - If the override changes fields or methods that this test exercises,`,
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
    '  1. In a single batched call: (a) framework.getGraph — full POM inventory with fields, method signatures,',
    '     fixture status, and locale overrides; (b) fs.read the target spec file if it exists.',
    '     framework.getGraph is your single source of truth for what POMs and locales exist.',
    '     Any POM with fixture: null must be registered with fixture.addPage before test.addCase.',
    isGeneric
      ? '  2. Locale scope is GENERIC — the test runs for every locale.'
      : `  2. Locale scope is ${targetLocale} — the test runs only for that locale.`,
    '  3. From the framework.getGraph result, identify which POMs the test needs:',
    '       a. Use field and method names exactly as listed in the graph for the common POM.',
    targetLocale
      ? `       b. If the graph shows localeOverrides["${targetLocale}"] for those POMs, use its fields/methods where they differ.`
      : '       b. For generic tests the fixture picks the right class at runtime — use common POM field names.',
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

