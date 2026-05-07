import type { Classification } from '../../failure/rules.js';
import type { NormalizedFailure } from '../../tools/exec/parseReport.js';
import type { FixAttempt } from '../state.js';

interface BrowseCreds { email?: string; password?: string; baseUrl?: string; }

function credentialsHint(browse?: BrowseCreds): string {
  if (!browse?.email || !browse?.password) return '';
  return `\n\nApp credentials (use these if you need to log in while browsing):\n  Email: ${browse.email}\n  Password: ${browse.password}`;
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

export function fixSystemPrompt(browse?: BrowseCreds): string {
  return buildFixSystem(browse);
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
