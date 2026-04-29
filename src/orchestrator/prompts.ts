import type { TestCase } from './testCase.js';
import { renderTestCase } from './testCase.js';
import type { Classification } from '../failure/rules.js';
import type { NormalizedFailure } from '../tools/exec/parseReport.js';
import type { FixAttempt } from './state.js';

function buildGenerateSystem(): string {
  return `You are a QA automation agent in the GENERATE phase.

Your job: translate a structured test case into a Playwright test that ACTUALLY exercises the assertion described in 'Expected'.

Available tools:
  - fs.read: read any file in the repo to understand existing POMs and conventions
  - test.createSpec: create a new spec file (refuses if file exists)
  - test.addCase: add a test to an existing spec file (refuses on duplicate title)
  - ast.addImport: add imports to a spec or POM file
  - pom.updateSelector: update a selector on an existing page object
  - pom.editMethod: replace the body of a flow method on an existing page object

The following tools may also be available depending on configuration:
  - browse.navigate: open a URL in a live browser (use to inspect the real app)
  - browse.snapshot: get the accessibility tree of the current page
  - browse.click / browse.type / browse.hover: drive the live page to reach the state you need to inspect

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
  - If a POM is missing a method you need, extend it via pom.editMethod. Do NOT inline raw selectors in the spec when a POM exists.
  - If browse.* tools are present and you cannot tell whether a POM selector is correct, use browse.navigate to the app's base URL and browse.snapshot to confirm the element exists before writing the test. If the selector is wrong, use pom.updateSelector to fix it BEFORE generating the test.
  - Always ensure imports exist via ast.addImport before referencing a symbol.
  - Stop as soon as all required spec files are written. DO NOT run the test — execution happens outside this phase.

Output: after your last tool call, produce no further tool calls. The orchestrator takes over.`;
}

function buildFixSystem(): string {
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
  - If action == 'update_test', edit the test, not the POM.
  - If action == 'retry', make NO edits — produce no tool calls. The orchestrator will re-run.
  - When the failing locator does not match anything (kind == 'selector' and action == 'update_pom'),
    and browse.* tools are present, you MUST use browse.navigate to the app's base URL and
    browse.snapshot to find a working selector BEFORE calling pom.updateSelector.
    Do not guess a replacement selector — confirm against the live DOM.
  - Make the smallest correct change. Do not refactor unrelated code.

Stop as soon as the fix is applied. DO NOT re-run tests — execution happens outside this phase.`;
}

export function generateSystemPrompt(): string {
  return buildGenerateSystem();
}

export function fixSystemPrompt(): string {
  return buildFixSystem();
}

// Resolve the effective single locale from localeScope.
// Used for spec file path and prompt context — not for browse URL (see browseUrl.ts).
function resolveTargetLocale(localeScope: string | string[]): string | null {
  if (localeScope === 'generic' || localeScope === 'global') return null;
  if (Array.isArray(localeScope)) return localeScope.length > 0 ? localeScope[0] : null;
  return localeScope;
}

export function generateTask(tc: TestCase, defaultSpecFile: string): string {
  const targetLocale = resolveTargetLocale(tc.localeScope ?? 'generic');
  const isGeneric = targetLocale === null;
  const specFile = tc.specFile ?? (
    targetLocale
      ? `tests/locales/${targetLocale}/agent-generated.spec.ts`
      : defaultSpecFile
  );

  const companionStep = isGeneric
    ? [
        `  8. Companion locale specs (generic tests only):`,
        `     After the generic test is written, check src/pages/locales/ for any locale override folders.`,
        `     For each locale folder found:`,
        `       a. fs.read src/pages/locales/<locale>/<Page>.ts for every POM the test references.`,
        `       b. If the override changes selectors or methods that this test exercises,`,
        `          scaffold a companion spec at tests/locales/<locale>/<same-filename> using`,
        `          test.createSpec, add test.describe.configure({ mode: 'serial' }) at the top,`,
        `          then use test.addCase to write a test that targets the locale-specific behaviour.`,
        `          Import { test, expect } from src/fixtures/pages.fixture.ts as usual.`,
        `       c. If the locale has no override for the POMs this test uses, skip it.`,
        `  9. Stop.`,
      ]
    : [
        `  8. Stop.`,
      ];

  return [
    'Create a Playwright test for the following test case.',
    '',
    renderTestCase(tc),
    '',
    `Write the test to: ${specFile}`,
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
    '  4. If browse.* tools are available AND you are unsure whether a POM selector is correct,',
    '     use browse.navigate + browse.snapshot to inspect the live app,',
    '     and pom.updateSelector to fix the POM if needed.',
    '  5. Use test.createSpec if the spec file does not yet exist.',
    targetLocale
      ? '     Add test.describe.configure({ mode: \'serial\' }) at the top — locale-specific specs always run serially.'
      : '     Generic specs do not need mode: serial.',
    '  6. Use ast.addImport to add needed imports.',
    '     ALWAYS import { test, expect } from src/fixtures/pages.fixture.ts — never from @playwright/test.',
    '  7. Use test.addCase to insert the test.',
    '     The body MUST start with `const <varname> = new <POMClass>(page);` if the fixture does not',
    '     already provide the page object. If the pages.fixture.ts exposes it (e.g. loginPage,',
    '     checkoutPage), destructure it from the test args instead — do not instantiate it manually.',
    '     Then `await <varname>.goto();` and ONLY then exercise the Expected assertion using POM fields.',
    '     Tests without page-object instantiation or fixture destructuring will throw ReferenceError — DO NOT emit them.',
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

