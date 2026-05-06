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
  has fixture: null, call fixture.addPage (without locale) to register it before test.addCase. Never use a
  fixture name not listed in the graph — Playwright will throw "unknown fixture" at runtime.
  pom.createPage and fixture.addPage are an ATOMIC PAIR — every createPage must have a fixture.addPage in the
  same batch, even if the POM is discovered late while writing the test body.
  Locale overrides (src/pages/locales/) are NOT registered as fixtures — they are added to the locale map of
  an existing fixture via fixture.addPage with locale param. The common POM must be registered first.
POMS: use field and method names EXACTLY as returned by framework.getGraph. Never guess names.
  Method signatures are in the graph — if goto() has no parameters in the signature, call it with no arguments.
  Never assume parameters from a method body (super.goto('/login') inside goto() does NOT mean the caller
  passes a URL — it is hardcoded). fs.read a POM only when you need to edit its method body.
  Missing POM → pom.createPage (file MUST be src/pages/common/<ClassName>.ts — flat, NO subdirectories) + fixture.addPage.
  Missing field → pom.addSelector. Wrong selector → pom.updateSelector.
  Never inline raw selectors or page.locator() in the spec body.
POM METHODS: When a test case step is a single named action (e.g. "Log in", "Add product to cart")
  but requires 2+ sequential interactions on the same page, you MUST create a method on that POM.
  The test body MUST call the method (e.g. await loginPage.login(user.username, user.password)) —
  spelling out the individual fill/click steps inline in the test body is FORBIDDEN.
  This restriction applies only to multi-step interaction sequences (fill + fill + click, etc.).
  Assertions (expect statements) and single-field interactions are always written inline — this is correct.
  — Use pom.editMethod to add the method (e.g. async login(username: string, password: string)).
  — The method body uses this.fieldName references and awaits each interaction.
  — Check framework.getGraph first — if a suitable method already exists on the POM, use it.
  — TIMING: method creation must happen as soon as the POM is confirmed to need it — not deferred.
    • For existing POMs (already in the graph): at step 3, check each POM the test needs. If a
      multi-step action is required and no suitable method exists in the graph, call pom.editMethod
      immediately — before any browse.navigate or pom.createPage calls.
    • For new POMs (created via pom.createPage): call pom.editMethod immediately after pom.createPage
      in the same batch, before fixture.addPage.
    In both cases: do NOT defer method creation to after all POMs and fixtures are registered.
NAVIGATION CLICKS: use a POM field whose selector is an anchor (a[, a:, a., starts with 'a ') or name ends in Link/Button. Never click images or divs to navigate.
LIST PAGES: locators on list pages match multiple elements — append .first() when clicking.
  CORRECT: productsPage.viewProductLink.first().click()  WRONG: productsPage.viewProductLink.click()
STEP BUDGET: max 40 steps total. Hard gates — these are ABSOLUTE, not guidelines:
  - Steps 1–3: read + browse only (framework.getGraph, fs.read spec, at most 3 browse.navigate).
  - Steps 4–6: create missing POMs, register fixtures (pom.createPage, fixture.addPage).
  - Step 7 at the latest: test.createSpec (if file missing) + test.addCase. No exceptions.
  If step 7 arrives and POMs are not perfect, write the test anyway — FIX phase corrects selectors.
  Never postpone test.createSpec / test.addCase past step 7. No browsing after step 6.
  An empty or sparse framework.getGraph is NOT a reason to browse more — create POMs from structural patterns and proceed.
READS: only read files named in the test case or Expected. No BasePage, no "convention" reads. No re-reads.
  Never fs.read a file you just created or modified — pom.createPage / pom.addSelector results contain the full contents.
  NEVER fs.read pages.fixture.ts — it is managed by the agent tools. Fixture names come from framework.getGraph only.
  NEVER fs.read a directory path — fs.read is for files only; reading a directory always returns an error.
AUTH: never browse pages that require login or prior app state (checkout, payment, order confirmation, account).
  These pages render ad-heavy empty shells or redirect when visited without auth — snapshots are useless and bloat context.
  Write selectors for these pages from structural patterns only (a[href*='keyword'], button[type='submit'], input[name='field']).
  Public pages are fine to browse: login page, products list, product detail, cart.${browse ? `
BROWSE NAVIGATE: use browse.navigate to go to URLs — never browse.click on links/anchors.
  browse.snapshot after browse.navigate is a CRITICAL VIOLATION — navigate already returns the full snapshot.
  Never call browse.snapshot in the same turn as browse.navigate. Never call browse.snapshot on the turn
  immediately after a browse.navigate turn. Either violation doubles context size and burns your step budget.
  HARD LIMIT: Max 3 browse.navigate calls total across the entire generate phase. Each URL at most once.
  Once you have made 3 browse.navigate calls, stop all browsing immediately — no more browse.* tool calls.
  Derive all selectors for a page from its single navigate result — do NOT re-navigate or evaluate to discover more.
  An empty framework.getGraph result does NOT justify extra browsing — create POMs from structural patterns and write the test.
BROWSE CLICK: allowed only when a URL cannot reach the state — form submissions (login errors, order confirm),
  modals, dropdowns. After a click causes navigation, call browse.snapshot once; never browse.navigate again.
  Do NOT click to discover selectors — make best-guess selectors from the snapshot, fix in FIX phase if wrong.
LOCALE FS: never use browse.* for file checks. Use framework.getGraph for locale discovery.
ARIA→CSS: snapshots use ARIA ('textbox "Email"') — convert to CSS ('input[data-qa="email"]') before using in selectors.
SELECTOR ORDER: data-testid > id > class > placeholder/type/attr > text.
  This order is a PREFERENCE, not a licence to guess. Every selector you write must be confirmed by a tool result
  (browse.navigate snapshot, browse.evaluate output, or pom field already in the graph).
  — data-testid / data-qa: only use a value you have SEEN in a snapshot. Never invent one (e.g. data-testid='email'
    is wrong if the snapshot did not show that attribute on that element).
  — class names: only use a class you have SEEN. Never construct one from the element's purpose.
  — When no snapshot is available, fall back to universally-reliable selectors:
      input[type='email'], input[type='password'], button[type='submit'], a[href*='keyword'].
  — For navigation links (any field whose name ends in Link or Button and targets an anchor): ALWAYS use
      a[href*='keyword'], never a:has-text(...) or a guessed class. Examples:
      proceedToCheckoutButton → a[href*='checkout']
      viewCartButton → a[href*='cart']
      viewProductLink → a[href*='product'] (then .first() on list pages)
      continueShoppingLink → a[href*='products']
SELECTOR QUALITY: no dynamic values in selectors (product names, prices). Use structural paths.
  BAD: this.loc('h2:has-text("Blue Top")')  GOOD: this.loc('.product-information h2')` : ''}
DOWNLOAD: for download assertions use the download event inline (only allowed inline page API):
  const [download] = await Promise.all([page.waitForEvent('download'), page.downloadButton.click()]);
  expect(download.suggestedFilename()).toMatch(/invoice/i);
TESTDATA: NEVER hardcode email addresses, passwords, usernames, or other user-specific values.
  Any test step that involves login, registration, or filling user credentials MUST use testData.
  Mandatory steps when a test uses credentials:
    a. Call testData.getSchema('users') BEFORE writing the test body — note the EXACT field names returned.
    b. CRITICAL: Add 'testData' to the fixtures array in test.addCase — e.g. fixtures: ["loginPage", "testData"].
       If 'testData' is NOT in the fixtures array, Playwright will not inject it and testData() will throw
       "testData is not a function" at runtime. This is the most common mistake — do not skip it.
    c. In the test body, call synchronously (NOT await): const user = testData<{ <field1>: string }>('users');
    d. Use the exact field names from getSchema — e.g. if getSchema returns ["locale","username","password"],
       use user.username and user.password — NEVER user.email or any name you invented.
  If testData.getSchema throws (key not found in data files), you may hardcode those specific values only.
  Payment card details (card number, CVC, expiry) are not in testData — hardcode them with realistic test values.
PAGE ACCESS: never access pom.page directly in a test — it is protected. Use the 'page' fixture from test args instead (it is the same Playwright Page instance).
EVALUATE: never use page.evaluate / window / document in test bodies. If a POM field is missing, use pom.addSelector — never inline raw DOM queries in tests.
PAGE API: in test bodies, do NOT call page.waitForURL(), page.waitForNavigation(), page.waitForSelector(), or any other page.waitFor*() method.
  Playwright's auto-waiting handles navigation. After an action that causes navigation (e.g. login submit), simply call the next POM's goto() or interact with the next POM directly.
  WRONG: await loginPage.submitLoginButton.click(); await page.waitForURL('**/account');
  RIGHT:  await loginPage.submitLoginButton.click(); await productsPage.goto();
  The only allowed raw page.* calls are: page.goto() for URLs not covered by any POM goto(), and page.waitForEvent('download') in the download pattern.
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
    When creating a NEW locale override with pom.createPage, also call fixture.addPage with the
    locale param to register it in the fixture locale map.
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
  - If the error is page.waitForURL timing out: remove the waitForURL call entirely — do NOT replace it with a different URL.
    After login or a form submit, Playwright's auto-waiting is sufficient. The next step (goto() or a POM interaction) handles navigation implicitly.
  - When action == 'update_pom' and the error is a STRICT MODE VIOLATION ("resolved to N elements"):
    The error message lists every matched element with its actual attributes — read them carefully.
    Narrow the selector using an attribute shown in the error (e.g. data-qa, name, placeholder)
    that uniquely identifies the correct element. No browsing needed — the answer is in the error output.
    Example: error shows login-email input has data-qa="login-email" → use input[data-qa="login-email"].
  - When action == 'update_pom' and the error is "no element found" (0 matches, or locator timeout):
    First check if the failing page requires authentication or specific app state
    (cart, checkout, payment, order confirmation, account pages).
    AUTH-GATED / STATEFUL pages — do NOT browse to these; you cannot authenticate or populate state:
      cart (/view_cart), checkout (/checkout), payment, order confirmation, account, profile.
      Instead apply a structural fix directly:
        • Navigation links (name ends in Link/Button, selector starts with 'a'): replace with a[href*='<keyword>'].
          Keyword examples: cart→'cart', checkout→'checkout', login→'login', products→'products'.
          'Proceed To Checkout' link → a[href*='checkout']
          'View Cart' link → a[href*='cart']
          'Continue Shopping' link → a[href*='products']
        • Form submit buttons: replace with button[type='submit'].
        • If the field type is neither of the above, fs.read the POM and apply the most specific
          structural selector you can derive from the field name and context.
    PUBLIC pages (login, products list, product detail) — browse.navigate then browse.snapshot to find the correct selector.
    Do not guess data-* attribute values — use href-patterns or type-based selectors for auth-gated pages.
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
        `          - If the locale override POM file exists (in localeOverrides) but is NOT yet in the fixture`,
        `            locale map, call fixture.addPage with locale param to register it:`,
        `            fixture.addPage({ className, fixtureName, importFrom: 'src/pages/locales/<locale>/<Page>.ts', locale: '<locale>' })`,
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
    '  4. If browse.* tools are available and the test needs live selector discovery:',
    '     - HARD LIMIT: max 3 browse.navigate calls total in this entire run. Once reached, stop all browsing.',
    '     - Go directly to the specific page URL — never start at the base URL.',
    `     (e.g. ${baseUrl ?? 'https://your-app.com'}/products — not the home page)`,
    '     - The navigate response IS the snapshot — NEVER call browse.snapshot after browse.navigate.',
    '       Calling browse.snapshot after browse.navigate is a CRITICAL ERROR — it doubles context size and wastes your step budget.',
    '     - Derive ALL selectors for that page from the single navigate result. Do not re-navigate or evaluate.',
    '     - After step 4, move immediately to step 5 — no more browsing under any circumstances.',
    '     - Do NOT click around to discover selectors. Make your best guess from the snapshot; FIX phase corrects wrong selectors.',
    '     - SKIP this step entirely when all needed POMs exist in the graph with the right fields.',
    '     - An empty framework.getGraph result does NOT justify extra browsing — create POMs from structural patterns.',
    '  5. For EVERY pom.createPage call, fixture.addPage MUST be called in the same batch — no exceptions.',
    '     This applies even if the POM is created late (step 6, 7, or alongside test.addCase).',
    '     A POM without a registered fixture causes Playwright to throw "unknown fixture" at runtime.',
    '     Do NOT call fixture.addPage for locale override POMs here — see step 9b.',
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

