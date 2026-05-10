# Multi-Agent Extraction Architecture

---

## 0. How to Use

### Prerequisites

- Node.js 18+
- An Anthropic API key (set as `ANTHROPIC_API_KEY` environment variable)

### Step 1 — Clone and install qa-agent

```bash
git clone <repo-url>
cd qa-agent
npm install
npm run build
```

Or install globally from a tarball:

```bash
npm install -g ./qa-agent-0.0.1.tgz
```

### Step 2 — Set up a framework repo

The agent operates on a **target repo** (your Playwright framework). It must have this layout:

```
my-framework/
  src/
    pages/
      base/BasePage.ts          ← must export BasePage with loc(), goto(), waitForReady()
      common/                   ← agent writes POMs here
    fixtures/
      base.fixture.ts           ← must export test with appLocale + _autoNav fixtures
      pages.fixture.ts          ← agent registers POMs here (must exist, can be empty)
    data/
      qa/
        en-gb.json              ← { "users": [{ "locale": "en-gb", "username": "...", "password": "..." }] }
  tests/
    generic/                    ← agent writes spec files here
  qa-agent.config.json          ← agent configuration (see below)
```

### Step 3 — Create `qa-agent.config.json` in the framework repo

```json
{
  "model": "claude-haiku-4-5-20251001",
  "maxTokens": 4096,
  "maxFixAttempts": 3,
  "browse": {
    "baseUrl": "https://your-app.com",
    "headed": false,
    "email": "test@example.com",
    "password": "yourpassword",
    "selectorPreference": ["data-qa", "data-testid", "data-test", "id", "name", "type", "href", "placeholder", "aria-label"]
  }
}
```

### Step 4 — Write a test case JSON

```json
{
  "title": "user can log in with valid credentials",
  "localeScope": "generic",
  "steps": [
    "Navigate to the login page",
    "Enter valid username and password",
    "Click the login button",
    "Assert the user is redirected to the dashboard"
  ],
  "expected": "User is logged in and sees the dashboard"
}
```

Save it anywhere, e.g. `cases/generic/login.json`.

### Step 5 — Run the agent

```bash
# Single test case
qa-agent qa \
  --repo ./my-framework \
  --testcase ./cases/generic/login.json \
  --llm anthropic

# All test cases in a folder (PowerShell)
Get-ChildItem "cases/generic/*.json" | ForEach-Object {
    Write-Host "=== Running: $($_.Name) ===" -ForegroundColor Cyan
    qa-agent qa --repo ./my-framework --testcase $_.FullName --llm anthropic
}
```

### Step 6 — Check results

Run artifacts are written to `.qa-agent/runs/<run-id>/` in the framework repo:

```
.qa-agent/runs/<run-id>/
  orchestrator.log.jsonl    ← phase-by-phase summary (steps, tokens, pass/fail)
  run-viewer.html           ← open in browser for a visual trace of the full run
  pom/run.json              ← POM Agent turns
  testwriter/run.json       ← Test Writer Agent turns
```

### Step 7 — Run generated tests independently

```bash
cd my-framework
npx playwright test
```

### Supported LLM backends

| Flag | Provider |
|---|---|
| `--llm anthropic` | Anthropic API (requires `ANTHROPIC_API_KEY`) |
| `--llm ollama --ollama-url <url>` | Ollama (local or remote) |
| `--llm mock` | Mock client (for testing the agent itself) |

### Notes

- Run `npx playwright install chromium` once in the framework repo before running tests.
- The agent **skips generation** if a test with the same title already exists in the spec file — it goes straight to execution.
- To force a fresh regeneration, delete the relevant spec file in `tests/`.
- Credentials are loaded automatically from `src/data/qa/<locale>.json` — never hard-coded in test cases.

---

## 1. Problem Statement

The original single-agent generate phase had a fundamental context/attention problem:

| Problem | Effect |
|---|---|
| Large system prompt (many conditional rules) | LLM ignores rules buried in the middle |
| ARIA snapshots 150+ lines each | Context grows rapidly per page visited |
| All concerns in one prompt | Selector discovery, POM creation, test writing all compete for attention |
| Smaller models (Haiku, qwen3.6) | Cannot hold all rules in attention simultaneously |

**Observed symptoms:** browse.snapshot called after browse.navigate (forbidden), inline fill/click sequences in test body (forbidden), testData missing from fixtures array, test.addCase deferred past step 7.

---

## 2. Core Insight

Split the single bloated agent into **focused agents**, each with a small prompt and a limited toolset.
Replace ARIA snapshot browsing with a **deterministic extraction tool** that returns structured element maps — no LLM parsing of raw DOM trees.

Each agent sees only the rules relevant to its job. Context stays small. Attention stays on target.

---

## 3. Agent Inventory

| Agent | Role | Prompt size | Max steps | Context source |
|---|---|---|---|---|
| Extraction Tool | Navigate pages, return element maps | No LLM | N/A | Playwright DOM walker |
| POM Agent | Build/update Page Object Models | ~250 tokens | 20 | Structured JSON from extractor |
| Test Writer Agent | Write spec file and test body | ~220 tokens | 15 | framework.getGraph output only |
| Fix Agent | Repair failing tests | ~400 tokens | 10 | Failure message + classifier |
| Orchestrator | Coordinate phases, run tests, loop | No LLM | N/A | Phase state machine |

---

## 4. Extraction Tool — `page.extractElements`

> **Role:** Deterministic Playwright script. No LLM involved. Navigates to a page, walks the DOM, and returns a ranked selector map for every interactive element.

### 4.1 Input

```typescript
{
  url: string;
  setupFlow?: 'account' | 'cart' | 'checkout' | 'payment';
  locale?: string;   // picks credentials from src/data/qa/<locale>.json
  filter?: string;   // case-insensitive substring; narrows returned elements
                     //   to those whose text/bestSelector/selector values match.
                     //   Used by the Fix Agent to avoid returning all interactive
                     //   elements when only one is needed.
}
```

> ⚠ The `setupFlow` enum hardcodes e-commerce flow names. See section 15 (Domain Assumptions).

### 4.2 Setup Flows

Pages that require app state cannot be reached by a direct URL. The extractor handles them in two layers:

**Layer 1 — Config-driven flows** (preferred). `qa-agent.config.json` can define each flow as an array of typed steps:

```json
"setupFlows": {
  "cart": [
    { "action": "login" },
    { "action": "click", "pom": "InventoryPage", "field": "firstProductAddButton" },
    { "action": "click", "pom": "InventoryPage", "field": "cartIcon" }
  ]
}
```

Step shape: `{ action: "login" | "click" | "navigate", pom?, field?, selector?, url? }`. POM field references resolve at runtime via `readFieldSelector` (regex parses `readonly fieldName = this.loc("...")` from the actual POM file on disk — handles both quote styles).

**Layer 2 — Built-in fallback flows.** Hardcoded Playwright sequences for each named flow:

| Flow | Built-in sequence |
|---|---|
| `account` | `performLogin` |
| `cart` | login → click "Add to cart" button (text match) → click cart link (`href*='cart'`) |
| `checkout` | cart flow + click "Checkout" button |
| `payment` | checkout flow + click submit |

**When the fallback fires.** If a config flow throws (e.g. it references `InventoryPage.firstProductAddButton` but the field doesn't exist on disk yet — typical during bootstrap), the extractor catches the exception, logs `[extractElements] Config setupFlow '...' failed: ... Falling back to built-in generic flow.`, resets the page to baseUrl, then runs the built-in sequence. This makes initial POM creation work even when config flows haven't been "seeded" yet.

| Page | Requires | Recommended flow |
|---|---|---|
| Login | Nothing | Navigate directly |
| Products list | Nothing | Navigate directly |
| Product detail | Nothing | Navigate directly |
| Account | Login session | `account` |
| Cart | Login + item in cart | `cart` |
| Checkout | Login + item in cart | `checkout` |
| Payment | Login + reached checkout | `payment` |
| Order confirmation | Completed order | Not supported — structural patterns only |

Credentials are loaded automatically from `src/data/qa/<locale>.json` → `users[]`. Never passed directly in the tool call.

### 4.3 DOM Walker

Runs via `page.evaluate()` as a plain JS string (not a TypeScript function — avoids tsx `__name` injection that breaks browser serialization).

The script is wrapped as an **IIFE with the priority array embedded inline** before being evaluated:
```js
const iife = `(${DOM_WALKER_SCRIPT.trim()})(${JSON.stringify(priority)})`;
return page.evaluate(iife);
```
This is a deliberate workaround. `page.evaluate(stringFunction, arg)` does NOT pass the `arg` to a string-form function — it just evaluates the string as an expression and returns the function object, which can't be JSON-serialized → `walkDOM` returned `undefined`. Embedding the call eliminates the ambiguity: the string evaluates to a fully-applied call that returns the result array.

**Elements captured:** `input` (non-hidden), `button`, `a[href]`, `select`, `textarea`, `[role="button"]`

> ⚠ **Limitation:** non-interactive elements (prices, error messages, headings, generic divs) are NOT enumerated. When a POM needs a text-content field, the agent has to guess the selector — sometimes wrong. See watchlist.

**Selector candidates built per element:**

```
data-qa     → tag[data-qa='value']
data-testid → tag[data-testid='value']
data-test   → tag[data-test='value']
id          → #value  (skipped if id has 3+ digits — auto-generated)
name        → tag[name='value']
type        → tag[type='value']  (skipped if type='hidden')
href        → a[href*='first-path-segment']  (environment-safe pattern)
placeholder → tag[placeholder='value']
aria-label  → [aria-label='value']
```

**Selector priority (bestSelector):** Driven by `browse.selectorPreference` in `qa-agent.config.json`. Default: `data-qa > data-testid > data-test > id > name > type > href > placeholder > aria-label`

**Deduplication:** if two elements share the same bestSelector, only the first is kept.

### 4.4 Output

```json
[
  {
    "tag": "input",
    "text": "",
    "selectors": {
      "data-qa": "input[data-qa='login-email']",
      "type": "input[type='email']",
      "placeholder": "input[placeholder='Email Address']"
    },
    "bestSelector": "input[data-qa='login-email']"
  },
  {
    "tag": "button",
    "text": "Login",
    "selectors": {
      "data-qa": "button[data-qa='login-button']",
      "type": "button[type='submit']"
    },
    "bestSelector": "button[data-qa='login-button']"
  }
]
```

### 4.5 Step Sequence

```
1. loadCredentials(repoRoot, locale)
     ↓ scans src/data/**/*.json → finds users[] → returns {username, password}
2. chromium.launch({ headless: true })
3. if setupFlow:
     runSetupFlow(page, baseUrl, flow, creds)
       account  → performLogin(page)
       cart     → performLogin → addProductToCart → goto /view_cart
       checkout → performLogin → addProductToCart → goto /view_cart → click checkout link
       payment  → performLogin → addProductToCart → cart → checkout → click Place Order
4. page.goto(url) + waitForLoadState('networkidle')
5. page.evaluate(DOM_WALKER_SCRIPT)  ← pure JS, no LLM
6. return { url, elements: ExtractedElement[] }
7. browser.close()
```

### 4.6 Files

| File | Purpose |
|---|---|
| `src/tools/browser/extractElements.ts` | Tool definition, DOM walker, setup flows, credential loader |
| `test/tools/browser/extractElements.test.ts` | 13 unit tests covering all selector types and edge cases |

---

## 5. POM Agent

> **Role:** LLM agent with a focused POM-only prompt. Takes the test case + base URL, ensures every Page Object Model the test needs exists on disk with the correct fields and methods.

### 5.1 Tools Available

**Framework / POM tools:**

| Tool | Purpose |
|---|---|
| `framework.getGraph` | Full POM inventory — fields, method signatures, fixture status, locale overrides |
| `fs.read` | Read an existing POM file before calling `pom.editMethod` |
| `pom.createPage` | Scaffold a new POM class at `src/pages/common/<Name>.ts` |
| `pom.addSelector` | Add a missing `this.loc(...)` field to an existing POM |
| `pom.updateSelector` | Replace the selector string on an existing POM field |
| `pom.editMethod` | Add or replace a method body on a POM class (upsert — creates if not found) |
| `fixture.addPage` | Register a POM in `src/fixtures/pages.fixture.ts` |

**Browser / extraction tool:**

| Tool | When to use |
|---|---|
| `page.extractElements(url, { setupFlow? })` | Public pages (no args) or auth-gated pages (`setupFlow: 'account' \| 'cart' \| 'checkout' \| 'payment'`). Stateless — no session. |

Session tools (`page.open`, `page.click`, `page.fill`, `page.hover`, `page.extract`, `page.close`) are **intentionally excluded** from the POM Agent registry. Removing them physically prevents the model from wandering through live browser sessions instead of creating POMs.

**Intentionally excluded:** `test.*`, `testData.*`, `browse.*` (MCP), all session tools

### 5.2 Data In / Out

```
IN:  TestCase { title, steps, expected, localeScope }
     baseUrl (string)

OUT: POMs written to src/pages/common/<Name>.ts
     pages.fixture.ts updated with new fixture registrations
     framework.getGraph will now return confirmed POMs/fields/methods for Test Writer
```

### 5.3 Step Sequence

```
Step 1  framework.getGraph
          → lists all existing POMs, their fields, methods, fixture status
          → identifies which POMs are already present vs missing

Step 2  For each page the test case involves:
          if POM missing or missing fields:
            page.extractElements(url)              ← public pages: direct URL
            page.extractElements(url, {setupFlow}) ← auth-gated pages

Step 3  Map extracted elements → field names
          e.g. input[data-qa='login-email'] → emailInput
               input[data-qa='login-password'] → passwordInput
               button[data-qa='login-button'] → loginButton

Step 4  pom.createPage (if POM missing)
          + fixture.addPage (ATOMIC PAIR — same batch, no exceptions)

Step 5  pom.addSelector (if POM exists but fields are missing)

Step 6  pom.editMethod (if a test step needs 2+ sequential interactions)
          Rule: fill + fill + click = method. Never inline in test body.
          COMPLETE ACTION methods (login, submit, confirm): include ALL clicks.
          FORM-FILL methods (fillX, enterX, typeX): fill fields only — no submit click.
          e.g. async login(username: string, password: string) {   ← complete action
                 await this.usernameInput.fill(username);
                 await this.passwordInput.fill(password);
                 await this.loginButton.click();                   ← click included
               }
               async fillShippingInfo(first, last, zip) {         ← form-fill only
                 await this.firstNameInput.fill(first);
                 await this.lastNameInput.fill(last);
                 await this.zipInput.fill(zip);
                 // no submit click here — test controls page transition
               }

Step 7  Done — all POMs confirmed on disk. Stop.
```

### 5.4 Prompt Design

```
System prompt: ~250 tokens
  - GRAPH FIRST rule
  - EXTRACT rule: public vs auth-gated pages, setupFlow values
  - CREATE rule: flat path src/pages/common/<Name>.ts only
  - METHODS rule: 2+ interactions = method, never inline
  - ATOMIC PAIR rule: createPage + fixture.addPage in same batch
  - SCOPE rule: no test.* tools, stop when POMs ready

Task prompt: ~150 tokens
  - Rendered test case (title, steps, expected)
  - Base URL
  - 6-step numbered procedure
```

### 5.5 Context Isolation

The POM Agent gets its own `ConversationLog`, saved to `.qa-agent/runs/<id>/pom/run.json`. The Test Writer Agent starts with a completely empty conversation — it never sees the DOM extraction results or POM creation turns.

### 5.6 Files

| File | Purpose |
|---|---|
| `src/orchestrator/agents/pomAgent.ts` | Agent wiring, tool registry, system prompt, task prompt builder |

---

## 6. Test Writer Agent

> **Role:** LLM agent with a focused test-writing prompt. Reads the confirmed POM graph, writes the spec file and test body. Never touches POMs.

### 6.1 Tools Available

| Tool | Purpose |
|---|---|
| `framework.getGraph` | Confirmed POM inventory — fields, methods, fixture names |
| `fs.read` | Read an existing spec file before inserting a new test |
| `testData.getSchema` | Exact field names for a dataset (e.g. `users`) — never guess |
| `test.createSpec` | Scaffold a new spec file with the correct fixture import |
| `test.addCase` | Insert the test into the spec file. Validates `testData` field accesses in the body against the actual schema — rejects with a clear error if a field doesn't exist. |
| `ast.addImport` | Add non-fixture imports (type aliases, etc.) |

**Intentionally excluded:** `pom.*`, `fixture.*`, `page.extractElements`, `browse.*`

### 6.2 Data In / Out

```
IN:  TestCase { title, steps, expected, localeScope }
     Implicit: POMs already confirmed on disk (POM Agent ran first)

OUT: Spec file written to tests/generic/<subject>.spec.ts
                           or tests/locales/<locale>/<subject>.spec.ts
     Test body calls POM methods, uses testData fixture, asserts Expected
```

### 6.3 Step Sequence

```
Step 1  framework.getGraph
          → sees all confirmed POMs from the POM Agent's work
          → reads fixture names, field names, method signatures
          → never guesses — uses only what appears here

Step 2  testData.getSchema('users')   ← only if test uses credentials
          → returns exact field names: [locale, username, password]
          → prevents invented names like user.email

Step 3  test.createSpec (if spec file does not exist)
          → emits correct import { test, expect } from pages.fixture.ts
          → passes serial: true for locale-specific specs

Step 4  test.addCase
          fixtures: ["loginPage", "testData"]  ← every page + testData if credentials used
          body:
            await loginPage.goto();
            const user = testData<{ username: string; password: string }>('users');
            await loginPage.login(user.username, user.password);
            expect(...).toBe(...);

Step 5  Done. Stop.
```

### 6.4 Prompt Design

```
System prompt: ~220 tokens
  - GRAPH FIRST rule
  - TESTDATA rule: getSchema → add to fixtures[] → call synchronously → exact field names
  - FIXTURES rule: never import fixture names, use fixtures[] array
  - METHODS rule: if POM graph shows a method, call it — never inline
  - ASSERTIONS rule: assert Expected — no trivial title checks
  - BODY rule: statements only, no surrounding braces. Do NOT call goto() — _autoNav fixture handles navigation automatically.

Task prompt: ~120 tokens
  - Rendered test case
  - Target spec file path (inferred from title keywords)
  - Locale scope
  - 5-step numbered procedure
```

### 6.5 Spec File Inference

The agent infers the spec file path for each test using a layered resolution:

1. **Explicit `tc.specFile`** in the test case JSON — always wins. Use this for one-off overrides.
2. **User-defined patterns** in `qa-agent.config.json#specFileNaming` — checked next, in array order, first match wins. Each entry is `{ pattern: <case-insensitive regex string>, spec: <bare spec name> }`. Entries are pre-validated by the config schema (regex compiles, spec is `[a-z0-9-]+`). Lets each app extend or override the defaults without touching framework code.
3. **Built-in defaults** — checked last:

| Title keyword | Spec file |
|---|---|
| login, logout, sign in/up, register, credential | `auth.spec.ts` |
| cart, basket, bag, wishlist | `cart.spec.ts` |
| checkout, payment, order, purchase, billing, shipping | `checkout.spec.ts` |
| product, search, filter, category, listing, catalog | `products.spec.ts` |
| contact, form, submit, enquir | `forms.spec.ts` |
| home, landing, hero, dashboard | `home.spec.ts` |
| profile, account, settings, preference | `account.spec.ts` |
| (none match) | `general.spec.ts` |

4. **Fallback** — `general.spec.ts`.

Generic tests → `tests/generic/<name>.spec.ts`
Locale tests → `tests/locales/<locale>/<name>.spec.ts`

#### Example — adding a `dashboard.spec.ts` for an analytics app

The built-in `home|landing|hero|dashboard` regex routes dashboard tests into `home.spec.ts`. To split them out:

```json
{
  "specFileNaming": [
    { "pattern": "dashboard|metric|kpi|report", "spec": "dashboard" },
    { "pattern": "coupon|promo|discount", "spec": "promotions" }
  ]
}
```

User patterns run first, so a test titled "user views the sales dashboard" matches the `dashboard` pattern → `tests/generic/dashboard.spec.ts`. The default `home` pattern is never reached for that test.

### 6.6 Context Isolation

The Test Writer Agent gets its own `ConversationLog`, saved to `.qa-agent/runs/<id>/testwriter/run.json`. It never sees the POM Agent's turns. Its context contains only:
1. Its own system prompt
2. Its task message
3. The `framework.getGraph` result (the confirmed POM state)
4. Optionally: the `testData.getSchema` result

### 6.7 Files

| File | Purpose |
|---|---|
| `src/orchestrator/agents/testWriterAgent.ts` | Agent wiring, tool registry, system prompt, task prompt builder, spec file inference |

---

## 7. Fix Agent

> **Role:** LLM agent that repairs a failing test. Receives the failure message and a rule-based classification. Applies the minimal fix — no test generation, no POM creation unless a locale override is needed.

### 7.1 Tools Available

| Tool | Purpose |
|---|---|
| `fs.read` | Read any file to inspect current state before editing |
| `test.editCase` | Replace the body of an existing test |
| `pom.createPage` | Create a locale override POM when a generic fix would break other locales |
| `pom.updateSelector` | Swap a selector string on a POM field |
| `pom.addSelector` | Add a missing field to a POM |
| `pom.editMethod` | Replace a method body |
| `fixture.addPage` | Register a locale override POM in the fixture locale map |
| `ast.addImport` | Add a missing import |
| `browse.navigate` | (optional, if cfg.browse set) Open URL in live browser for selector discovery |
| `browse.snapshot` | (optional) Get accessibility tree of current page |

### 7.2 Data In / Out

```
IN:  NormalizedFailure { testTitle, file, line, message, rawSnippet }
     Classification { kind, action, confidence, cause, reasoning, fixTarget }
     FixHistory[]  ← prior attempts, to avoid repeating failed fixes

OUT: Modified POM file (pom.updateSelector / pom.editMethod)
     or Modified test file (test.editCase)
     No new files created (except locale overrides when needed)
```

### 7.3 Classification → Action Mapping

The failure classifier runs before the Fix Agent and determines the action:

| Classification kind | Suggested action | Fix Agent behaviour |
|---|---|---|
| `selector_not_found` | `update_pom` | fs.read the POM, fix the selector |
| `strict_mode_violation` | `update_pom` | Narrow selector — answer is in the error message |
| `wrong_assertion` | `update_test` | Edit the test body assertion |
| `missing_import` | `update_test` | ast.addImport |
| `test_logic_error` | `update_test` | Edit the test body |
| `flake` | `retry` | No edits — orchestrator re-runs |

### 7.4 Step Sequence

```
Step 1  fs.read the failing file (POM or spec, per classification.fixTarget)

Step 2  Apply the fix:
          update_pom → pom.updateSelector or pom.editMethod
          update_test → test.editCase
          retry → produce no tool calls (orchestrator handles re-run)

Step 3  Stop. Do NOT re-run tests — execution is handled by the orchestrator.
```

### 7.5 Auth-Gated Page Rule

If the failing selector is on an auth-gated page (cart, checkout, payment, account, order confirmation):
- **Do NOT browse** — these pages cannot be reached without auth state
- Apply structural selector patterns directly:
  - Navigation links → `a[href*='keyword']`
  - Submit buttons → `button[type='submit']`
  - Input fields → use field name + context to derive `input[name='field']`

Public pages (login, products, product detail) → `browse.navigate` then inspect snapshot.

### 7.6 Locale Fix Rule

- Fix in `src/pages/locales/<locale>/` if the failure is locale-specific
- Fix in `src/pages/common/` only if the fix applies to ALL locales
- When creating a new locale override: `pom.createPage` (locale path) + `fixture.addPage` (with locale param)

### 7.7 Budget

Max 1 fix attempt (default). Configurable via `maxFixAttempts` in `qa-agent.config.json`. If budget exhausted, orchestrator transitions to `exhausted` and stops.

### 7.8 Files

| File | Purpose |
|---|---|
| `src/orchestrator/agents/fixPrompts.ts` | `fixSystemPrompt()` and `fixTask()` builders |
| `src/failure/classify.ts` | Rule-based classifier (no LLM) |
| `src/failure/rules.ts` | Classification rules |

---

## 8. Orchestrator

> **Role:** Coordinates all phases via a state machine. Never calls an LLM directly — delegates to agents. Runs tests, parses results, classifies failures, loops the fix cycle.

### 8.1 Phase State Machine

```
init
  │
  ▼
[pre-flight: does test already exist?]
  │
  ├── yes → skip generate → execute
  │
  └── no  → generate
              │
              ├── pom phase (POM Agent)
              │     └── error → exhausted
              │
              └── testwriter phase (Test Writer Agent)
                    └── error → exhausted
                          │
                          ▼
                        execute
                          │
                  ┌───────┴───────┐
                  │               │
                pass            fail
                  │               │
                done           analyze
                                 │
                          ┌──────┴──────────┐
                          │                 │
                        retry          fix (LLM)
                          │                 │
                    (re-run,          (edit POM
                    no fix            or test)
                    consumed)              │
                          │           budget ok?
                          │           ├── yes → execute (loop)
                          │           └── no  → exhausted
                          │
                      retry budget ok?
                      ├── yes → execute (loop)
                      └── no  → exhausted
```

### 8.2 Phase Definitions

| Phase | What happens |
|---|---|
| `init` | Load test case, start MCP (if browse configured), check for pre-existing test |
| `generate` | Run POM Agent then Test Writer Agent sequentially. If either hits `max_steps` or `max_tokens`, transitions to `exhausted` immediately. |
| `execute` | Run `npx playwright test --grep <title> --reporter=json`. On apparent success, verifies `totals.passed + totals.flaky > 0` — if zero tests ran (grep matched nothing), transitions to `exhausted`. |
| `analyze` | Parse report, filter to managed test failures, classify the first failure |
| `fix` | Run Fix Agent with failure + classification + history |
| `done` | Managed test passed — write run viewer HTML, exit |
| `exhausted` | Budget exceeded, token/step exhaustion in a sub-agent, zero tests ran, or unrecoverable error — write run viewer HTML, exit |

**Budget exhaustion guard (generate phase):** After `runPomAgent` and `runTestWriterAgent`, the orchestrator checks `result.stopReason`. If it is `'max_steps'` or `'max_tokens'`, the sub-agent was cut off mid-work and its output is unreliable — the orchestrator logs `phase.budget_exhausted` and transitions directly to `exhausted` rather than silently handing incomplete POMs to the next phase.

**Zero-test false-pass guard (execute phase):** Playwright exits with code 0 when `--grep` matches nothing. After a reported success, the orchestrator parses the JSON report and checks `totals.passed + totals.flaky > 0`. If zero tests ran, the run is treated as `exhausted` with reason `no_tests_ran`.

### 8.3 Conversation Log Isolation

Each phase that runs an LLM agent gets its own `ConversationLog`:

```
.qa-agent/runs/<run-id>/
  run.json              ← main orchestrator state (phase transitions, test results)
  pom/
    run.json            ← POM Agent turns (framework.getGraph, extractElements, createPage...)
  testwriter/
    run.json            ← Test Writer Agent turns (getGraph, getSchema, createSpec, addCase)
  run-viewer.html       ← HTML viewer for the full run
```

The Fix Agent currently shares the main `runState` (same ConversationLog as the orchestrator). Each fix attempt's turns accumulate — the agent sees prior tool results when re-entering a second fix attempt.

### 8.4 MCP / Browse Tools

`browse.*` tools are optional. They are provided only if `cfg.browse` is set in `qa-agent.config.json`. When present they are passed to the Fix Agent only — the generate phase (POM + Test Writer) does not use live browser browsing; it uses `page.extractElements` instead.

### 8.5 Files

| File | Purpose |
|---|---|
| `src/orchestrator/qaAgent.ts` | Main orchestrator — phase loop, MCP wiring, test execution |
| `src/orchestrator/state.ts` | Phase state machine types and transition function |
| `src/orchestrator/logger.ts` | Structured event logger (per phase, per step) |
| `src/orchestrator/testCase.ts` | TestCase schema + loader + renderer |
| `src/orchestrator/browseUrl.ts` | Locale-aware base URL resolver |
| `src/cli.ts` | CLI entry point (`qa <testcase> <repo> --llm anthropic`) |

---

## 9. Holistic End-to-End Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  CLI: qa-agent qa --testcase login.json --repo ../my-framework       │
│              --llm anthropic                                          │
└─────────────────────────────┬────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  ORCHESTRATOR  (no LLM)                                              │
│  Load test case JSON                                                 │
│  Load qa-agent.config.json (model, paths, browse.baseUrl, etc.)     │
│  Pre-flight: findTestAcrossSpecs(title) → skip generate if found    │
└─────────────────────────────┬────────────────────────────────────────┘
                              │
             ╔════════════════╩════════════════╗
             ║          GENERATE PHASE          ║
             ╚════════════════╦════════════════╝
                              │
              ┌───────────────▼───────────────┐
              │         POM AGENT             │
              │  model: claude-haiku          │
              │  context: isolated (pom log)  │
              │  max steps: 20                │
              │                               │
              │  Step 1: framework.getGraph   │
              │    → sees existing POMs       │
              │                               │
              │  Step 2: page.extractElements │  ◄── EXTRACTION TOOL (no LLM)
              │    url: /login                │      launches Playwright
              │    → ExtractedElement[]       │      walks DOM
              │                               │      returns bestSelector map
              │  Step 3: pom.createPage       │
              │    file: src/pages/common/    │
              │    LoginPage.ts               │
              │    fields: [emailInput,       │
              │      passwordInput,           │
              │      loginButton]             │
              │                               │
              │  Step 4: pom.editMethod       │
              │    method: login(u, p)        │
              │    body: fill + fill + click  │
              │                               │
              │  Step 5: fixture.addPage      │
              │    (atomic with createPage)   │
              └───────────────┬───────────────┘
                              │ POMs on disk
                              │ fixture registered
                              ▼
              ┌───────────────────────────────┐
              │      TEST WRITER AGENT        │
              │  model: claude-haiku          │
              │  context: isolated (tw log)   │
              │  max steps: 15                │
              │                               │
              │  Step 1: framework.getGraph   │
              │    → sees loginPage fixture   │
              │    → sees login() method sig  │
              │                               │
              │  Step 2: testData.getSchema   │
              │    key: 'users'               │
              │    → fields: [username,       │
              │               password]       │
              │                               │
              │  Step 3: test.createSpec      │
              │    file: tests/generic/       │
              │           auth.spec.ts        │
              │                               │
              │  Step 4: test.addCase         │
              │    title: "User can log in"   │
              │    fixtures: [loginPage,      │
              │               testData]       │
              │    body:                      │
              │      await loginPage.goto();  │
              │      const user =             │
              │        testData('users');     │
              │      await loginPage          │
              │        .login(u, p);          │
              │      expect(...).toBeTrue();  │
              └───────────────┬───────────────┘
                              │ spec file on disk
                              │
             ╔════════════════╩════════════════╗
             ║           EXECUTE PHASE          ║
             ╚════════════════╦════════════════╝
                              │
              ┌───────────────▼───────────────┐
              │    exec.runTests (no LLM)     │
              │    npx playwright test        │
              │    --grep "User can log in"   │
              │    --reporter=json            │
              └───────────────┬───────────────┘
                              │
                    ┌─────────┴─────────┐
                   PASS               FAIL
                    │                   │
                   DONE        ╔════════╩════════╗
                    ✅          ║  ANALYZE PHASE  ║
                               ╚════════╦════════╝
                                        │
                              ┌─────────▼─────────┐
                              │ exec.parseReport  │
                              │ classifyFailure   │
                              │ (no LLM)          │
                              └─────────┬─────────┘
                                        │
                            ┌───────────┴───────────┐
                           retry              fix (budget?)
                            │                   │
                       re-run          ╔═════════╩═════════╗
                       (no fix)        ║    FIX PHASE       ║
                                       ╚═════════╦═════════╝
                                                 │
                              ┌──────────────────▼──────────────────┐
                              │            FIX AGENT                │
                              │  model: claude-haiku                │
                              │  max steps: 10, max 3 attempts      │
                              │                                     │
                              │  Receives:                          │
                              │    failure message                  │
                              │    classification + action          │
                              │    prior fix history                │
                              │                                     │
                              │  update_pom → pom.updateSelector    │
                              │               pom.editMethod        │
                              │  update_test → test.editCase        │
                              │  retry → no tool calls              │
                              └──────────────────┬──────────────────┘
                                                 │
                                          loop back to EXECUTE
                                          (max 3 fix cycles)
```

---

## 10. Data Flow Summary

```
src/data/qa/<locale>.json
  users[].username / .password
        │
        └──► page.extractElements (credential loader)
                      │
                      ▼
              ExtractedElement[]
              { tag, text, selectors{}, bestSelector }
                      │
                      └──► POM Agent  (maps element → field name)
                                  │
                                  ▼
                    src/pages/common/<Name>.ts
                    src/fixtures/pages.fixture.ts
                                  │
                                  └──► framework.getGraph
                                               │
                                               ▼
                                       Test Writer Agent
                                               │
                                               ▼
                                   tests/generic/<name>.spec.ts
                                               │
                                               ▼
                                         Playwright run
                                               │
                                    ┌──────────┴──────────┐
                                   pass                 fail
                                    │                    │
                                   done         classifyFailure
                                                        │
                                                   Fix Agent
                                                        │
                                          src/pages/common/<Name>.ts  (selector fix)
                                          tests/generic/<name>.spec.ts (test fix)
```

---

## 11. What Each Agent Sees (Context Isolation)

| Concern | Handled by | LLM sees |
|---|---|---|
| Page navigation | Extraction tool (Playwright) | Nothing |
| Auth / state setup | Extraction tool (Playwright) | Nothing |
| Credential lookup | Extraction tool (file read) | Nothing |
| DOM parsing | DOM walker JS script | Nothing |
| Selector ranking | Extractor (deterministic) | Nothing |
| Field mapping (element → name) | POM Agent | Structured JSON only (~50 lines) |
| POM scaffolding | POM Agent | Graph + extraction output |
| Method creation | POM Agent | Same small context |
| Test body writing | Test Writer Agent | Graph output only — never raw DOM |
| Spec file structure | Test Writer Agent | Same small context |
| Failure analysis | Classifier (no LLM) | Nothing |
| Selector repair | Fix Agent | Failure message + one file |
| Test body repair | Fix Agent | Failure message + one file |

---

## 12. Pages Coverage

| Page | Extractor strategy | Typical POM fields |
|---|---|---|
| Login | Navigate directly | emailInput, passwordInput, loginButton |
| Products list | Navigate directly | viewProductLink, searchInput, searchButton |
| Product detail | Navigate directly | addToCartButton, productName, productPrice |
| Cart | `setupFlow: 'cart'` | proceedToCheckoutButton, removeItem |
| Checkout | `setupFlow: 'checkout'` | address fields, placeOrderButton |
| Payment | `setupFlow: 'payment'` | card fields, payButton |
| Account | `setupFlow: 'account'` | profile fields, updateButton |
| Order confirmation | Not supported | Structural patterns: `.order-id`, `h2` |

---

## 12.5 Domain Assumptions (E-Commerce Hardcoding)

The framework currently assumes an e-commerce shape. Two distinct concerns — only the first is architecturally significant.

### Real concern — the SetupFlow auth/state mechanism

`setupFlow` exists for *one* purpose: getting the browser into the right app state before `extractElements` walks the DOM of a state-gated page. Login, items-in-cart, mid-checkout — these can't be reached by URL alone, so the extractor runs a Playwright sequence first.

That mechanism is currently locked to e-commerce flow names:

| Location | What's hardcoded | Impact |
|---|---|---|
| `src/tools/browser/extractElements.ts` — SetupFlow Zod enum | `account` \| `cart` \| `checkout` \| `payment` only | Cannot add `dashboard`, `inbox`, `reports`, `coupons`, `admin`, etc. without editing the schema |
| `src/tools/browser/extractElements.ts` — built-in fallback flows | Sequences hardcode "Add to cart" button text, `a[href*='cart']`, etc. | Fallback won't help on non-e-commerce apps; config flows still work once their POM field references are seeded |

This is the **hard blocker for multi-app deployments**. A team running tests across an e-commerce primary plus supporting apps (reports, dashboards, coupons admin, promo pages) cannot define a `setupFlow: 'reports'` without forking the framework.

### Cosmetic concern — spec-file naming heuristic

`src/orchestrator/agents/testWriterAgent.ts` has a regex that picks a target spec file from the test title (`cart|basket|wishlist` → `cart.spec.ts`, `checkout|payment|order` → `checkout.spec.ts`, etc.). The vocabulary is e-commerce-flavored.

This is **not** architectural. It's purely organizational — wrong assignment just means a test lands in `general.spec.ts` instead of `dashboard.spec.ts`. Fixable by:
- Setting `specFile` explicitly in the test case JSON (already supported)
- Replacing the regex with a config-driven `(pattern, target)` list (one-line refactor)
- Manually moving the file after generation

Mention only for completeness — don't conflate it with the setupFlow concern.

### Resolution options for the SetupFlow concern (deferred)

- **Option A — status quo:** document as "e-commerce QA agent."
- **Option B — fully config-driven:** Zod enum becomes `z.string()`, built-in fallbacks go away (config defines all flow content), runtime knows nothing about cart/checkout. The named flow becomes pure user data. Cleanest fix; aligns with how `setupFlows` already works at the *config* level; the lock is only at the *type* level. Refactor scope: small (drop the enum, drop the built-in switch statement, update the prompt examples).
- **Option C — hybrid:** keep e-commerce defaults as the built-in fallback, allow arbitrary user-defined names in config to override or extend. Adds compatibility but keeps the e-commerce smell baked in for unconfigured cases.

A hidden upside of Option B: it forces the question "do the built-in fallbacks earn their place?" The fallback only matters during bootstrap when config flows reference POM fields that don't exist on disk yet. If config flows are written *without* POM field references during bootstrap (just `{ action: "navigate", url: "/dashboard" }`), the fallback becomes unnecessary.

---

## 13. Framework Layout (Target Repo)

```
src/
  pages/
    base/BasePage.ts             ← loc() helper, goto(), waitForReady()
    common/
      LoginPage.ts               ← base POM for all locales
      ProductsPage.ts
      ...
    locales/
      en-gb/
        LoginPage.ts             ← overrides specific fields/methods
      es-pr/
        CheckoutPage.ts
  fixtures/
    pages.fixture.ts             ← test.extend — locale-aware POM injection
                                    testData fixture — synchronous function
  data/
    qa/
      en-gb.json                 ← { users: [{ locale, username, password }] }

tests/
  generic/
    auth.spec.ts                 ← runs for every locale
    cart.spec.ts
  locales/
    en-gb/
      checkout.spec.ts           ← mode: serial, locale-specific

qa-agent.config.json             ← model, paths, browse.baseUrl, maxFixAttempts
```

---

## 13.5 Per-Project Configuration Reference

Everything that varies between apps lives in `qa-agent.config.json` at the target framework repo root. The framework code never hardcodes app-specific values — config drives behavior.

This section is the single source of truth for what an app team needs to set when onboarding qa-agent to a new project.

### 13.5.1 Field reference

| Field | Required? | Default | Purpose |
|---|---|---|---|
| `model` | ⚠ Practically required | `"unset"` | Anthropic model id (e.g. `"claude-haiku-4-5-20251001"`). Without it, the agent runs but can't reach a real LLM unless you also pass `--llm` flags. |
| `maxTokens` | No | `4096` | Cap per LLM call. Raise if you hit `max_tokens` stop reason in run logs. |
| `maxFixAttempts` | No | `1` | How many fix cycles before giving up. Higher = more resilient, more cost. |
| `maxRetryAttempts` | No | `1` | How many `retry`-classified loops before giving up (separate from fix cycles — used for transient flakes). |
| `validation.command` | No | `"npx playwright test --reporter=json"` | How the orchestrator runs tests. Override only if you don't use `npx`. |
| `validation.cwd` | No | repo root | Override only if tests must run from a sub-dir. |
| `paths.pages` | No | `"src/pages"` | Where POMs live. Mutating tools enforce write scope to this. |
| `paths.tests` | No | `"tests"` | Where spec files live. Same scoping. |
| `browse` | ⚠ Required for live browsing | absent | Block configuring extractElements + fix-agent browse tools. See 13.5.2. |
| `setupFlows` | Optional | `{}` | Named state-reaching sequences for auth-gated pages. See 13.5.3. |
| `specFileNaming` | Optional | `[]` | App-specific spec-file routing rules. See 13.5.4. |

### 13.5.2 The `browse` block

Required when the agent needs to interact with a live app (any test that goes beyond pure file edits). Without it the agent has no way to discover selectors.

```json
{
  "browse": {
    "baseUrl": "https://your-app.com",
    "selectorPreference": ["data-test", "data-testid", "id", "name", "aria-label"],
    "headed": false,
    "email": "test@example.com",
    "password": "yourpassword",
    "maxSnapshotLines": 60
  }
}
```

| Field | Notes |
|---|---|
| `baseUrl` | Required if `browse` block is present. The fix agent uses this to resolve relative URLs. The POM agent uses it for `extractElements`. |
| `selectorPreference` | Order matters — first match wins for `bestSelector`. Valid tokens: `data-qa`, `data-testid`, `data-test`, `id`, `name`, `type`, `href`, `placeholder`, `aria-label`, `class`, `role`, `text`, `label`, `xpath`. (DOM walker only generates the first 9 — others are accepted by schema but never match.) |
| `headed` | `true` shows the Chromium window during extraction. Useful for debugging, off for CI. |
| `email` / `password` | Login credentials. Loaded into prompts as a credentials hint. The credential **values** also need to live in `src/data/qa/<locale>.json` for runtime use — `browse.email` here is purely an LLM hint so the agent knows the username convention. |
| `maxSnapshotLines` | Hard cap on `browse.snapshot` output size to keep fix-agent context small. |

### 13.5.3 The `setupFlows` block

Defines named sequences for reaching state-gated pages. **Optional** — only needed when login alone isn't enough to reach a target page (e.g., the cart page requires an item already added).

For most pages reachable by URL after login, you don't need a flow at all — `extractElements(url, { setupFlow: 'account' })` (just login) handles everything.

```json
{
  "setupFlows": {
    "account": [
      { "action": "login" }
    ],
    "cart": [
      { "action": "login" },
      { "action": "click", "pom": "InventoryPage", "field": "firstProductAddButton" },
      { "action": "click", "pom": "InventoryPage", "field": "cartIcon" }
    ]
  }
}
```

Each flow is an ordered list of typed steps:

| Action | Required fields | Optional fields | Behavior |
|---|---|---|---|
| `login` | — | — | Runs the built-in `performLogin` using credentials from `src/data/qa/<locale>.json` |
| `click` | one of: (`selector`) or (`pom` + `field`) | — | Clicks the resolved element. POM field references resolve at runtime by reading the actual selector from `src/pages/common/<pom>.ts` |
| `navigate` | `url` | — | Calls `page.goto(url)` and waits for `networkidle` |

**Bootstrap behavior:** if a flow's POM field reference points to a field that doesn't exist on disk yet (typical during initial POM creation), the framework catches the error, logs a warning, and falls back to the built-in generic flow for that flow name. This makes config flows safe to declare upfront.

> ⚠ **Domain assumption — current limitation.** The flow *name* is currently locked by the SetupFlow Zod enum to `'account'` | `'cart'` | `'checkout'` | `'payment'`. To add e.g. `dashboard` or `reports` you must edit the schema. Fix tracked in section 12.5 (Option B). Not blocking for e-commerce or any app where one of those four names is acceptable.

### 13.5.4 The `specFileNaming` block

Routes new tests to specific `.spec.ts` files based on test-case title patterns. **Optional** — built-in defaults handle common e-commerce vocabulary.

```json
{
  "specFileNaming": [
    { "pattern": "dashboard|metric|kpi|report",   "spec": "dashboard" },
    { "pattern": "coupon|promo|discount",         "spec": "promotions" },
    { "pattern": "admin|operator|backoffice",     "spec": "admin" }
  ]
}
```

- `pattern` — regex string, applied case-insensitively to the test title.
- `spec` — bare filename without extension (`[a-z0-9-]+`). Becomes `tests/generic/<spec>.spec.ts` (or locale-prefixed for non-generic tests).
- **First match wins.** Order entries by specificity — most specific first.
- User entries are checked **before** the built-in defaults. To override a default mapping, add your pattern with the same words first.
- Bad regex strings throw at config load — clear error rather than silent mis-routing.

The built-in defaults remain (`auth`, `cart`, `checkout`, `products`, `forms`, `home`, `account`, fallback `general`). You only add config entries for the categories your app needs that the defaults don't cover.

### 13.5.5 Starter configs by app type

#### Minimum viable — public single-page app, no auth

```json
{
  "model": "claude-haiku-4-5-20251001",
  "maxFixAttempts": 1,
  "browse": {
    "baseUrl": "https://your-app.com",
    "selectorPreference": ["data-testid", "id", "aria-label"]
  }
}
```

#### Auth-gated SaaS / dashboard / reports app

```json
{
  "model": "claude-haiku-4-5-20251001",
  "maxFixAttempts": 1,
  "browse": {
    "baseUrl": "https://your-app.com",
    "selectorPreference": ["data-test", "data-testid", "id", "name", "aria-label"],
    "email": "qa-bot@your-app.com",
    "password": "set-via-secret-manager"
  },
  "setupFlows": {
    "account": [{ "action": "login" }]
  },
  "specFileNaming": [
    { "pattern": "dashboard|metric|kpi|report", "spec": "dashboard" },
    { "pattern": "admin|operator", "spec": "admin" }
  ]
}
```

#### E-commerce app (full)

```json
{
  "model": "claude-haiku-4-5-20251001",
  "maxFixAttempts": 1,
  "browse": {
    "baseUrl": "https://your-store.com",
    "selectorPreference": ["data-test", "data-testid", "id", "name", "aria-label"],
    "email": "test@your-store.com",
    "password": "set-via-secret-manager"
  },
  "setupFlows": {
    "account": [{ "action": "login" }],
    "cart": [
      { "action": "login" },
      { "action": "click", "pom": "InventoryPage", "field": "firstProductAddButton" },
      { "action": "click", "pom": "InventoryPage", "field": "cartIcon" }
    ],
    "checkout": [
      { "action": "login" },
      { "action": "click", "pom": "InventoryPage", "field": "firstProductAddButton" },
      { "action": "click", "pom": "InventoryPage", "field": "cartIcon" },
      { "action": "click", "pom": "CartPage", "field": "checkoutButton" }
    ]
  }
}
```

### 13.5.6 Onboarding checklist

When pointing qa-agent at a brand-new framework repo for the first time:

1. ☐ Create `qa-agent.config.json` at repo root with at minimum: `model`, `browse.baseUrl`.
2. ☐ Verify framework layout matches section 13 — `src/pages/base/BasePage.ts`, `src/fixtures/base.fixture.ts`, `src/fixtures/pages.fixture.ts` (can be empty scaffold), `src/data/qa/<locale>.json` with at least one `users[]` entry.
3. ☐ If app has auth, populate `browse.email` / `browse.password` and ensure the same credentials exist in `src/data/qa/<locale>.json`.
4. ☐ If app has state-gated pages beyond simple login (cart, multi-step forms), define `setupFlows` for them. Start with just `account` — add others as you discover they're needed.
5. ☐ If your app's test categories don't match the built-in defaults (e.g. `dashboard`, `reports`, `coupons`), add `specFileNaming` patterns.
6. ☐ Run a smallest-possible test case (e.g. login) to validate the wiring before generating broader tests.
7. ☐ Set `ANTHROPIC_API_KEY` in the environment and run with `--llm anthropic`.

---

## 14. Implementation Phases

### Phase 1 — Build `page.extractElements` tool ✅
**Goal:** Replace ARIA snapshot browsing with a deterministic extraction tool. No LLM involved in selector discovery.

- [x] `src/tools/browser/extractElements.ts` — tool definition
- [x] Playwright browser launch + navigation (headless Chromium)
- [x] DOM walker via `page.evaluate()` defined as plain JS string (avoids tsx `__name` injection)
- [x] Auth support — `performLogin()` using data-qa selectors with fallbacks
- [x] Setup flows — `account`, `cart`, `checkout`, `payment`
- [x] Credential loader — scans `src/data/**/*.json` for `users[]`
- [x] Returns `ExtractedElement[]` with `selectors{}` map + `bestSelector`
- [x] Exports `DOM_WALKER_SCRIPT` + `ExtractedElement` for unit testing
- [x] Unit tests: `test/tools/browser/extractElements.test.ts` — 13 tests, all passing
  - data-qa wins, data-testid second, clean id third, numeric id skipped
  - name, type, href pattern, placeholder, aria-label
  - deduplication, hidden input exclusion

**Key technical decisions:**
- DOM walker as string constant → avoids tsx `__name` serialization bug
- Relative hrefs parsed without `URL` constructor → safe in `about:blank` (unit test context)
- `href*=first-segment` not full href → environment-safe selectors

---

### Phase 2 — Build POM Agent ✅
**Goal:** A focused LLM agent whose only job is POM creation and maintenance. Small prompt, limited toolset.

- [x] `src/orchestrator/pomAgent.ts`
- [x] System prompt ~250 tokens — POM rules only (GRAPH FIRST, EXTRACT, CREATE, METHODS, ATOMIC PAIR, SCOPE)
- [x] Task prompt ~150 tokens — test case + base URL + 6-step procedure
- [x] Tool registry: `framework.getGraph`, `page.extractElements`, `pom.createPage`, `pom.addSelector`, `pom.editMethod`, `fixture.addPage`
- [x] No browse tools, no test tools
- [x] Max 20 steps

---

### Phase 3 — Build Test Writer Agent ✅
**Goal:** A focused LLM agent whose only job is writing the spec file and test body. Never touches POMs.

- [x] `src/orchestrator/testWriterAgent.ts`
- [x] System prompt ~220 tokens — test writing rules only (GRAPH FIRST, TESTDATA, FIXTURES, METHODS, ASSERTIONS, BODY)
- [x] Task prompt ~120 tokens — test case + spec file path + locale + 5-step procedure
- [x] Tool registry: `framework.getGraph`, `testData.getSchema`, `test.createSpec`, `test.addCase`, `ast.addImport`
- [x] No browse tools, no POM tools
- [x] Spec file path inference from title keywords
- [x] Max 15 steps

---

### Phase 4 — Wire Orchestrator ✅
**Goal:** Replace the single generate phase with POM Agent → Test Writer Agent pipeline.

- [x] `src/orchestrator/qaAgent.ts` updated
- [x] Generate phase replaced: `runPomAgent(tc, baseUrl, ...)` then `runTestWriterAgent(tc, ...)`
- [x] Each sub-agent gets its own `ConversationLog` — context stays isolated
  - POM Agent log → `.qa-agent/runs/<id>/pom/run.json`
  - Test Writer log → `.qa-agent/runs/<id>/testwriter/run.json`
- [x] Fix Agent and execute/analyze loop unchanged
- [x] MCP browse tools still passed to Fix Agent (for public-page selector discovery)
- [x] TypeScript compiles clean, 123/124 tests pass (1 pre-existing failure)

**Key design decision:** Separate `ConversationLog` per sub-agent. The Test Writer starts with an empty context — it never sees the POM Agent's DOM extraction turns. This keeps each agent's context at the minimum possible size.

---

### Phase 5 — Validate ✅
**Goal:** Confirm the pipeline produces correct output end-to-end.

- [x] POM Agent creates POMs with correct fields and methods in one batched step
- [x] `fixture.addPage` registered atomically with `pom.createPage`
- [x] Test Writer writes spec using fixture names from `framework.getGraph`
- [x] `testData` fixture added to fixtures array when credentials used
- [x] No inline `fill/click` sequences in test body
- [x] `_autoNav` fixture handles navigation — no `goto()` in test bodies
- [x] Playwright runs pass on first attempt (saucedemo test suite)
- [x] Token usage: ~35K / 4–6 steps (down from 173K / 18 steps before batching fix)

### Phase 6 — Hardening ✅

- [x] `readExistingPages()` regex fixed — correctly detects already-registered POMs, prevents redundant re-extraction on subsequent runs
- [x] `pom.editMethod` sanitizes markdown link syntax (`[text](url)` → `text`) before writing to disk
- [x] `selectorPreference` unified — `extractElements.ts` DOM walker reads priority from `qa-agent.config.json` via `ToolContext`, removing the duplicate hardcoded list
- [x] `playwright` added as explicit dependency (was borrowed transitively from `@playwright/mcp`)
- [x] `.npmignore` created — `dist/` correctly included in published tarball

---

### Phase 7 — End-to-end stabilization ✅ (2026-05-08)

Round of fixes after running all 5 saucedemo cases and watching where token usage and step counts inflated.

**`extractElements` correctness fixes:**
- [x] **DOM walker IIFE injection** — `walkDOM` was returning `undefined` because `page.evaluate(stringFunction, arg)` doesn't pass the arg to a string-form function. Now wraps the script as `(${DOM_WALKER_SCRIPT})(${JSON.stringify(priority)})` so the call is fully applied before evaluation.
- [x] **`readFieldSelector` regex** — was `["']([^"']+)["']` which broke for any selector mixing quote styles (e.g. `this.loc("[data-test='checkout']")`). Now alternates: `(?:"([^"]+)"|'([^']+)')`.
- [x] **`filter` parameter** added to `page.extractElements` — case-insensitive substring match on text, bestSelector, and selector values. Reduces fix-agent context size when only one element is needed.
- [x] **setupFlow fallback** — config flow throws → catch → log warning → reset page → run built-in flow. Eliminates the bootstrap chicken-and-egg where config flows reference POM fields that don't exist on disk yet during initial POM creation.

**`parseReport` correctness fix:**
- [x] **Prefer `result.errors[]` array** — Playwright `timedOut` test results put a generic message (`"Test timeout of 30000ms exceeded."`) in `result.error.message` and the actual locator detail (e.g. `waiting for locator '[data-test=\'checkout\']'`) in `result.errors[1]`. Now searches the array for an entry containing locator/waiting-for/selector keywords; falls back to `result.error` only if none found. Without this, the classifier saw a generic timeout and routed everything to `rule.timeout.generic` instead of `rule.selector.timeout`.

**POM agent prompt:**
- [x] **Graph-as-truth for existence checks** — fs.read is now scoped to "method bodies / selector values," not "what fields exist." The graph already lists field names and method signatures.
- [x] **No post-edit verification** — explicit rule: after `pom.createPage` / `pom.addSelector` / `pom.editMethod` / `fixture.addPage` succeeds, do NOT re-read the file or call `framework.getGraph` to confirm. The next phase runs the test, that's the verification.

**Fix agent prompt:**
- [x] **`baseUrl` in credentialsHint** — `BrowseCreds` interface had `baseUrl?: string` but `credentialsHint` only emitted email/password. Now includes baseUrl. Without it the fix agent guessed URLs (sometimes `localhost:3000`, sometimes correct via well-known credentials).
- [x] **"Selector matches existing → bug is upstream"** — added rule: if `extractElements` returns an element whose selectors are functionally equivalent to the existing POM selector, the POM is correct and the bug is in a method called *before* the failing line. Read the test, identify the previous step's POM method, fs.read it, and use `pom.editMethod`. This catches false-positive selector classifications where the test never reached the page.

**Validation results (all 5 cases, baseline run IDs in `<framework>/.qa-agent/runs/`):**

| # | Test | POM steps | POM tokens | Fix needed? |
|---|------|-----------|-----------|-------------|
| 1 | login | 5 | 28K | No |
| 2 | sort-products | 4 | 21K | No |
| 3 | add-to-cart-checkout | 12 | 109K | No |
| 4 | remove-from-cart | 5 | 35K | No |
| 5 | checkout-info-validation | 5 | 26K | No |

Zero fix attempts across all five. Total POM cost: 31 steps / 219K (vs 39 / 285K pre-fix).

### Watchlist (deferred)

See `~/.claude/projects/.../memory/project_qa_agent.md` for full list.

1. DOM walker doesn't enumerate non-interactive elements (prices, error messages, headings) — agent guesses.
2. POM agent missing-page planning gap — sometimes maps "Click Finish" to checkout-complete, missing checkout-step-two.
3. Test writer redundant `fs.read` (directories, repo root).
4. Leftover upfront `fs.read` on existing-POM extension cases.
5. **E-commerce assumptions hardcoded** — see section 12.5.

---

## 15. Future Direction — Maintain-Agent (Planned)

> **Status:** Design only. Not implemented. Captured here so the reasoning isn't lost between iterations.
> Do not start building until current qa-agent has been used in real-world test creation for at least one workweek.

### 15.1 Motivation

qa-agent today does two distinct jobs in one pipeline:

- **Test creation** — given a test case JSON, produce POMs + spec files that pass.
- **First-pass repair** — if the freshly-generated test fails on first execute, the fix agent repairs it.

These are coupled because they happen in the same per-test-case loop. As real test suites grow, a different mode of operation becomes valuable:

- **Suite maintenance** — periodically run the *existing* suite, identify what broke (because the app evolved, not because the tests were freshly generated), repair in batch.

This is structurally different work:

| Concern | qa-agent (creation) | maintain-agent (repair) |
|---|---|---|
| Trigger | Test case JSON delivered | Schedule (nightly) or manual invocation |
| Input | Single test case at a time | Whole suite (or filtered subset) |
| Output | New files | Fixes to existing files + report |
| Loop shape | Per-test-case state machine | Batch: run all → triage → fix → re-run |
| Stops when | One test passes | Whole suite passes or budget exhausts |

Conflating them in one CLI/codebase optimizes neither. Separating them lets each agent's prompts, orchestration, and CLI ergonomics fit its job.

### 15.2 Core design — the Failure Index

The key insight that makes maintain-agent qualitatively better than naive batch fixing: **aggregate failures into a structured index BEFORE invoking the fix agent.**

```
Suite run → Playwright JSON report → Failure Index
                                       │
                                       ├─ selectors:
                                       │    "[data-test='checkout']":
                                       │       affectedTests: ["cart > checkout flow", ... × 12]
                                       │       pomField: "CartPage.checkoutButton"
                                       │       pomFile: "src/pages/common/CartPage.ts"
                                       │       representativeFailure: <NormalizedFailure>
                                       │
                                       ├─ assertions:
                                       │    "expected 'Welcome' got 'Sign in'":
                                       │       affectedTests: [... × 3]
                                       │
                                       ├─ navigation: ...
                                       └─ unknown: <NormalizedFailure[]>
```

The fix agent is then invoked **per index entry** (one call per root cause), not per failure.

Each invocation receives explicit scope context:

> "The locator `[data-test='checkout']` is failing in 12 tests across cart.spec.ts. The relevant POM field is `CartPage.checkoutButton`. Fix the field's selector to resolve all 12 tests. A wrong fix leaves all 12 still failing."

### 15.3 Why the index changes everything

1. **Triage, not just fix.** The framework knows "fix this one thing → unblock 12 tests" before any LLM work begins. Mirrors how a human SDET actually triages.
2. **Prioritization.** Sort by `affectedTests.length` desc. Fix the issue that unblocks 50 tests before the one that unblocks 1. Token budget goes to highest-impact fixes first.
3. **Token efficiency.** N failures + M root causes → M fix-agent invocations, not N. With 50 tests sharing 5 root causes: 5 invocations, not 50.
4. **Per-fix context stays small.** Agent sees one issue + its scope, not all 50 failures.
5. **Confidence signal.** "This selector is used by 12 tests" tells the agent: be careful, your change has wide impact.
6. **Deterministic plan.** Index is purely a function of the JSON report. Reproducible across runs.
7. **Reportable artifact.** The index itself is valuable even before fixes run — outputs as a triage dashboard.
8. **Detect "fix breaks others".** Compare old index vs new index after a fix runs. New entries = regression caused by the fix.
9. **Bounded budget.** "Fix top N root causes per run." Long tail gets reported but not auto-fixed; humans triage the rest.

### 15.4 What's actually new vs reused

The vast majority of the data is already in qa-agent's existing pipeline. maintain-agent is recombining it.

| Piece | Status |
|---|---|
| Playwright JSON report parsing | ✅ Reuse `src/tools/exec/parseReport.ts` |
| Failure classification | ✅ Reuse `src/failure/classify.ts` + `rules.ts` |
| Locator extraction from selector failures | ✅ Already in classifier output |
| Generic agent loop | ✅ Reuse `src/agent/loop.ts` |
| Fix-agent prompts (with minor batch-context extension) | ✅ Reuse `src/orchestrator/agents/fixPrompts.ts` |
| Tool registry (fs, pom, test, ast, browser) | ✅ Reuse `src/tools/*` |
| LLM client | ✅ Reuse `src/llm/anthropicClient.ts` |
| **POM-field tracer** (stack location → POM field name) | 🆕 ~50 lines ts-morph |
| **Failure indexer** (aggregator) | 🆕 ~150 lines |
| **Suite scanner** (find spec files, optionally filter by tag) | 🆕 ~50 lines |
| **Maintain orchestrator** (batch state machine) | 🆕 ~200 lines |
| **Updated fix-agent task framing** (one prompt addition) | 🆕 ~30 lines |
| **CLI entry** | 🆕 ~100 lines |

Only one genuinely novel piece: the **POM-field tracer**. Playwright's stack trace already shows `at CartPage.checkout (.../CartPage.ts:19:31)`. The tracer reads CartPage.ts at line 19 col 31, walks the AST to find which `this.<fieldName>` is being used at that location, and returns `{ pomFile, className, fieldName }`. Uses ts-morph (already a dependency).

### 15.5 Staged build plan

Each stage has an explicit gate. Worst case at any stage: abandon stage and revert. Each stage is independently valuable.

#### Stage 1 — Failure Indexer (zero risk)

- Build the indexer as a **standalone script**. No new agent, no orchestrator, no fix logic.
- Reads Playwright JSON report (existing files in `.qa-agent/runs/<id>/artifacts/`)
- Classifies each failure (existing classifier)
- Aggregates into the structured index above
- Outputs the index as JSON or formatted text
- ✅ **Gate:** the index correctly identifies failures and groups by root cause when run against historical reports.

This stage is purely additive. Zero changes to qa-agent code. Independently useful as a triage report.

#### Stage 2 — POM-field tracer (still low risk)

- Build the tracer as a separate module
- Test against the index from Stage 1
- Verify it correctly maps stack-trace locations to POM field names for known historical failures
- ✅ **Gate:** tracer is accurate for the existing 5 test cases' historical failures (cart.spec.ts checkout button, etc.).

Still purely additive. Tracer is testable in isolation against fixture data.

#### Stage 3 — Maintain-agent CLI + orchestrator (moderate risk)

- New binary entry, new orchestrator
- **Imports from qa-agent — no refactor of qa-agent itself.**
- Cross-import boundary is acceptable temporarily; refactor only if Stage 4 happens.
- Run against deliberately broken fixtures (same approach used to validate fix agent)
- Run all 5 qa-agent test cases too — verify nothing in qa-agent regressed
- ✅ **Gate:** qa-agent works exactly as before, maintain-agent fixes broken tests.

Risk here is real but bounded. If maintain-agent has bugs, qa-agent is unaffected because no qa-agent code changed.

#### Stage 4 — Refactor for clean code reuse (only if Stage 3 succeeded)

- Move shared code to `src/shared/` based on what Stage 3 actually used (data-driven, not speculative)
- Update qa-agent and maintain-agent to import from `src/shared/` cleanly
- Re-run all qa-agent tests AND maintain-agent tests
- ✅ **Gate:** everything still works, code is now properly shared, no cross-binary imports.

Stage 4 is optional. If the cross-import boundary from Stage 3 isn't bothering anyone, skip Stage 4.

### 15.6 Repo layout — recommendation

For the staged build, **Option 2** (same repo, two binaries) is the lowest-friction path:

```
qa-agent/                ← repo as it exists today
  src/
    tools/               ← shared (used by both binaries)
    failure/             ← shared
    agent/               ← shared (loop.ts)
    llm/                 ← shared
    config/              ← shared (with maintain-specific extensions)
    orchestrator/
      agents/            ← qa-agent only (POM, test writer agents)
      qaAgent.ts         ← qa-agent only
      maintain/          ← maintain-agent only (NEW after Stage 3)
        indexer.ts
        tracer.ts
        orchestrator.ts
    cli.ts               ← qa-agent CLI (existing)
    cli/maintain.ts      ← maintain CLI (NEW after Stage 3)
  package.json           ← bin: { "qa-agent": ..., "maintain-agent": ... }
```

Refactor (Stage 4, optional) moves shared dirs into `src/shared/` once the boundary is clear from real use.

### 15.7 Open questions to resolve before Stage 3

These are decisions that need data from real qa-agent use (i.e., the workweek-of-soaking before starting):

1. **Re-run scope after fix:** re-run only originally-failed tests, or the whole suite? Trade-off: re-running only failed misses fix-induced regressions; re-running all is expensive.
2. **Conflicting fixes:** if two index entries suggest contradictory changes to the same POM field, which wins? Likely answer: highest-affected-count, but real failure data may say otherwise.
3. **Fix budget per run:** "fix top 10 root causes," or "fix until budget exhausts"? Depends on observed convergence behavior.
4. **Index persistence:** does each run produce a new index, or do we maintain a rolling history? Rolling history enables "this issue has been failing for 3 nights" signal but adds storage complexity.
5. **Fix-agent prompt extensions:** what minimum framing changes does the fix agent need to behave well in batch mode? Likely just a "you're maintaining a stable suite, this fix affects N tests" preamble.

None of these block Stages 1 and 2. They surface during Stage 3.

### 15.8 Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| POM-field tracer mis-traces edge cases (locale overrides, nested methods) | Medium | Test against historical failures in Stage 2; explicit gate before Stage 3 |
| Failure aggregation misgroups (same locator, different POM fields) | Medium | Index keys include POM file path + field name, not just locator string |
| Fix agent over-corrects with batch context | Medium | Resolved by prompt iteration during Stage 3 |
| Refactor (Stage 4) introduces import cycles | Low | TypeScript catches at build; optional stage |
| qa-agent regresses during Stage 3 cross-imports | Low | Stage 3 doesn't modify qa-agent code; only adds new code |
| Conflicting fix attempts oscillate between runs | Medium | Limit fix attempts per root cause per run; surface as "needs human" if not converged |

### 15.9 What this is NOT

To avoid scope creep:

- **Not a CI runner replacement.** maintain-agent doesn't replace your existing CI/CD pipeline. It's invoked from one (or a cron, or a developer's machine).
- **Not a flake handler.** Flaky tests classified as `retry` are out of scope — they're transient, not structural. Fix the test or quarantine it.
- **Not a universal app crawler.** It works on tests that already exist. Test creation stays in qa-agent.
- **Not a coverage tool.** It maintains existing coverage, not finds gaps.
