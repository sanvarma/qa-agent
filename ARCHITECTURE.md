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
}
```

### 4.2 Setup Flows

Pages that require app state cannot be reached by a direct URL. The extractor handles them with predefined Playwright sequences:

| Page | Requires | Setup flow |
|---|---|---|
| Login | Nothing | Navigate directly |
| Products list | Nothing | Navigate directly |
| Product detail | Nothing | Navigate directly |
| Account | Login session | `account`: login → navigate |
| Cart | Login + item in cart | `cart`: login → add product → navigate |
| Checkout | Login + item in cart | `checkout`: login → add + go to cart → proceed |
| Payment | Login + reached checkout | `payment`: login → add + cart + checkout → navigate |
| Order confirmation | Completed order | Not supported — structural patterns only |

Credentials are loaded automatically from `src/data/qa/<locale>.json` → `users[]`. Never passed directly in the tool call.

### 4.3 DOM Walker

Runs via `page.evaluate()` as a plain JS string (not a TypeScript function — avoids tsx `__name` injection that breaks browser serialization).

**Elements captured:** `input` (non-hidden), `button`, `a[href]`, `select`, `textarea`, `[role="button"]`

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

The agent infers the spec file path from the test title unless `specFile` is set in the test case JSON:

| Title keyword | Spec file |
|---|---|
| login, logout, sign in/up, register, credential | `auth.spec.ts` |
| cart, basket, add to cart | `cart.spec.ts` |
| checkout, payment, order, purchase | `checkout.spec.ts` |
| product, search, filter, category | `products.spec.ts` |
| contact, form, submit | `contact.spec.ts` |
| account, profile, settings | `account.spec.ts` |
| (none match) | `general.spec.ts` |

Generic tests → `tests/generic/<name>.spec.ts`
Locale tests → `tests/locales/<locale>/<name>.spec.ts`

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
