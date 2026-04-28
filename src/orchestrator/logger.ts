import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEvent {
  ts: string;               // ISO 8601
  level: LogLevel;
  phase: string;            // the orchestrator phase at the time of the event
  event: string;            // short machine-readable tag, e.g. "phase.enter"
  attempt: number;          // current attemptsUsed
  runId: string;
  // Arbitrary structured payload. JSON-serializable.
  data?: unknown;
}

export class AgentLogger {
  private readonly path: string;
  private dirPromise: Promise<void>;

  constructor(runDir: string, private readonly runId: string, private readonly toStdout: boolean = true) {
    this.path = join(runDir, 'orchestrator.log.jsonl');
    // Ensure parent dir exists before any write attempt. Kept as a single
    // promise so concurrent log() calls all await the same init.
    this.dirPromise = mkdir(runDir, { recursive: true }).then(() => undefined);
  }

  async log(phase: string, event: string, attempt: number, level: LogLevel, data?: unknown): Promise<void> {
    const entry: LogEvent = {
      ts: new Date().toISOString(),
      level,
      phase,
      event,
      attempt,
      runId: this.runId,
      data,
    };
    await this.dirPromise;
    const line = JSON.stringify(entry) + '\n';
    await appendFile(this.path, line, 'utf8');

    if (this.toStdout) {
      // Keep stdout line short and readable — JSON is in the file.
      const dataPreview = data !== undefined ? ` ${summarize(data)}` : '';
      // eslint-disable-next-line no-console
      console.log(`[${entry.ts}] ${phase}/${event} attempt=${attempt} level=${level}${dataPreview}`);
    }
  }

  info(phase: string, event: string, attempt: number, data?: unknown): Promise<void> {
    return this.log(phase, event, attempt, 'info', data);
  }

  warn(phase: string, event: string, attempt: number, data?: unknown): Promise<void> {
    return this.log(phase, event, attempt, 'warn', data);
  }

  error(phase: string, event: string, attempt: number, data?: unknown): Promise<void> {
    return this.log(phase, event, attempt, 'error', data);
  }
}

function summarize(data: unknown): string {
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return '[unserializable]';
  }
}
