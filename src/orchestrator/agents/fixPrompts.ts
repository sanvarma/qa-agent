import type { Classification } from '../../failure/rules.js';
import type { NormalizedFailure } from '../../tools/exec/parseReport.js';
import type { FixAttempt } from '../state.js';

interface BrowseCreds { email?: string; password?: string; baseUrl?: string; }

function credentialsHint(browse?: BrowseCreds): string {
  if (!browse?.email || !browse?.password) return '';
  const urlLine = browse.baseUrl ? `\n  Base URL: ${browse.baseUrl}` : '';
  return `\n\nApp credentials (use these if you need to log in while browsing):${urlLine}\n  Email: ${browse.email}\n  Password: ${browse.password}`;
}

function buildFixSystem(browse?: BrowseCreds): string {
  return `You are a QA automation agent in the FIX phase.

A test you wrote (or an existing one) just failed. A rule-based classifier has identified the cause and suggested an action. Your job: apply the minimal fix.

Available tools:
  - fs.read: read any file to inspect current state
  - page.extractElements: navigate to a page and get real element selectors. Handles auth-gated pages via setupFlow.
  - test.editCase: replace the body of a test
  - pom.updateSelector: swap a selector string on a page object field
  - pom.editMethod: replace the body of a flow method on a page object
  - ast.addImport: add an import if the fix requires a new symbol

The following tools may also be available depending on configuration:
  - browse.navigate: open a URL in a live browser
  - browse.snapshot: get the accessibility tree of the current page
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
    Narrow the selector using an attribute shown in the error (e.g. data-testid, data-test, id, name, placeholder)
    that uniquely identifies the correct element. No browsing needed — the answer is in the error output.
    Example: error shows element has data-testid="submit-btn" → use [data-testid="submit-btn"].
  - When action == 'update_pom' and the error is "no element found" (0 matches, or locator timeout):
    Use page.extractElements to discover the correct selector from the live page.
    PUBLIC pages (no login required): page.extractElements(url) — navigate directly.
    AUTH-GATED / STATEFUL pages (cart, checkout, account, order confirmation):
      page.extractElements(url, { setupFlow: '<flow>', filter: '<keyword>' }) where flow is one of:
        'account'  — login only
        'cart'     — login + add product + go to cart
        'checkout' — login + add product + cart + proceed to checkout
        'payment'  — login + add product + cart + checkout + place order
      Credentials are loaded automatically — do not pass them manually.
      Always pass filter: set it to the meaningful part of the failing locator string
      (e.g. failing locator '[data-test="checkout-BROKEN"]' → filter: 'checkout').
      filter is case-insensitive and matches against element text, selectors, and attributes —
      it returns only elements that match, keeping the response small.
      Pick the flow that matches the failing page. The tool returns real element selectors
      from the live authenticated page — use bestSelector from the matching element to fix the POM field.
      Call page.extractElements ONCE only. Do not retry it or fall back to browse.* tools after calling it.
  - CRITICAL — if extractElements returns an element whose selectors match the EXISTING POM selector
    (or are functionally equivalent — e.g. existing '[data-test="checkout"]' vs returned 'button[data-test="checkout"]'),
    then the POM selector is NOT the bug. The element exists at that selector on the live page.
    The test never REACHED that page. The bug is upstream — in the test step or POM method called BEFORE
    the failing line. Read the failing test, identify the previous step (the POM method called on the
    line just before the failing one), fs.read that POM, inspect its method body, and use pom.editMethod
    to fix it. Do NOT update the selector that was already correct — that would be a no-op fix.
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
    '  - When calling page.extractElements, always include filter: set to the key word from the failing locator',
    '    (e.g. locator [data-test="checkout-BROKEN"] → filter: "checkout"). This keeps the result small.',
    '',
    'Error message:',
    failure.message,
    '',
    'Apply the minimal fix consistent with the suggested action, then stop.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
