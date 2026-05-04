# QA Agent — Architecture

## 1. Orchestrator Phase Flow

```mermaid
flowchart TD
    START([Test Case Input]) --> PRE{Test already\nexists in repo?}
    PRE -- yes --> EXEC
    PRE -- no --> GEN

    GEN[GENERATE\nLLM writes POM + test]
    EXEC[EXECUTE\nRun Playwright tests]
    ANA[ANALYZE\nParse report + classify failure]
    FIX[FIX\nLLM applies minimal fix]
    DONE([DONE ✓])
    EXH([EXHAUSTED ✗])

    GEN --> EXEC
    EXEC -- pass --> DONE
    EXEC -- fail --> ANA
    ANA -- action=retry\n& budget ok --> EXEC
    ANA -- action=retry\n& budget exhausted --> EXH
    ANA -- fix needed\n& budget ok --> FIX
    ANA -- fix needed\n& budget exhausted --> EXH
    FIX --> EXEC
```

---

## 2. Tool Registry by Phase

```mermaid
flowchart LR
    subgraph GENERATE ["Generate Phase Tools"]
        direction TB
        G1[framework.getGraph]
        G2[testData.getSchema]
        G3[fs.read]
        G4[test.createSpec]
        G5[test.addCase]
        G6[ast.addImport]
        G7[pom.createPage]
        G8[pom.addSelector]
        G9[pom.updateSelector]
        G10[pom.editMethod]
        G11[fixture.addPage]
        G12[browse.*\n6 MCP tools — optional]
    end

    subgraph FIX ["Fix Phase Tools"]
        direction TB
        F1[fs.read]
        F2[test.editCase]
        F3[pom.updateSelector]
        F4[pom.addSelector]
        F5[pom.editMethod]
        F6[ast.addImport]
        F7[browse.*\noptional]
    end
```

---

## 3. Generate Phase — Step Sequence

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant L as LLM
    participant T as Tools

    O->>L: system prompt + task (spec file path, test case)
    
    Note over L,T: Step 1 — batched
    L->>T: framework.getGraph()
    L->>T: fs.read(spec file)
    T-->>L: { pages: { LoginPage: { fields, methods, fixture, localeOverrides } } }
    T-->>L: ENOENT or existing spec content

    Note over L,T: Steps 3-5 — POM setup
    L->>T: pom.createPage (if POM missing from graph)
    L->>T: fixture.addPage (if fixture: null in graph)

    Note over L,T: Steps 4 — browse (optional)
    L->>T: browse.navigate(fullUrl)
    T-->>L: page snapshot
    L->>T: browse.click / browse.type (to trigger state)
    L->>T: browse.evaluate (to inspect DOM)
    L->>T: pom.updateSelector (fix wrong selector)

    Note over L,T: Steps 6-8 — write test
    L->>T: test.createSpec (if file missing)
    L->>T: test.addCase(title, body, fixtures, describe)
    T-->>L: diff showing inserted test

    Note over L,T: Step 9 — locale companions (generic only)
    L->>L: check localeOverrides from graph result
    L->>T: test.createSpec + test.addCase (per affected locale)
```

---

## 4. framework.getGraph — Data Flow

```mermaid
flowchart TD
    subgraph INPUT ["Scanned on every call"]
        A[src/pages/common/*.ts]
        B[src/pages/locales/*/*.ts]
        C[src/fixtures/pages.fixture.ts]
    end

    subgraph PARSE ["ts-morph parsing"]
        D[Parse class\nfields: this.loc props\nmethods: signatures only\nno bodies]
        E[Parse locale overrides\nfields + methods that differ]
        F[Regex extract\nclassName → fixtureName]
    end

    subgraph OUTPUT ["Returned to LLM — one call replaces:"]
        G["pages.getStructure (old)\nfs.read pages.fixture.ts (old)\nfs.read each POM (old)"]
    end

    A --> D
    B --> E
    C --> F
    D --> G
    E --> G
    F --> G

    G --> LLM[LLM knows:\n• which POMs exist\n• exact field names\n• method signatures with params\n• fixture registration status\n• locale override files + their fields]
```

---

## 5. fixture.addPage — Self-Healing Logic

```mermaid
flowchart TD
    START([fixture.addPage called]) --> IC{PageFixtures type\nalready has fixtureName?}
    IC -- yes --> NOOP([return changed:false])
    IC -- no --> IMP[Add import for className]

    IMP --> CT{PageFixtures\ntype exists?}
    CT -- no --> CRT[Insert\ntype PageFixtures = {}\\nafter last import]
    CT -- yes --> AP
    CRT --> AP[addProperty\nfixtureName: ClassName\nto type literal]

    AP --> TV{export const test\n= base.extend exists?}
    TV -- no --> CRE[Insert\nexport const test = base.extend&lt;PageFixtures&gt;\nbefore first export declaration]
    TV -- yes --> APA
    CRE --> APA[addPropertyAssignment\nfixtureName: async fn\nto extend object]

    APA --> SAVE([Save + return diff])
```

---

## 6. Token Budget — Before vs After

```mermaid
xychart-beta
    title "Input tokens per test generation run"
    x-axis ["Before\noptimisation", "After prompt\ncompression", "After\nframework.getGraph"]
    y-axis "Tokens (K)" 0 --> 160
    bar [144, 45, 35]
```

> **Key savings:**
> - System prompt: 3,362 → 1,202 tokens (64% reduction)
> - `framework.getGraph` replaces: `pages.getStructure` + `fs.read pages.fixture.ts` + 3–4 individual POM `fs.read` calls
> - Step 9 locale check: no extra tool call — uses graph result from step 1
> - `fixture.addPage` no longer silently skips when skeleton is missing — prevents re-creation loops

---

## 7. Source Tree

```
src/
├── orchestrator/
│   ├── qaAgent.ts          # phase loop, tool registry setup
│   ├── prompts.ts          # system prompt + task prompt builders
│   ├── testCase.ts         # TestCase type + renderer
│   └── state.ts            # phase state machine
│
├── tools/
│   ├── framework/
│   │   └── getGraph.ts     # ★ NEW — full POM inventory (fields, sigs, fixtures, locales)
│   ├── pages/
│   │   └── getStructure.ts # deprecated — superseded by framework.getGraph
│   ├── testdata/
│   │   └── getSchema.ts    # ★ NEW — real field names from src/data/ JSON files
│   ├── test/
│   │   ├── addCase.ts      # insert test into describe block (always uses describe)
│   │   ├── createSpec.ts
│   │   ├── editCase.ts
│   │   └── findCase.ts
│   ├── pom/
│   │   ├── createPage.ts
│   │   ├── addSelector.ts
│   │   ├── updateSelector.ts
│   │   └── editMethod.ts
│   ├── fixture/
│   │   └── addPage.ts      # ★ FIXED — self-heals missing type + extend skeleton
│   ├── ast/
│   │   └── addImport.ts
│   └── fs/
│       └── read.ts
│
├── ast/
│   ├── testInserter.ts     # ★ FIXED — always inserts inside describe block
│   ├── importEditor.ts
│   ├── diff.ts
│   └── project.ts
│
├── agent/
│   ├── loop.ts             # LLM ↔ tool call loop
│   └── conversationLog.ts
│
├── llm/
│   └── anthropicClient.ts
│
├── failure/
│   ├── classify.ts         # rule-based failure classifier
│   └── rules.ts
│
└── mcp/
    └── playwrightServer.ts # browse.* MCP tools (optional, config-gated)
```
