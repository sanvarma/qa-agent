/**
 * A scripted LLM that distinguishes generate vs fix tasks by the system prompt
 * or task text, and emits a plausible tool-call sequence for each.
 *
 * This is NOT a good agent — it does the minimum to exercise the orchestrator
 * end-to-end: in generate, it calls createSpec + addImport + addCase and stops.
 * In fix, it reads the suggested fixTarget.file and calls the tool implied by
 * the action (update_pom => pom.updateSelector; update_test => test.editCase).
 *
 * Real work (choosing selectors, writing real test bodies) requires a real LLM.
 */
export class ScriptedQaClient {
    name = 'scripted-qa';
    callCounter = 0;
    async complete(req) {
        const system = req.system;
        const lastUser = findLastUserTask(req.history);
        if (system.includes('GENERATE phase')) {
            return this.planGenerate(lastUser, req.history);
        }
        if (system.includes('FIX phase')) {
            return this.planFix(lastUser, req.history);
        }
        // Unknown context — stop cleanly.
        return { toolCalls: [], stopReason: 'end_turn' };
    }
    nextId() {
        this.callCounter += 1;
        return `sq_${this.callCounter}`;
    }
    planGenerate(task, history) {
        // Determine how far along we are by counting prior assistant tool calls
        // in THIS agent-loop invocation. (The orchestrator reuses RunState, so
        // history accumulates across phases — we look at only the last user-task
        // boundary.)
        const stepsThisPhase = countAssistantToolCallsSinceLastTask(history);
        const specFile = extractSpecFile(task) ?? 'tests/agent-generated.spec.ts';
        const title = extractTitle(task) ?? 'agent-generated test';
        switch (stepsThisPhase) {
            case 0:
                return this.emit([
                    {
                        name: 'test.createSpec',
                        input: { file: specFile },
                    },
                ]);
            case 1:
                return this.emit([
                    {
                        name: 'ast.addImport',
                        input: {
                            file: specFile,
                            from: '@playwright/test',
                            named: ['test', 'expect'],
                        },
                    },
                ]);
            case 2:
                return this.emit([
                    {
                        name: 'test.addCase',
                        input: {
                            file: specFile,
                            title,
                            body: "await page.goto('/');\nawait expect(page).toHaveTitle(/.*/);",
                        },
                    },
                ]);
            default:
                return { text: 'Test generated.', toolCalls: [], stopReason: 'end_turn' };
        }
    }
    planFix(task, history) {
        const stepsThisPhase = countAssistantToolCallsSinceLastTask(history);
        const action = extractField(task, 'Action');
        const file = extractField(task, 'Suspected file');
        const locator = extractField(task, 'Failing locator');
        // 'retry' is handled by the orchestrator — we should never see it here,
        // but if we do, stop without edits.
        if (action === 'retry') {
            return { text: 'No edit needed; orchestrator will retry.', toolCalls: [], stopReason: 'end_turn' };
        }
        if (stepsThisPhase > 0) {
            return { text: 'Fix applied.', toolCalls: [], stopReason: 'end_turn' };
        }
        if (action === 'update_pom' && file && locator) {
            // Inferring a "better" selector here is outside scope for the mock.
            // We just swap the selector for a placeholder so the mechanics are exercised.
            return this.emit([
                {
                    name: 'pom.updateSelector',
                    input: {
                        file,
                        name: guessSelectorFieldName(locator) ?? 'field',
                        newSelector: `${locator}-fixed`,
                    },
                },
            ]);
        }
        if (action === 'update_test' && file) {
            const title = extractField(task, 'Test') ?? 'unknown test';
            return this.emit([
                {
                    name: 'test.editCase',
                    input: {
                        file,
                        title,
                        newBody: "// edited by mock: assertion relaxed\nawait expect(page).toHaveTitle(/.*/);",
                    },
                },
            ]);
        }
        // No actionable signal — stop without edits.
        return { text: 'Mock could not determine a fix.', toolCalls: [], stopReason: 'end_turn' };
    }
    emit(calls) {
        return {
            toolCalls: calls.map((c) => ({ id: this.nextId(), name: c.name, input: c.input })),
            stopReason: 'tool_use',
        };
    }
}
// -- helpers ----------------------------------------------------------------
function findLastUserTask(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const t = history[i];
        if (t.role === 'user' && t.content.text)
            return t.content.text;
    }
    return '';
}
/**
 * The orchestrator calls runAgent multiple times. Each call seeds a fresh user
 * task, but RunState.turns persists across calls. To count "steps in THIS phase,"
 * we count assistant tool calls since the most recent user turn that had a text
 * message (i.e., a task) and no tool results.
 */
function countAssistantToolCallsSinceLastTask(history) {
    let lastTaskIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
        const t = history[i];
        if (t.role === 'user' && t.content.text && t.content.toolResults.length === 0) {
            lastTaskIdx = i;
            break;
        }
    }
    let count = 0;
    for (let i = lastTaskIdx + 1; i < history.length; i++) {
        const t = history[i];
        if (t.role === 'assistant' && t.content.toolCalls.length > 0)
            count += 1;
    }
    return count;
}
function extractField(task, name) {
    const re = new RegExp(`^${name}:\\s*(.+)$`, 'm');
    const m = task.match(re);
    return m ? m[1].trim() : undefined;
}
function extractSpecFile(task) {
    return extractField(task, 'Write the test to') ?? extractField(task, 'Spec file');
}
function extractTitle(task) {
    return extractField(task, 'Title');
}
function guessSelectorFieldName(_locator) {
    // The mock doesn't try to infer the correct POM field from a selector string.
    // A real LLM reads the POM file via fs.read and picks the field. Returning
    // undefined here makes the caller fall through to the 'field' placeholder.
    return undefined;
}
//# sourceMappingURL=scriptedQaClient.js.map