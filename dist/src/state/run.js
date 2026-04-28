import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export class RunState {
    meta;
    dir;
    turns = [];
    constructor(meta, dir) {
        this.meta = meta;
        this.dir = dir;
    }
    append(turn) {
        this.turns.push(turn);
    }
    async persist() {
        await mkdir(this.dir, { recursive: true });
        const payload = { meta: this.meta, turns: this.turns };
        await writeFile(join(this.dir, 'run.json'), JSON.stringify(payload, null, 2), 'utf8');
    }
}
export function newRunId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 7);
    return `${stamp}-${rand}`;
}
//# sourceMappingURL=run.js.map