import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
export class OrchestratorLogger {
    runId;
    toStdout;
    path;
    readyPromise;
    constructor(runDir, runId, toStdout = true) {
        this.runId = runId;
        this.toStdout = toStdout;
        this.path = join(runDir, 'orchestrator.log.jsonl');
        // Ensure parent dir exists before any write attempt. Kept as a single
        // promise so concurrent log() calls all await the same init.
        this.readyPromise = mkdir(runDir, { recursive: true }).then(() => undefined);
    }
    async log(phase, event, attempt, level, data) {
        const entry = {
            ts: new Date().toISOString(),
            level,
            phase,
            event,
            attempt,
            runId: this.runId,
            data,
        };
        await this.readyPromise;
        const line = JSON.stringify(entry) + '\n';
        await appendFile(this.path, line, 'utf8');
        if (this.toStdout) {
            // Keep stdout line short and readable — JSON is in the file.
            const dataPreview = data !== undefined ? ` ${summarize(data)}` : '';
            // eslint-disable-next-line no-console
            console.log(`[${entry.ts}] ${phase}/${event} attempt=${attempt} level=${level}${dataPreview}`);
        }
    }
    info(phase, event, attempt, data) {
        return this.log(phase, event, attempt, 'info', data);
    }
    warn(phase, event, attempt, data) {
        return this.log(phase, event, attempt, 'warn', data);
    }
    error(phase, event, attempt, data) {
        return this.log(phase, event, attempt, 'error', data);
    }
}
function summarize(data) {
    try {
        const s = typeof data === 'string' ? data : JSON.stringify(data);
        return s.length > 200 ? s.slice(0, 200) + '…' : s;
    }
    catch {
        return '[unserializable]';
    }
}
//# sourceMappingURL=logger.js.map