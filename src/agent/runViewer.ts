import type { RunMeta } from './conversationLog.js';
import type { Turn } from './types.js';
import type { LogEvent } from '../orchestrator/logger.js';

interface AgentData { meta: RunMeta; turns: Turn[]; }
interface Agents { pom?: AgentData; testwriter?: AgentData; }

/**
 * Generate a self-contained HTML run viewer for the given conversation.
 * The data is embedded as a JSON literal — no external dependencies needed.
 */
export function generateRunViewerHtml(
  meta: RunMeta,
  turns: Turn[],
  logEvents: LogEvent[] = [],
  agents: Agents = {},
): string {
  const data = JSON.stringify({ meta, turns, logEvents, agents });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escAttr(meta.id)} — QA Agent Run</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; font-size: 13px; }
  .header { background: #1a1d2e; border-bottom: 1px solid #2d3148; padding: 16px 24px; }
  .header h1 { font-size: 15px; font-weight: 600; color: #a5b4fc; margin-bottom: 6px; }
  .meta { display: flex; gap: 20px; flex-wrap: wrap; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; }
  .meta-value { font-size: 12px; color: #cbd5e1; font-family: monospace; }

  /* Tabs */
  .tabs { display: flex; gap: 2px; padding: 0 24px; background: #141722; border-bottom: 1px solid #1e2235; }
  .tab { padding: 10px 16px; font-size: 12px; font-weight: 600; color: #475569; cursor: pointer; border-bottom: 2px solid transparent; letter-spacing: 0.02em; user-select: none; }
  .tab:hover { color: #94a3b8; }
  .tab.active { color: #a5b4fc; border-bottom-color: #6366f1; }
  .tab.disabled { color: #2d3148; cursor: default; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .stats { display: flex; gap: 16px; padding: 10px 24px; background: #141722; border-bottom: 1px solid #1e2235; flex-wrap: wrap; }
  .stat { display: flex; align-items: center; gap: 6px; }
  .stat-num { font-weight: 700; font-size: 15px; }
  .stat-label { color: #64748b; font-size: 11px; }
  .stat.warn .stat-num { color: #fb923c; }
  .stat.ok .stat-num { color: #4ade80; }
  .stat.info .stat-num { color: #60a5fa; }
  .stat.err .stat-num { color: #f87171; }
  .stat.tok .stat-num { color: #e879f9; }

  /* Orchestrator panel */
  .orch-panel { margin: 16px 24px; background: #12151f; border: 1px solid #2d3148; border-radius: 10px; overflow: hidden; }
  .orch-header { background: #1a1d2e; padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #2d3148; }
  .orch-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; }
  .orch-totals { display: flex; gap: 20px; }
  .orch-total { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
  .orch-total-val { font-size: 13px; font-weight: 700; font-family: monospace; }
  .orch-total-lbl { font-size: 10px; color: #64748b; text-transform: uppercase; }
  .orch-total.time .orch-total-val { color: #60a5fa; }
  .orch-total.in   .orch-total-val { color: #a78bfa; }
  .orch-total.out  .orch-total-val { color: #e879f9; }
  .orch-phases { padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
  .orch-phase { display: flex; align-items: center; gap: 12px; padding: 7px 12px; border-radius: 6px; background: #1a1d2e; border: 1px solid #232740; }
  .orch-phase.ok   { border-left: 3px solid #22c55e; }
  .orch-phase.err  { border-left: 3px solid #f87171; }
  .orch-phase.warn { border-left: 3px solid #fb923c; }
  .orch-phase.info { border-left: 3px solid #60a5fa; }
  .phase-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .phase-dot.pom        { background: #818cf8; }
  .phase-dot.testwriter { background: #c4b5fd; }
  .phase-dot.generate   { background: #818cf8; }
  .phase-dot.execute    { background: #34d399; }
  .phase-dot.analyze    { background: #fbbf24; }
  .phase-dot.fix        { background: #f97316; }
  .phase-dot.done       { background: #4ade80; }
  .phase-dot.exhausted  { background: #f87171; }
  .phase-dot.init       { background: #64748b; }
  .phase-name { font-size: 11px; font-weight: 700; color: #94a3b8; width: 80px; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.04em; }
  .phase-event { font-size: 11px; color: #64748b; flex: 1; font-family: monospace; }
  .phase-dur { font-size: 11px; font-family: monospace; color: #60a5fa; width: 60px; text-align: right; flex-shrink: 0; }
  .phase-tok-in  { font-size: 11px; font-family: monospace; color: #a78bfa; width: 80px; text-align: right; flex-shrink: 0; }
  .phase-tok-out { font-size: 11px; font-family: monospace; color: #e879f9; width: 80px; text-align: right; flex-shrink: 0; }
  .phase-steps { font-size: 11px; color: #64748b; width: 50px; text-align: right; flex-shrink: 0; }
  .orch-col-header { display: flex; align-items: center; gap: 12px; padding: 4px 12px; }
  .orch-col-header span { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #334155; }
  .phase-detail { font-size: 10px; color: #475569; margin-top: 2px; font-family: monospace; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Agent token summary bar */
  .agent-summary { display: flex; gap: 16px; padding: 10px 24px; background: #0f1117; border-bottom: 1px solid #1e2235; flex-wrap: wrap; }

  .timeline { padding: 20px 24px; max-width: 1000px; }
  .step { display: flex; gap: 0; margin-bottom: 4px; }
  .step-line { display: flex; flex-direction: column; align-items: center; width: 32px; flex-shrink: 0; }
  .step-dot { width: 10px; height: 10px; border-radius: 50%; background: #334155; border: 2px solid #475569; flex-shrink: 0; margin-top: 5px; }
  .step-dot.assistant { background: #4f46e5; border-color: #6366f1; }
  .step-dot.user { background: #0f766e; border-color: #14b8a6; }
  .step-connector { width: 2px; background: #1e293b; flex: 1; margin: 2px 0; }
  .step-body { flex: 1; padding-bottom: 12px; }
  .role-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 6px; }
  .role-label.assistant { color: #818cf8; }
  .role-label.user { color: #2dd4bf; }
  .tok-label { font-size: 10px; color: #64748b; margin-left: 8px; font-family: monospace; }
  .text-bubble { background: #1e2235; border: 1px solid #2d3148; border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; color: #94a3b8; font-style: italic; line-height: 1.5; }
  .tool-group { margin-bottom: 4px; }
  .tool-call { display: flex; align-items: flex-start; gap: 8px; background: #1a1d2e; border: 1px solid #2d3148; border-radius: 6px 6px 0 0; padding: 7px 12px; border-bottom: none; }
  .tool-result { background: #141722; border: 1px solid #2d3148; border-radius: 0 0 6px 6px; padding: 7px 12px; }
  .tool-result.ok  { border-top: 2px solid #166534; }
  .tool-result.err { border-top: 2px solid #7f1d1d; }
  .tool-result.warn { border-top: 2px solid #92400e; }
  .tool-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; font-family: monospace; padding: 2px 8px; border-radius: 4px; flex-shrink: 0; }
  .tool-badge.fs        { background: #0c2a4a; color: #60a5fa; border: 1px solid #1e40af; }
  .tool-badge.browse    { background: #2d1a00; color: #fb923c; border: 1px solid #92400e; }
  .tool-badge.browse.repeat { background: #3d0a0a; color: #f87171; border: 1px solid #7f1d1d; }
  .tool-badge.pom       { background: #052e16; color: #4ade80; border: 1px solid #166534; }
  .tool-badge.test      { background: #2e1065; color: #c4b5fd; border: 1px solid #5b21b6; }
  .tool-badge.fixture   { background: #1a1000; color: #fbbf24; border: 1px solid #92400e; }
  .tool-badge.framework { background: #0a2040; color: #93c5fd; border: 1px solid #1d4ed8; }
  .tool-badge.page      { background: #1a0a30; color: #d8b4fe; border: 1px solid #7c3aed; }
  .tool-badge.ast       { background: #1a0030; color: #e879f9; border: 1px solid #7e22ce; }
  .tool-badge.other     { background: #1e2235; color: #94a3b8; border: 1px solid #334155; }
  .repeat-badge { font-size: 10px; background: #7f1d1d; color: #fca5a5; padding: 1px 5px; border-radius: 3px; font-weight: 700; }
  .tool-input { font-family: monospace; font-size: 12px; color: #94a3b8; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .result-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; margin-bottom: 4px; }
  .status-ok   { color: #4ade80; }
  .status-err  { color: #f87171; }
  .status-warn { color: #fb923c; }
  .error-msg { font-family: monospace; font-size: 11px; color: #fca5a5; background: #1c0a0a; padding: 5px 8px; border-radius: 4px; }
  .browse-url   { font-family: monospace; font-size: 12px; color: #fb923c; }
  .browse-title { font-size: 11px; color: #64748b; margin-top: 2px; }
  .file-path  { font-family: monospace; font-size: 11px; color: #60a5fa; }
  .file-lines { font-size: 10px; color: #64748b; }
  .collapsible { margin-top: 5px; }
  .collapsible-toggle { background: #1e2235; border: 1px solid #2d3148; border-radius: 4px; padding: 3px 8px; font-size: 11px; color: #64748b; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
  .collapsible-toggle:hover { border-color: #475569; color: #94a3b8; }
  .collapsible-content { display: none; margin-top: 5px; }
  .collapsible-content.open { display: block; }
  pre { background: #0a0d16; border: 1px solid #1e2235; border-radius: 4px; padding: 8px; font-size: 11px; color: #64748b; overflow-x: auto; max-height: 300px; overflow-y: auto; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
  .write-file { font-family: monospace; font-size: 11px; color: #4ade80; }
  .kv { display: flex; gap: 6px; font-size: 11px; }
  .kv .k { color: #64748b; }
  .kv .v { font-family: monospace; color: #cbd5e1; }
  .task-card  { background: #1a1d2e; border: 1px solid #3730a3; border-radius: 8px; padding: 12px 16px; }
  .task-title { font-size: 14px; font-weight: 600; color: #a5b4fc; margin-bottom: 8px; }
  .task-meta  { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; }
  .task-tag   { background: #1e1b4b; color: #818cf8; padding: 2px 7px; border-radius: 3px; border: 1px solid #3730a3; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; padding: 16px 24px 8px; }
  .divider { border: none; border-top: 1px solid #1e2235; margin: 0 24px; }
  .empty-state { padding: 40px 24px; color: #334155; font-style: italic; text-align: center; }
</style>
</head>
<body>
<div id="app"></div>
<script>
const RUN_DATA = ${data};

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function toolCategory(n) {
  if (!n) return 'other';
  if (n.startsWith('browse.'))     return 'browse';
  if (n.startsWith('fs.'))         return 'fs';
  if (n.startsWith('pom.'))        return 'pom';
  if (n.startsWith('test.'))       return 'test';
  if (n.startsWith('fixture.'))    return 'fixture';
  if (n.startsWith('framework.'))  return 'framework';
  if (n.startsWith('page.'))       return 'page';
  if (n.startsWith('ast.'))        return 'ast';
  return 'other';
}
function toolIcon(n) {
  if (!n) return '⚙';
  if (n === 'fs.read')                return '📄';
  if (n.startsWith('browse.navigate'))return '🌐';
  if (n.startsWith('browse.click'))   return '🖱';
  if (n.startsWith('browse.'))        return '👁';
  if (n.startsWith('pom.create'))     return '🏗';
  if (n.startsWith('pom.'))           return '✏';
  if (n.startsWith('fixture.'))       return '🔌';
  if (n.startsWith('test.'))          return '📝';
  if (n.startsWith('framework.'))     return '🗺';
  if (n.startsWith('page.'))          return '🔍';
  if (n.startsWith('ast.'))           return '📦';
  return '⚙';
}
function inputSummary(n, inp) {
  if (!inp) return '';
  if (n === 'fs.read')              return inp.path || '';
  if (n && n.startsWith('browse.')) return inp.url || inp.element || '';
  if (n === 'pom.createPage')       return inp.file || '';
  if (n === 'pom.updateSelector')   return (inp.file || '') + ' → ' + (inp.name || '');
  if (n === 'pom.addSelector')      return (inp.file || '') + ' → ' + (inp.name || '');
  if (n === 'pom.editMethod')       return (inp.file || '') + ' → ' + (inp.name || '');
  if (n === 'test.addCase')         return inp.title || inp.file || '';
  if (n === 'test.createSpec')      return inp.file || '';
  if (n === 'fixture.addPage')      return inp.className || '';
  if (n === 'ast.addImport')        return inp.file || '';
  if (n === 'page.extractElements') return inp.url || '';
  if (n === 'framework.getGraph')   return '';
  const keys = Object.keys(inp);
  if (!keys.length) return '';
  return (keys[0] + ': ' + JSON.stringify(inp[keys[0]])).slice(0, 80);
}
function resultSummary(n, r) {
  if (!r.ok || !r.output) return null;
  const o = r.output;
  if (n && n.startsWith('browse.')) {
    const t = o.content?.[0]?.text || '';
    const um = t.match(/- Page URL: (.+)/), tm = t.match(/- Page Title: (.+)/);
    return { type:'browse', url: um?.[1]?.trim(), title: tm?.[1]?.trim(), raw: t };
  }
  if (n === 'fs.read')           return { type:'file', path: o.path, lines: o.totalLines, content: o.content };
  if (n === 'page.extractElements') return { type:'extract', url: o.url, count: o.elements?.length };
  if (n === 'framework.getGraph')   return { type:'graph', pages: Object.keys(o.pages||{}).length };
  if (n === 'pom.createPage')    return { type:'write', file: o.file };
  if (n === 'pom.updateSelector')return { type:'write', file: o.file };
  if (n === 'pom.addSelector')   return { type:'write', file: o.file };
  if (n === 'pom.editMethod')    return { type:'write', file: o.file };
  if (['test.createSpec','test.addCase','fixture.addPage','ast.addImport'].includes(n))
    return { type:'write', file: o.file || o.specFile };
  return { type:'raw', data: o };
}
function buildVisitMap(turns) {
  const visits = {}, seen = {}, repeats = new Set();
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    for (const r of (turn.content.toolResults || [])) {
      if (!r.toolName?.startsWith('browse.') || !r.ok) continue;
      const t = r.output?.content?.[0]?.text || '';
      const m = t.match(/- Page URL: (.+)/);
      if (m) visits[r.id] = m[1].trim().split('#')[0];
    }
  }
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    for (const r of (turn.content.toolResults || [])) {
      const url = visits[r.id]; if (!url) continue;
      if (seen[url]) repeats.add(r.id); else seen[url] = true;
    }
  }
  return repeats;
}
function buildSteps(turns) {
  const task = turns[0];
  const byId = {};
  for (const t of turns) if (t.role === 'user') for (const r of (t.content.toolResults||[])) byId[r.id] = r;
  const pairs = [];
  let n = 0;
  for (const t of turns) {
    if (t.role !== 'assistant') continue;
    n++;
    pairs.push({
      stepNum: n,
      text: t.content.text || null,
      usage: t.content.usage || null,
      calls: (t.content.toolCalls||[]).map(c => ({ call:c, result: byId[c.id]||null })),
    });
  }
  return { task, pairs };
}
function computeStats(turns, repeats) {
  let browse=0, rep=0, fs=0, pom=0, err=0, steps=0, inTok=0, outTok=0;
  for (const t of turns) {
    if (t.role==='assistant') {
      if (t.content.toolCalls?.length) steps++;
      inTok  += t.content.usage?.inputTokens  || 0;
      outTok += t.content.usage?.outputTokens || 0;
    }
    if (t.role!=='user') continue;
    for (const r of (t.content.toolResults||[])) {
      if (!r.ok) err++;
      if (r.toolName?.startsWith('browse.')) { browse++; if (repeats.has(r.id)) rep++; }
      if (r.toolName==='fs.read') fs++;
      if (r.toolName?.startsWith('pom.')) pom++;
    }
  }
  return { browse, rep, fs, pom, err, steps, inTok, outTok };
}

function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m > 0 ? m + 'm ' + (s % 60) + 's' : s + 's';
}
function fmtTok(n) {
  if (!n) return '—';
  return n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n);
}

function buildOrchPanel(events) {
  if (!events || events.length === 0) return '';

  const first = new Date(events[0].ts).getTime();
  const last  = new Date(events[events.length - 1].ts).getTime();
  const totalMs = last - first;

  let totalIn = 0, totalOut = 0;
  for (const e of events) {
    const u = e.data?.usage;
    if (u) { totalIn += u.inputTokens || 0; totalOut += u.outputTokens || 0; }
  }

  const rows = [];
  const enterMap = {};
  for (const e of events) {
    const key = e.phase + '_' + e.attempt;
    if (e.event === 'phase.enter') {
      enterMap[key] = e;
    } else if (e.event === 'phase.ok' || e.event === 'phase.error') {
      const enter = enterMap[key];
      const durMs = enter ? new Date(e.ts).getTime() - new Date(enter.ts).getTime() : null;
      const u = e.data?.usage;
      rows.push({
        phase: e.phase, attempt: e.attempt,
        status: e.event === 'phase.ok' ? 'ok' : 'err',
        level: e.level, durMs,
        inTok: u?.inputTokens || 0, outTok: u?.outputTokens || 0,
        steps: e.data?.steps || null,
        detail: e.data ? summarizeData(e.data) : null,
      });
    } else if (!e.event.startsWith('phase.')) {
      rows.push({
        phase: e.phase, attempt: e.attempt,
        status: e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'info',
        level: e.level, durMs: null, inTok: 0, outTok: 0, steps: null,
        detail: e.event + (e.data ? ': ' + summarizeData(e.data) : ''),
        isEvent: true,
      });
    }
  }

  function summarizeData(d) {
    if (!d || typeof d !== 'object') return String(d);
    const parts = [];
    for (const [k, v] of Object.entries(d)) {
      if (k === 'usage') continue;
      parts.push(k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v));
    }
    return parts.slice(0, 4).join('  ');
  }

  let h = '<div class="orch-panel">';
  h += '<div class="orch-header">'
    + '<span class="orch-title">Orchestrator</span>'
    + '<div class="orch-totals">'
    + '<div class="orch-total time"><span class="orch-total-val">' + fmtDur(totalMs) + '</span><span class="orch-total-lbl">total time</span></div>'
    + '<div class="orch-total in"><span class="orch-total-val">' + fmtTok(totalIn) + '</span><span class="orch-total-lbl">in tokens</span></div>'
    + '<div class="orch-total out"><span class="orch-total-val">' + fmtTok(totalOut) + '</span><span class="orch-total-lbl">out tokens</span></div>'
    + '</div></div>';

  h += '<div class="orch-col-header">'
    + '<span style="width:8px"></span>'
    + '<span style="width:80px">phase</span>'
    + '<span style="flex:1">event / detail</span>'
    + '<span style="width:60px;text-align:right">duration</span>'
    + '<span style="width:80px;text-align:right">in tokens</span>'
    + '<span style="width:80px;text-align:right">out tokens</span>'
    + '<span style="width:50px;text-align:right">steps</span>'
    + '</div>';

  h += '<div class="orch-phases">';
  for (const r of rows) {
    h += '<div class="orch-phase ' + r.status + '">'
      + '<div class="phase-dot ' + r.phase + '"></div>'
      + '<div class="phase-name">' + esc(r.phase) + '</div>'
      + '<div class="phase-event">' + esc(r.detail || (r.isEvent ? '' : 'phase.ok')) + '</div>'
      + '<div class="phase-dur">' + (r.durMs != null ? fmtDur(r.durMs) : '') + '</div>'
      + '<div class="phase-tok-in">' + (r.inTok ? fmtTok(r.inTok) : '') + '</div>'
      + '<div class="phase-tok-out">' + (r.outTok ? fmtTok(r.outTok) : '') + '</div>'
      + '<div class="phase-steps">' + (r.steps != null ? r.steps + ' steps' : '') + '</div>'
      + '</div>';
  }
  h += '</div></div>';
  return h;
}

function buildTimeline(turns, label) {
  if (!turns || turns.length === 0) {
    return '<div class="empty-state">No conversation data for ' + esc(label) + '.</div>';
  }
  const repeats = buildVisitMap(turns);
  const { task, pairs } = buildSteps(turns);
  const s = computeStats(turns, repeats);

  let h = '';
  h += '<div class="stats">'
    + '<div class="stat info"><span class="stat-num">' + s.steps + '</span><span class="stat-label">steps</span></div>'
    + '<div class="stat ' + (s.rep>0?'warn':'ok') + '"><span class="stat-num">' + s.browse + '</span><span class="stat-label">browse' + (s.rep>0?' ('+s.rep+' repeat)':'') + '</span></div>'
    + '<div class="stat info"><span class="stat-num">' + s.fs + '</span><span class="stat-label">fs.read</span></div>'
    + '<div class="stat ok"><span class="stat-num">' + s.pom + '</span><span class="stat-label">pom ops</span></div>'
    + '<div class="stat ' + (s.err>0?'err':'ok') + '"><span class="stat-num">' + s.err + '</span><span class="stat-label">errors</span></div>'
    + '<div class="stat tok" style="margin-left:auto"><span class="stat-num">' + fmtTok(s.inTok) + '</span><span class="stat-label">in tokens</span></div>'
    + '<div class="stat tok"><span class="stat-num">' + fmtTok(s.outTok) + '</span><span class="stat-label">out tokens</span></div>'
    + '</div>';

  h += '<div class="timeline">';

  if (task) {
    const tt = task.content.text || '';
    const tm = tt.match(/Title: (.+)/), sm = tt.match(/Locale scope: (.+)/), em = tt.match(/Expected: (.+)/);
    h += '<div class="step"><div class="step-line"><div class="step-dot user"></div><div class="step-connector"></div></div>'
      + '<div class="step-body"><div class="role-label user">task</div>'
      + '<div class="task-card"><div class="task-title">' + esc(tm?.[1] || label + ' task') + '</div><div class="task-meta">'
      + (sm ? '<span class="task-tag">scope: ' + esc(sm[1]) + '</span>' : '')
      + (em ? '<span class="task-tag">expected: ' + esc(em[1].slice(0,70)) + '</span>' : '')
      + '</div></div></div></div>';
  }

  for (const { stepNum, text, usage, calls } of pairs) {
    const tokLabel = usage ? ' <span class="tok-label">in:' + fmtTok(usage.inputTokens) + ' out:' + fmtTok(usage.outputTokens) + '</span>' : '';
    h += '<div class="step"><div class="step-line"><div class="step-dot assistant"></div><div class="step-connector"></div></div>'
      + '<div class="step-body"><div class="role-label assistant">step ' + stepNum + tokLabel + '</div>';
    if (text) h += '<div class="text-bubble">' + esc(text) + '</div>';

    for (const { call, result } of calls) {
      const cat = toolCategory(call.name);
      const isRep = !!(result && repeats.has(result.id));
      h += '<div class="tool-group"><div class="tool-call">'
        + '<span class="tool-badge ' + cat + (isRep?' repeat':'') + '">' + toolIcon(call.name) + ' ' + esc(call.name) + '</span>'
        + (isRep ? '<span class="repeat-badge">REPEAT</span>' : '')
        + '<span class="tool-input">' + esc(inputSummary(call.name, call.input)) + '</span>'
        + '</div>';

      if (result) {
        const sc = !result.ok ? 'err' : isRep ? 'warn' : 'ok';
        h += '<div class="tool-result ' + sc + '">';
        if (!result.ok) {
          h += '<div class="result-status status-err">✗ error</div>'
            + '<div class="error-msg">' + esc(result.error||'unknown') + '</div>';
        } else {
          const rs = resultSummary(call.name, result);
          const cid = 'c_' + call.id;
          if (rs?.type === 'browse') {
            h += '<div class="result-status ' + (isRep?'status-warn':'status-ok') + '">' + (isRep?'⚠ repeated visit':'✓ ok') + '</div>'
              + '<div class="browse-url">' + esc(rs.url||'') + '</div>'
              + '<div class="browse-title">' + esc(rs.title||'') + '</div>';
            if (rs.raw) h += '<div class="collapsible"><button class="collapsible-toggle" onclick="tog(\\''+cid+'\\')">▶ snapshot</button>'
              + '<div class="collapsible-content" id="'+cid+'"><pre>'+esc(rs.raw)+'</pre></div></div>';
          } else if (rs?.type === 'file') {
            h += '<div class="result-status status-ok">✓ ok</div>'
              + '<div class="file-path">' + esc(rs.path||'') + '</div>'
              + '<div class="file-lines">' + (rs.lines||'') + ' lines</div>';
            if (rs.content) h += '<div class="collapsible"><button class="collapsible-toggle" onclick="tog(\\''+cid+'\\')">▶ content</button>'
              + '<div class="collapsible-content" id="'+cid+'"><pre>'+esc(rs.content)+'</pre></div></div>';
          } else if (rs?.type === 'extract') {
            h += '<div class="result-status status-ok">✓ ' + (rs.count||0) + ' elements</div>'
              + '<div class="browse-url">' + esc(rs.url||'') + '</div>';
          } else if (rs?.type === 'graph') {
            h += '<div class="result-status status-ok">✓ ' + rs.pages + ' pages in graph</div>';
          } else if (rs?.type === 'write') {
            h += '<div class="result-status status-ok">✓ ok</div>';
            if (rs.file) h += '<div class="kv"><span class="k">file</span><span class="v write-file">'+esc(rs.file)+'</span></div>';
          } else if (rs?.type === 'raw') {
            h += '<div class="result-status status-ok">✓ ok</div>'
              + '<div class="collapsible"><button class="collapsible-toggle" onclick="tog(\\''+cid+'\\')">▶ output</button>'
              + '<div class="collapsible-content" id="'+cid+'"><pre>'+esc(JSON.stringify(rs.data,null,2))+'</pre></div></div>';
          } else {
            h += '<div class="result-status status-ok">✓ ok</div>';
          }
        }
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div></div>';
  }
  h += '</div>';
  return h;
}

function render() {
  const { meta, turns, logEvents, agents } = RUN_DATA;
  const started = new Date(meta.startedAt).toLocaleString();

  const hasPom = !!(agents?.pom?.turns?.length);
  const hasTw  = !!(agents?.testwriter?.turns?.length);
  const hasFix = !!(turns?.length);

  let h = '';

  // Header
  h += '<div class="header"><h1>' + esc(meta.task) + '</h1><div class="meta">'
    + '<div class="meta-item"><span class="meta-label">Run ID</span><span class="meta-value">' + esc(meta.id) + '</span></div>'
    + '<div class="meta-item"><span class="meta-label">Model</span><span class="meta-value">' + esc(meta.model) + '</span></div>'
    + '<div class="meta-item"><span class="meta-label">Started</span><span class="meta-value">' + esc(started) + '</span></div>'
    + '<div class="meta-item"><span class="meta-label">Repo</span><span class="meta-value">' + esc(meta.repoRoot) + '</span></div>'
    + '</div></div>';

  // Tabs
  h += '<div class="tabs">'
    + '<div class="tab active" onclick="switchTab(\\'orch\\', this)">Orchestrator</div>'
    + '<div class="tab' + (hasPom ? '' : ' disabled') + '" onclick="' + (hasPom ? "switchTab('pom', this)" : '') + '">POM Agent</div>'
    + '<div class="tab' + (hasTw  ? '' : ' disabled') + '" onclick="' + (hasTw  ? "switchTab('tw', this)"  : '') + '">Test Writer</div>'
    + '<div class="tab' + (hasFix ? '' : ' disabled') + '" onclick="' + (hasFix ? "switchTab('fix', this)" : '') + '">Fix Agent</div>'
    + '</div>';

  // Orchestrator tab
  h += '<div class="tab-panel active" id="panel-orch">';
  if (logEvents && logEvents.length > 0) h += buildOrchPanel(logEvents);
  else h += '<div class="empty-state">No orchestrator log data.</div>';
  h += '</div>';

  // POM Agent tab
  h += '<div class="tab-panel" id="panel-pom">';
  h += buildTimeline(agents?.pom?.turns, 'POM Agent');
  h += '</div>';

  // Test Writer tab
  h += '<div class="tab-panel" id="panel-tw">';
  h += buildTimeline(agents?.testwriter?.turns, 'Test Writer');
  h += '</div>';

  // Fix Agent tab
  h += '<div class="tab-panel" id="panel-fix">';
  h += buildTimeline(turns, 'Fix Agent');
  h += '</div>';

  document.getElementById('app').innerHTML = h;
}

function switchTab(id, el) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  el.classList.add('active');
}
function tog(id) {
  const el = document.getElementById(id), btn = el.previousElementSibling;
  el.classList.toggle('open');
  btn.textContent = (el.classList.contains('open') ? '▼' : '▶') + btn.textContent.slice(1);
}
render();
</script>
</body>
</html>`;
}

function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}
