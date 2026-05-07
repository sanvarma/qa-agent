import { z } from 'zod';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { Tool } from '../tool.js';
import { DOM_WALKER_SCRIPT } from './extractElements.js';
import type { ExtractedElement } from './extractElements.js';

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface BrowserSession {
  browser: Browser;
  page: Page;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();

function newSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function getSession(sessionId: string): BrowserSession {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`No session '${sessionId}'. Call page.open first.`);
  s.lastUsed = Date.now();
  return s;
}

async function extract(page: Page): Promise<ExtractedElement[]> {
  return page.evaluate(DOM_WALKER_SCRIPT) as Promise<ExtractedElement[]>;
}

/** Called by the orchestrator in its finally block to prevent browser leaks. */
export async function closeAllSessions(): Promise<void> {
  for (const [id, s] of sessions) {
    await s.browser.close().catch(() => undefined);
    sessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Shared output shape
// ---------------------------------------------------------------------------

interface SessionOutput {
  sessionId: string;
  url: string;
  elements: ExtractedElement[];
}

interface ActionOutput {
  url: string;
  elements: ExtractedElement[];
}

// ---------------------------------------------------------------------------
// page.open
// ---------------------------------------------------------------------------

const OpenInput = z.object({
  url: z.string().describe('Full URL to navigate to'),
  locale: z.string().optional().describe("Locale key for loading credentials, e.g. 'en-gb'"),
});
type OpenInput = z.infer<typeof OpenInput>;

export const pageOpenTool: Tool<OpenInput, SessionOutput> = {
  name: 'page.open',
  description:
    'Launch a browser, navigate to a URL, extract all interactive elements, and return a session ID. ' +
    'Use the session ID with page.click / page.fill / page.hover / page.extract / page.close. ' +
    'Returns structured element JSON — no raw ARIA tree.',
  inputSchema: OpenInput,
  jsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to navigate to' },
      locale: { type: 'string', description: "Locale key for credentials, e.g. 'en-gb'" },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async run(input) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(input.url);
    await page.waitForLoadState('networkidle');
    const sessionId = newSessionId();
    sessions.set(sessionId, { browser, page, lastUsed: Date.now() });
    const elements = await extract(page);
    return { sessionId, url: page.url(), elements };
  },
};

// ---------------------------------------------------------------------------
// page.click
// ---------------------------------------------------------------------------

const ClickInput = z.object({
  sessionId: z.string().describe('Session ID from page.open'),
  selector: z.string().describe('CSS selector of the element to click'),
});
type ClickInput = z.infer<typeof ClickInput>;

export const pageClickTool: Tool<ClickInput, ActionOutput> = {
  name: 'page.click',
  description:
    'Click an element in an existing browser session. ' +
    'Waits for network idle after the click (handles navigation). ' +
    'Returns the updated element map for the current page.',
  inputSchema: ClickInput,
  jsonSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
    },
    required: ['sessionId', 'selector'],
    additionalProperties: false,
  },
  async run(input) {
    const { page } = getSession(input.sessionId);
    await page.click(input.selector);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const elements = await extract(page);
    return { url: page.url(), elements };
  },
};

// ---------------------------------------------------------------------------
// page.fill
// ---------------------------------------------------------------------------

const FillInput = z.object({
  sessionId: z.string().describe('Session ID from page.open'),
  selector: z.string().describe('CSS selector of the input to fill'),
  value: z.string().describe('Value to type into the input'),
});
type FillInput = z.infer<typeof FillInput>;

export const pageFillTool: Tool<FillInput, ActionOutput> = {
  name: 'page.fill',
  description:
    'Fill an input field in an existing browser session. ' +
    'Clears the field first, then types the value. ' +
    'Returns the current element map (no navigation expected).',
  inputSchema: FillInput,
  jsonSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
      value: { type: 'string' },
    },
    required: ['sessionId', 'selector', 'value'],
    additionalProperties: false,
  },
  async run(input) {
    const { page } = getSession(input.sessionId);
    await page.fill(input.selector, input.value);
    const elements = await extract(page);
    return { url: page.url(), elements };
  },
};

// ---------------------------------------------------------------------------
// page.hover
// ---------------------------------------------------------------------------

const HoverInput = z.object({
  sessionId: z.string().describe('Session ID from page.open'),
  selector: z.string().describe('CSS selector of the element to hover over'),
});
type HoverInput = z.infer<typeof HoverInput>;

export const pageHoverTool: Tool<HoverInput, ActionOutput> = {
  name: 'page.hover',
  description:
    'Hover over an element to reveal dynamic content (dropdowns, tooltips, submenus). ' +
    'Returns the updated element map including any newly visible elements.',
  inputSchema: HoverInput,
  jsonSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      selector: { type: 'string' },
    },
    required: ['sessionId', 'selector'],
    additionalProperties: false,
  },
  async run(input) {
    const { page } = getSession(input.sessionId);
    await page.hover(input.selector);
    await page.waitForTimeout(300);
    const elements = await extract(page);
    return { url: page.url(), elements };
  },
};

// ---------------------------------------------------------------------------
// page.extract
// ---------------------------------------------------------------------------

const ExtractInput = z.object({
  sessionId: z.string().describe('Session ID from page.open'),
});
type ExtractInput = z.infer<typeof ExtractInput>;

export const pageExtractTool: Tool<ExtractInput, ActionOutput> = {
  name: 'page.extract',
  description:
    'Extract all interactive elements from the current page state without any interaction. ' +
    'Use after a sequence of actions when you need a fresh element map.',
  inputSchema: ExtractInput,
  jsonSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
  async run(input) {
    const { page } = getSession(input.sessionId);
    const elements = await extract(page);
    return { url: page.url(), elements };
  },
};

// ---------------------------------------------------------------------------
// page.close
// ---------------------------------------------------------------------------

const CloseInput = z.object({
  sessionId: z.string().describe('Session ID to close'),
});
type CloseInput = z.infer<typeof CloseInput>;

export const pageCloseTool: Tool<CloseInput, { closed: boolean }> = {
  name: 'page.close',
  description:
    'Close the browser session and release resources. ' +
    'Always call this when you are done extracting elements for a page.',
  inputSchema: CloseInput,
  jsonSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
  async run(input) {
    const s = sessions.get(input.sessionId);
    if (s) {
      await s.browser.close().catch(() => undefined);
      sessions.delete(input.sessionId);
    }
    return { closed: true };
  },
};

// ---------------------------------------------------------------------------
// Convenience export — all session tools in one array
// ---------------------------------------------------------------------------

export const sessionTools = [
  pageOpenTool,
  pageClickTool,
  pageFillTool,
  pageHoverTool,
  pageExtractTool,
  pageCloseTool,
] as const;
