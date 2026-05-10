import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import type { Page, Browser } from 'playwright';
import type { Tool, ToolContext } from '../tool.js';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const SetupFlow = z.enum(['cart', 'checkout', 'payment', 'account']);
type SetupFlow = z.infer<typeof SetupFlow>;

const Input = z.object({
  url: z.string().describe('Full URL of the page to extract elements from'),
  setupFlow: SetupFlow.optional().describe(
    'Predefined setup flow to reach state-dependent pages. ' +
    'cart: login + add product. ' +
    'checkout: login + add product + go to cart + proceed. ' +
    'payment: login + add product + cart + checkout. ' +
    'account: login only.',
  ),
  locale: z.string().optional().describe(
    "Locale key to pick credentials from testData, e.g. 'en-gb'. Defaults to first record found.",
  ),
  filter: z.string().optional().describe(
    'Case-insensitive substring to filter returned elements. ' +
    'Only elements whose text content, bestSelector, or any selector value contains this string are returned. ' +
    'Use when you are looking for a specific element and want to reduce noise.',
  ),
});
type Input = z.infer<typeof Input>;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ExtractedElement {
  tag: string;
  text: string;
  selectors: Record<string, string>;
  bestSelector: string | null;
}

export interface ExtractElementsOutput {
  url: string;
  elements: ExtractedElement[];
}

// ---------------------------------------------------------------------------
// Credentials loader
// ---------------------------------------------------------------------------

async function loadCredentials(
  repoRoot: string,
  locale?: string,
): Promise<{ username: string; password: string } | null> {
  const dataRoot = resolve(repoRoot, 'src', 'data');

  async function findJsonFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: string[];
    try { entries = await readdir(dir); } catch { return results; }
    for (const e of entries) {
      const full = join(dir, e);
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) results.push(...await findJsonFiles(full));
      else if (e.endsWith('.json')) results.push(full);
    }
    return results;
  }

  const files = await findJsonFiles(dataRoot);
  for (const file of files) {
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown[]>;
      const users = parsed['users'];
      if (!Array.isArray(users) || users.length === 0) continue;
      const record = locale
        ? (users.find((u: unknown) => (u as Record<string, string>).locale === locale) ?? users[0])
        : users[0];
      if (record && typeof record === 'object') {
        const r = record as Record<string, string>;
        if (r.username && r.password) return { username: r.username, password: r.password };
      }
    } catch { continue; }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOM walker — runs inside the browser via page.evaluate()
// Defined as a string to avoid tsx injecting __name helpers that break
// serialization when the function is sent to the browser context.
// Exported so unit tests can run it against a local HTML fixture.
// ---------------------------------------------------------------------------

export const DOM_WALKER_SCRIPT = `
(function(PRIORITY) {

  function buildSelectors(el) {
    var tag = el.tagName.toLowerCase();
    var s = {};

    var dataQa = el.getAttribute('data-qa');
    var dataTestid = el.getAttribute('data-testid');
    var dataTest = el.getAttribute('data-test');
    var id = el.id;
    var name = el.getAttribute('name');
    var type = el.getAttribute('type');
    var href = el.getAttribute('href');
    var placeholder = el.getAttribute('placeholder');
    var ariaLabel = el.getAttribute('aria-label');

    if (dataQa)     s['data-qa']     = tag + "[data-qa='" + dataQa + "']";
    if (dataTestid) s['data-testid'] = tag + "[data-testid='" + dataTestid + "']";
    if (dataTest)   s['data-test']   = tag + "[data-test='" + dataTest + "']";
    if (id && !/\\d{3,}/.test(id)) s['id'] = '#' + id;
    if (name)        s['name']        = tag + "[name='" + name + "']";
    if (type && type !== 'hidden') s['type'] = tag + "[type='" + type + "']";
    if (href) {
      try {
        var hrefPath = href.startsWith('/') ? href : new URL(href, window.location.origin).pathname;
        var segment = hrefPath.split('/').filter(Boolean)[0];
        if (segment) s['href'] = "a[href*='" + segment + "']";
      } catch(e) { /* invalid href */ }
      }
      if (placeholder) s['placeholder'] = tag + "[placeholder='" + placeholder + "']";
      if (ariaLabel)   s['aria-label']  = "[aria-label='" + ariaLabel + "']";

      return s;
    }

    var seen = {};
    var results = [];

    var nodes = document.querySelectorAll(
      'input:not([type="hidden"]), button, a[href], select, textarea, [role="button"]'
    );

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var selectors = buildSelectors(el);
      if (Object.keys(selectors).length === 0) continue;

      var best = null;
      for (var p = 0; p < PRIORITY.length; p++) {
        if (selectors[PRIORITY[p]]) { best = PRIORITY[p]; break; }
      }
      var key = best ? selectors[best] : null;
      if (key && seen[key]) continue;
      if (key) seen[key] = true;

      var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      results.push({
        tag: el.tagName.toLowerCase(),
        text: text,
        selectors: selectors,
        bestSelector: best ? selectors[best] : null
      });
    }

    return results;
  })
`;

const DEFAULT_PRIORITY = ['data-qa', 'data-testid', 'data-test', 'id', 'name', 'type', 'href', 'placeholder', 'aria-label'];

async function walkDOM(page: Page, priority: string[]): Promise<ExtractedElement[]> {
  // DOM_WALKER_SCRIPT is a function expression `(function(PRIORITY){...})`.
  // page.evaluate with a string just evaluates the expression — it does NOT call
  // the function or pass the arg. Convert to an IIFE by appending the call with
  // priority embedded directly so it runs immediately inside the browser.
  const iife = `(${DOM_WALKER_SCRIPT.trim()})(${JSON.stringify(priority)})`;
  return (page.evaluate(iife) as Promise<ExtractedElement[]>) ?? [];
}

// ---------------------------------------------------------------------------
// POM selector reader — reads a field selector from an existing common POM
// ---------------------------------------------------------------------------

export async function readFieldSelector(repoRoot: string, pomName: string, fieldName: string): Promise<string | null> {
  const pomPath = join(repoRoot, 'src', 'pages', 'common', `${pomName}.ts`);
  if (!existsSync(pomPath)) return null;
  try {
    const content = await readFile(pomPath, 'utf8');
    // Match: readonly <fieldName> = this.loc("<selector>"); or this.loc('<selector>');
    // Use alternation so single-quoted selectors can contain double quotes and vice versa.
    const re = new RegExp(
      `readonly\\s+${fieldName}\\s*=\\s*this\\.loc\\(` +
      `(?:"([^"]+)"|'([^']+)')` +
      `\\)`,
    );
    const m = re.exec(content);
    return m ? (m[1] ?? m[2] ?? null) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Setup flows
// ---------------------------------------------------------------------------

async function performLogin(page: Page, baseUrl: string, creds: { username: string; password: string }) {
  // Try root first (some apps have login at /), then /login
  for (const path of ['/', '/login']) {
    await page.goto(`${baseUrl}${path}`);
    await page.waitForLoadState('networkidle');
    if (await page.$('input[type="email"], input[type="password"], input[type="text"]')) break;
  }

  const emailSel =
    await page.$('input[type="email"]')  ? 'input[type="email"]'  :
    'input[type="text"]';
  const passSel = 'input[type="password"]';
  const btnSel =
    await page.$('button[type="submit"]') ? 'button[type="submit"]' :
    'input[type="submit"]';

  await page.fill(emailSel, creds.username);
  await page.fill(passSel, creds.password);
  await page.click(btnSel);
  await page.waitForLoadState('networkidle');
}

async function addProductToCart(page: Page, baseUrl: string) {
  // Find and click the first visible add-to-cart button on the current page
  const addBtn = page.locator('button:has-text("Add to cart"), button:has-text("Add To Cart"), [class*="add-to-cart"]').first();
  if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(500);
    // Dismiss any post-add modal
    const dismissBtn = page.locator('button:has-text("Continue"), button:has-text("Close"), [aria-label="Close"]').first();
    if (await dismissBtn.isVisible({ timeout: 1000 }).catch(() => false)) await dismissBtn.click();
  }
}

async function runConfigFlow(
  page: Page,
  baseUrl: string,
  steps: Array<{ action: string; selector?: string; pom?: string; field?: string; url?: string }>,
  creds: { username: string; password: string },
  repoRoot: string,
): Promise<void> {
  for (const step of steps) {
    switch (step.action) {
      case 'login':
        await performLogin(page, baseUrl, creds);
        break;
      case 'navigate': {
        const url = step.url!.startsWith('http') ? step.url! : `${baseUrl}${step.url}`;
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        break;
      }
      case 'click': {
        let selector = step.selector;
        // If pom+field given, try to read selector from existing POM file
        if (!selector && step.pom && step.field) {
          selector = await readFieldSelector(repoRoot, step.pom, step.field) ?? undefined;
        }
        if (!selector) throw new Error(`click step missing selector — pom '${step.pom}' field '${step.field}' not found on disk yet`);
        await page.locator(selector).first().click();
        await page.waitForLoadState('networkidle');
        break;
      }
    }
  }
}

async function runSetupFlow(page: Page, baseUrl: string, flow: SetupFlow, creds: { username: string; password: string }, ctx: ToolContext) {
  // Use config-driven flow if defined
  const configFlow = ctx.setupFlows?.[flow];
  if (configFlow && configFlow.length > 0) {
    try {
      await runConfigFlow(page, baseUrl, configFlow, creds, ctx.repoRoot);
      return;
    } catch (err) {
      // Config flow failed — typically because it references POM fields that
      // don't exist on disk yet during bootstrap (POM agent creating pages
      // for the first time). Fall through to the built-in generic flow so
      // extraction can still proceed.
      console.warn(
        `[extractElements] Config setupFlow '${flow}' failed: ${(err as Error).message}. ` +
        `Falling back to built-in generic flow.`,
      );
      // Reset page to a clean state before the fallback flow takes over.
      try { await page.goto(baseUrl); } catch { /* ignore */ }
    }
  }

  // Fall back to built-in generic sequences
  switch (flow) {
    case 'account':
      await performLogin(page, baseUrl, creds);
      break;
    case 'cart':
      await performLogin(page, baseUrl, creds);
      await addProductToCart(page, baseUrl);
      await page.locator('a[href*="cart"], [class*="cart"] a, [aria-label*="cart" i]').first().click();
      await page.waitForLoadState('networkidle');
      break;
    case 'checkout':
      await performLogin(page, baseUrl, creds);
      await addProductToCart(page, baseUrl);
      await page.locator('a[href*="cart"], [class*="cart"] a, [aria-label*="cart" i]').first().click();
      await page.waitForLoadState('networkidle');
      await page.locator('a[href*="checkout"], button:has-text("Checkout")').first().click();
      await page.waitForLoadState('networkidle');
      break;
    case 'payment':
      await performLogin(page, baseUrl, creds);
      await addProductToCart(page, baseUrl);
      await page.locator('a[href*="cart"], [class*="cart"] a, [aria-label*="cart" i]').first().click();
      await page.waitForLoadState('networkidle');
      await page.locator('a[href*="checkout"], button:has-text("Checkout")').first().click();
      await page.waitForLoadState('networkidle');
      const placeOrder = page.locator('button[type="submit"], input[type="submit"]').first();
      if (await placeOrder.isVisible().catch(() => false)) await placeOrder.click();
      await page.waitForLoadState('networkidle');
      break;
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const extractElementsTool: Tool<Input, ExtractElementsOutput> = {
  name: 'page.extractElements',
  description:
    'Navigate to a page and extract all interactive elements with ranked selector candidates. ' +
    'Returns structured JSON — no raw ARIA tree. ' +
    'Use instead of browse.navigate + browse.snapshot for selector discovery. ' +
    'For auth-gated or state-dependent pages, pass the appropriate setupFlow. ' +
    'Credentials are loaded automatically from src/data/qa/<locale>.json.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL of the page to extract elements from' },
      setupFlow: {
        type: 'string',
        enum: ['cart', 'checkout', 'payment', 'account'],
        description: 'Predefined flow to reach state-dependent pages',
      },
      locale: { type: 'string', description: "Locale key for credentials, e.g. 'en-gb'" },
      filter: {
        type: 'string',
        description:
          'Case-insensitive substring to filter returned elements. ' +
          'Only elements whose text, bestSelector, or any selector value contains this string are returned.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const creds = await loadCredentials(ctx.repoRoot, input.locale);

    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();

      // Derive base URL from the input URL
      const parsed = new URL(input.url);
      const baseUrl = `${parsed.protocol}//${parsed.host}`;

      if (input.setupFlow) {
        if (!creds) throw new Error('setupFlow requires credentials but none found in src/data/');
        await runSetupFlow(page, baseUrl, input.setupFlow, creds, ctx);
        // After setup flow, navigate to the target URL if different from flow's end page
        const currentUrl = page.url();
        if (!currentUrl.includes(parsed.pathname)) {
          await page.goto(input.url);
          await page.waitForLoadState('networkidle');
        }
      } else {
        await page.goto(input.url);
        await page.waitForLoadState('networkidle');
      }

      const priority = ctx.selectorPreference ?? DEFAULT_PRIORITY;
      let elements = await walkDOM(page, priority);

      if (input.filter) {
        const needle = input.filter.toLowerCase();
        elements = elements.filter((el) => {
          if (el.text.toLowerCase().includes(needle)) return true;
          if (el.bestSelector?.toLowerCase().includes(needle)) return true;
          return Object.values(el.selectors).some((v) => v.toLowerCase().includes(needle));
        });
      }

      return { url: page.url(), elements };
    } finally {
      if (browser) await browser.close();
    }
  },
};
