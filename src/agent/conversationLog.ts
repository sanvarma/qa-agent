import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Turn } from './types.js';

export interface RunMeta {
  id: string;
  task: string;
  repoRoot: string;
  model: string;
  startedAt: string;
}

export class ConversationLog {
  readonly turns: Turn[] = [];
  constructor(readonly meta: RunMeta, readonly dir: string) {}

  append(turn: Turn): void {
    this.turns.push(turn);
  }

  async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const payload = { meta: this.meta, turns: this.turns };
    await writeFile(join(this.dir, 'run.json'), JSON.stringify(payload, null, 2), 'utf8');
  }
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${stamp}-${rand}`;
}
