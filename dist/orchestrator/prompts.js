import { renderTestCase } from './testCase.js';
const GENERATE_SYSTEM = `You are a QA automation agent in the GENERATE phase.

Your job: translate a structured test case into a Playwright test.

Available tools:
  - fs.read: read any file in the repo to understand existing POMs and conventions
  - test.createSpec: create a new spec file (refuses if file exists)
  - test.addCase: add a test to an existing spec file (refuses on duplicate title)
  - ast.addImport: add imports to a spec or POM file
  - pom.updateSelector: update a selector on an existing page object
  - pom.editMethod: replace the body of a flow method on an existing page object

Rules:
  - Prefer existing POMs. Inspect src/pages/ before writing raw selectors.
  - If a POM is missing a method you need, extend it via pom.editMethod.
  - Always ensure imports exist via ast.addImport before referencing a symbol.
  - Stop as soon as the test is written. DO NOT run the test — execution happens outside this phase.

Output: after your last tool call, produce no further tool calls. The orchestrator takes over.`;
const FIX_SYSTEM = `You are a QA automation agent in the FIX phase.

A test you wrote (or an existing one) just failed. A rule-based classifier has identified the cause and suggested an action. Your job: apply the minimal fix.

Available tools:
  - fs.read: read any file to inspect current state
  - test.editCase: replace the body of a test
  - pom.updateSelector: swap a selector string on a page object field
  - pom.editMethod: replace the body of a flow method on a page object
  - ast.addImport: add an import if the fix requires a new symbol

Rules:
  - Respect the suggested action. If action == 'update_pom', edit the POM, not the test.
  - If action == 'update_test', edit the test, not the POM.
  - If action == 'retry', make NO edits — produce no tool calls. The orchestrator will re-run.
  - Make the smallest correct change. Do not refactor unrelated code.

Stop as soon as the fix is applied. DO NOT re-run tests — execution happens outside this phase.`;
export function generateSystemPrompt() {
    return GENERATE_SYSTEM;
}
export function fixSystemPrompt() {
    return FIX_SYSTEM;
}
export function generateTask(tc, defaultSpecFile) {
    const specFile = tc.specFile ?? defaultSpecFile;
    return [
        'Create a Playwright test for the following test case.',
        '',
        renderTestCase(tc),
        '',
        `Write the test to: ${specFile}`,
        '',
        'Steps:',
        '  1. Read the target spec file (if it exists) to understand conventions, or prepare to create it.',
        '  2. Read relevant POMs under src/pages/ to learn what methods are available.',
        '  3. Use test.createSpec if the spec file does not yet exist.',
        '  4. Use ast.addImport to add needed imports (Playwright test/expect, POM classes).',
        '  5. Use test.addCase to insert the test.',
        '  6. Stop.',
    ].join('\n');
}
export function fixTask(failure, classification) {
    const targetLine = failure.line !== undefined ? `:${failure.line}` : '';
    const locatorHint = classification.fixTarget?.locator
        ? `Failing locator: ${classification.fixTarget.locator}`
        : '';
    const fileHint = classification.fixTarget?.file
        ? `Suspected file: ${classification.fixTarget.file}`
        : '';
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
        '',
        'Error message:',
        failure.message,
        '',
        'Apply the minimal fix consistent with the suggested action, then stop.',
    ]
        .filter((l) => l !== '')
        .join('\n');
}
//# sourceMappingURL=prompts.js.map