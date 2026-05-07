import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';

// Import just the DOM walker script — we test it directly against a local page
// rather than hitting a live URL, so the test is fast and deterministic.
// We re-export DOM_WALKER_SCRIPT from the tool for this purpose.
import { DOM_WALKER_SCRIPT } from '../../../src/tools/browser/extractElements.js';
import type { ExtractedElement } from '../../../src/tools/browser/extractElements.js';

// HTML fixture covering every selector type the walker handles
const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<body>
  <!-- data-qa (highest priority) -->
  <input data-qa="login-email" type="email" placeholder="Email Address" />

  <!-- data-testid (second priority) -->
  <input data-testid="signup-name" type="text" placeholder="Full Name" />

  <!-- id without digits (third priority) -->
  <input id="search-box" type="search" placeholder="Search" />

  <!-- id with 3+ digits — should be skipped, fall back to type -->
  <input id="field-1234" type="password" placeholder="Password" />

  <!-- name attribute -->
  <select name="country"><option value="us">US</option></select>

  <!-- button with data-qa -->
  <button data-qa="login-button" type="submit">Login</button>

  <!-- button with data-testid -->
  <button data-testid="cancel-btn">Cancel</button>

  <!-- button type only, no data attrs -->
  <button type="button">Reset</button>

  <!-- anchor with href — should become href pattern -->
  <a href="/products/list">View Products</a>

  <!-- anchor with external href — segment should be 'products' -->
  <a href="/view_cart">Cart</a>

  <!-- duplicate bestSelector — second should be deduplicated -->
  <input data-qa="login-email" type="email" placeholder="Duplicate" />

  <!-- hidden input — should be excluded -->
  <input type="hidden" name="csrf" value="abc123" />

  <!-- aria-label fallback -->
  <button aria-label="Close dialog">X</button>
</body>
</html>`;

async function runWalker(page: Page): Promise<ExtractedElement[]> {
  return page.evaluate(DOM_WALKER_SCRIPT) as Promise<ExtractedElement[]>;
}

describe('extractElements — DOM walker', () => {
  let browser: Browser;
  let page: Page;

  test('setup', async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(FIXTURE_HTML);
  });

  test('data-qa wins as bestSelector', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.selectors['data-qa'] === "input[data-qa='login-email']");
    assert.ok(el, 'should find element with data-qa');
    assert.equal(el.bestSelector, "input[data-qa='login-email']");
    assert.equal(el.selectors['data-qa'], "input[data-qa='login-email']");
    assert.equal(el.selectors['type'], "input[type='email']");
    assert.equal(el.selectors['placeholder'], "input[placeholder='Email Address']");
  });

  test('data-testid wins over id/name/type', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.selectors['data-testid'] === "input[data-testid='signup-name']");
    assert.ok(el, 'should find element with data-testid');
    assert.equal(el.bestSelector, "input[data-testid='signup-name']");
  });

  test('clean id (no digits) is used as bestSelector', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.selectors['id'] === '#search-box');
    assert.ok(el, 'should find element with clean id');
    assert.equal(el.bestSelector, '#search-box');
  });

  test('numeric id (3+ digits) is skipped — falls back to type', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.selectors['placeholder'] === "input[placeholder='Password']");
    assert.ok(el, 'should find password input');
    assert.ok(!el.selectors['id'], 'numeric id should be excluded');
    assert.equal(el.bestSelector, "input[type='password']");
  });

  test('select uses name attribute', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.tag === 'select');
    assert.ok(el, 'should find select element');
    assert.equal(el.selectors['name'], "select[name='country']");
    assert.equal(el.bestSelector, "select[name='country']");
  });

  test('button with data-qa uses data-qa as bestSelector', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.selectors['data-qa'] === "button[data-qa='login-button']");
    assert.ok(el, 'should find login button');
    assert.equal(el.bestSelector, "button[data-qa='login-button']");
    assert.equal(el.selectors['type'], "button[type='submit']");
  });

  test('button with data-testid uses data-testid as bestSelector', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.selectors['data-testid'] === "button[data-testid='cancel-btn']");
    assert.ok(el, 'should find cancel button');
    assert.equal(el.bestSelector, "button[data-testid='cancel-btn']");
  });

  test('button with type only uses type as bestSelector', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.text === 'Reset');
    assert.ok(el, 'should find reset button');
    assert.equal(el.bestSelector, "button[type='button']");
  });

  test('anchor href becomes a pattern selector', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.text === 'View Products');
    assert.ok(el, 'should find products link');
    assert.equal(el.bestSelector, "a[href*='products']");
  });

  test('cart link href becomes pattern', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.text === 'Cart');
    assert.ok(el, 'should find cart link');
    assert.equal(el.bestSelector, "a[href*='view_cart']");
  });

  test('duplicate bestSelector is deduplicated', async () => {
    const elements = await runWalker(page);
    const dupes = elements.filter(e => e.bestSelector === "input[data-qa='login-email']");
    assert.equal(dupes.length, 1, 'duplicate selector should appear only once');
  });

  test('hidden input is excluded', async () => {
    const elements = await runWalker(page);
    const hidden = elements.find(e => e.selectors['name'] === "input[name='csrf']");
    assert.equal(hidden, undefined, 'hidden input should be excluded');
  });

  test('aria-label used as fallback when no other attrs present', async () => {
    const elements = await runWalker(page);
    const el = elements.find(e => e.text === 'X');
    assert.ok(el, 'should find close button');
    assert.equal(el.bestSelector, "[aria-label='Close dialog']");
  });

  test('teardown', async () => {
    await browser.close();
  });
});
