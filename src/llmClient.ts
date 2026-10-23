import * as vscode from 'vscode';
import { jsonrepair } from 'jsonrepair';
import { HarvestedContext, CallerInfo, CalleeInfo } from './contextHarvester';

export interface AnalysisNode {
  id: string; // e.g., "N1", "N2"
  label: string;
  startLine: number;
  endLine: number;
  explanation: string;
}

export interface AnalysisEdge {
  from: string; // source node id
  to: string;   // target node id
  guardLabel?: string; // condition, transition, or call label
}

export interface WhatIfTrace {
  title: string;
  triggerInput: string;
  pathNodeIds: string[]; // e.g. ["N1", "N2", "N4"]
  potentialBlindSpot: string;
  targetLines: [number, number]; // [startLine, endLine]
}

export interface StructuredAnalysis {
  summary: [string, string, string]; // exactly 3 bullet points
  diagramType: 'flowchart TD' | 'stateDiagram-v2' | 'sequenceDiagram';
  nodes: AnalysisNode[];
  edges: AnalysisEdge[];
  whatIfTraces: [WhatIfTrace, WhatIfTrace, WhatIfTrace];
  primaryCallers: CallerInfo[];
  allCallers: CallerInfo[];
  selectedCallees: CalleeInfo[];
  otherParentCallees: CalleeInfo[];
  allCallees: CalleeInfo[];
}

export interface AnalysisResult extends StructuredAnalysis {
  enclosingFunctionName?: string;
  enclosingStartLine?: number;
  enclosingEndLine?: number;
  isPartialSelection: boolean;
  mermaidSource: string;
}

/**
 * Sanitizes a label string for safe insertion into Mermaid syntax.
 */
export function sanitizeMermaidLabel(raw: string): string {
  if (!raw) return 'Step';
  return raw
    .replace(/"/g, "'")
    .replace(/[\[\]\(\)\{\}]/g, ' ')
    .replace(/<[^>]*>/g, '') // remove HTML tags
    .replace(/[;:#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Deterministically compiles LLM nodes and edges into crash-proof Mermaid syntax.
 */
export function compileDeterministicMermaid(
  diagramType: 'flowchart TD' | 'stateDiagram-v2' | 'sequenceDiagram',
  nodes: AnalysisNode[],
  edges: AnalysisEdge[]
): string {
  const lines: string[] = [];

  const safeId = (id: string, idx: number) => {
    const cleaned = (id || `N${idx + 1}`).replace(/[^a-zA-Z0-9_]/g, '');
    return cleaned.length > 0 ? cleaned : `N${idx + 1}`;
  };

  const idMap = new Map<string, string>();
  nodes.forEach((n, idx) => {
    idMap.set(n.id, safeId(n.id, idx));
  });

  // Ensure edges reference valid nodes; if no valid edges exist for multi-node flow, chain sequentially
  const validNodeIds = new Set(Array.from(idMap.values()));
  let resolvedEdges: { from: string; to: string; guardLabel?: string }[] = [];

  for (const edge of edges) {
    const from = idMap.get(edge.from) || edge.from.replace(/[^a-zA-Z0-9_]/g, '');
    const to = idMap.get(edge.to) || edge.to.replace(/[^a-zA-Z0-9_]/g, '');
    if (validNodeIds.has(from) && validNodeIds.has(to) && from !== to) {
      resolvedEdges.push({ from, to, guardLabel: edge.guardLabel });
    }
  }

  if (resolvedEdges.length === 0 && nodes.length > 1) {
    for (let i = 0; i < nodes.length - 1; i++) {
      const from = idMap.get(nodes[i].id) || `N${i + 1}`;
      const to = idMap.get(nodes[i + 1].id) || `N${i + 2}`;
      resolvedEdges.push({ from, to });
    }
  }

  if (diagramType === 'stateDiagram-v2') {
    lines.push('stateDiagram-v2');
    nodes.forEach((node, idx) => {
      const nid = idMap.get(node.id) || `N${idx + 1}`;
      const label = sanitizeMermaidLabel(node.label);
      lines.push(`    state "${label}" as ${nid}`);
    });
    resolvedEdges.forEach((edge) => {
      const guard = edge.guardLabel ? ` : ${sanitizeMermaidLabel(edge.guardLabel)}` : '';
      lines.push(`    ${edge.from} --> ${edge.to}${guard}`);
    });
  } else if (diagramType === 'sequenceDiagram') {
    lines.push('sequenceDiagram');
    lines.push('    autonumber');
    nodes.forEach((node, idx) => {
      const nid = idMap.get(node.id) || `N${idx + 1}`;
      const label = sanitizeMermaidLabel(node.label);
      lines.push(`    participant ${nid} as ${label}`);
    });
    resolvedEdges.forEach((edge) => {
      const guard = sanitizeMermaidLabel(edge.guardLabel || 'step');
      lines.push(`    ${edge.from}->>${edge.to}: ${guard}`);
    });
  } else {
    // Default: flowchart TD
    lines.push('flowchart TD');
    nodes.forEach((node, idx) => {
      const nid = idMap.get(node.id) || `N${idx + 1}`;
      const label = sanitizeMermaidLabel(node.label);
      lines.push(`    ${nid}["${label}"]`);
    });
    resolvedEdges.forEach((edge) => {
      if (edge.guardLabel && edge.guardLabel.trim().length > 0) {
        const guard = sanitizeMermaidLabel(edge.guardLabel);
        lines.push(`    ${edge.from} -->|"${guard}"| ${edge.to}`);
      } else {
        lines.push(`    ${edge.from} --> ${edge.to}`);
      }
    });
  }

  return lines.join('\n');
}

/**
 * Automatically discovers active local Ollama models if available.
 */
async function resolveOllamaModel(configuredModel: string, endpoint: string): Promise<string> {
  if (configuredModel && configuredModel !== 'llama3' && configuredModel !== 'default') {
    return configuredModel;
  }

  try {
    const url = new URL(endpoint);
    const tagsUrl = `${url.protocol}//${url.host}/api/tags`;
    const res = await fetch(tagsUrl, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json() as any;
      const models = data?.models || [];
      if (models.length > 0) {
        const found = models.find((m: any) => m.name.includes('gemma4') || m.name.includes('qwen') || m.name.includes('llama'));
        return found ? found.name : models[0].name;
      }
    }
  } catch {
    // Fall back to configured model
  }
  return configuredModel || 'gemma4:latest';
}

/**
 * Queries the configured LLM endpoint and returns structured code comprehension + deterministic Mermaid diagram.
 */
export async function analyzeSelectionWithLLM(
  context: HarvestedContext,
  token?: vscode.CancellationToken
): Promise<AnalysisResult> {
  const config = vscode.workspace.getConfiguration('codemist');
  const endpoint = config.get<string>('apiEndpoint', 'http://localhost:11434/v1/chat/completions');
  const apiKey = config.get<string>('apiKey', '');
  const rawModelName = config.get<string>('modelName', 'gemma4:latest');

  const modelName = await resolveOllamaModel(rawModelName, endpoint);

  // Format candidate production callers for LLM selection
  const candidateCallersStr = context.candidateProductionCallers.map((c, i) =>
    `${i + 1}. "${c.name}" (at line ${c.line}, call sites: ${c.callSiteCount}): "${c.callSiteSnippet || c.name}"`
  ).join('\n') || 'None detected';

  const selectedCalleesStr = context.selectedCallees.map(c =>
    `- "${c.name}" (invoked at lines: ${c.calledFromLines.join(', ')})`
  ).join('\n') || 'None detected';

  const midLine1 = Math.min(context.endLine, context.startLine + Math.max(1, Math.floor((context.endLine - context.startLine) * 0.3)));
  const midLine2 = Math.min(context.endLine, context.startLine + Math.max(2, Math.floor((context.endLine - context.startLine) * 0.65)));

  const systemPrompt = `You are CodeMist, a visual code comprehension engine.
CRITICAL CONSTRAINT: You must ONLY explain, diagram, and trace the user's SELECTED lines (from line ${context.startLine} to line ${context.endLine}).
${context.isPartialSelection ? `The user highlighted a sub-block inside parent function "${context.enclosingFunctionName}". Focus strictly on the highlighted lines.` : ''}

RULES:
1. Return ONLY a single raw valid JSON object.
2. ALWAYS use standard double quotes (") for all keys and strings. Never use single quotes (').
3. Keep descriptions concise (under 15 words per bullet or explanation).
4. INTERNAL FUNCTIONAL FLOW (CRITICAL): NEVER collapse the code into a single node! You MUST break the selected code down into 4 to 7 granular internal control-flow nodes representing its internal steps:
   - Entry / variable initialization
   - Every conditional check (if / else if / switch) as its own node with outgoing "Yes" and "No" guardLabel edges
   - Loop bodies (for / while / foreach)
   - Downstream function/method calls and state mutations
   - Return / throw / output paths
   Each node MUST have narrow, specific startLine and endLine numbers between ${context.startLine} and ${context.endLine}.
5. Upstream Callers: From the "Candidate Upstream Callers" provided, pick the Top 3 to 5 most architecturally distinct callers. Assign each:
   - "flowTag": choose from "Hot Path", "Init", "Callback", "Error/Retry", "Handler", or "Worker"
   - "roleHint": concise trigger explanation (under 8 words).
   Return these under "primaryCallers".
6. Downstream Callees: For each callee in "Selected Callees", assign:
   - "roleHint": concise intent (under 8 words)
   - "nodeId": tag it with the exact Mermaid step id (e.g. "N2", "N3") where it is invoked.

Schema:
{
  "summary": [
    "First crisp bullet point explaining the selected code's primary purpose",
    "Second crisp bullet point explaining internal branches, calls, or state changes",
    "Third crisp bullet point explaining the return value or side effects"
  ],
  "diagramType": "flowchart TD",
  "nodes": [
    {
      "id": "N1",
      "label": "Initialize inputs & state",
      "startLine": ${context.startLine},
      "endLine": ${midLine1},
      "explanation": "Sets up initial variables and validates parameters"
    },
    {
      "id": "N2",
      "label": "Check branch condition",
      "startLine": ${midLine1},
      "endLine": ${midLine2},
      "explanation": "Evaluates guard or branching condition"
    },
    {
      "id": "N3",
      "label": "Execute core operation / call",
      "startLine": ${midLine2},
      "endLine": ${context.endLine},
      "explanation": "Invokes downstream logic and computes result"
    },
    {
      "id": "N4",
      "label": "Return final result",
      "startLine": ${context.endLine},
      "endLine": ${context.endLine},
      "explanation": "Returns computed output to caller"
    }
  ],
  "edges": [
    {
      "from": "N1",
      "to": "N2"
    },
    {
      "from": "N2",
      "to": "N3",
      "guardLabel": "Yes"
    },
    {
      "from": "N2",
      "to": "N4",
      "guardLabel": "No"
    },
    {
      "from": "N3",
      "to": "N4"
    }
  ],
  "whatIfTraces": [
    {
      "title": "Edge Case Name",
      "triggerInput": "Concrete input value",
      "pathNodeIds": ["N1", "N2", "N3", "N4"],
      "potentialBlindSpot": "Brief risk description",
      "targetLines": [${context.startLine}, ${context.endLine}]
    }
  ],
  "primaryCallers": [
    {
      "name": "callerName",
      "flowTag": "Hot Path",
      "roleHint": "role hint under 8 words"
    }
  ],
  "selectedCallees": [
    {
      "name": "calleeName",
      "roleHint": "role hint under 8 words",
      "nodeId": "N3"
    }
  ]
}`;

  const userPrompt = `Enclosing Function: ${context.enclosingFunctionName || 'Anonymous'} (Lines ${context.enclosingStartLine || context.startLine}-${context.enclosingEndLine || context.endLine})
User's Highlighted Lines (${context.languageId}, Lines ${context.startLine} - ${context.endLine}):
\`\`\`${context.languageId}
${context.selectedCodeNumbered}
\`\`\`

Candidate Upstream Callers (Ranked by Architecture Score):
${candidateCallersStr}

Selected Callees (Invoked inside highlighted lines):
${selectedCalleesStr}

${context.backgroundContext ? `Background Scope Context:\n${context.backgroundContext}` : ''}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey && apiKey.trim().length > 0) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const requestBody: Record<string, unknown> = {
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
    options: {
      num_predict: 2048,
      temperature: 0.1
    }
  };

  let responseText = '';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!res.ok) {
      if (res.status === 400) {
        delete requestBody.response_format;
        const retryRes = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody)
        });
        if (!retryRes.ok) {
          const errBody = await retryRes.text();
          throw new Error(`LLM endpoint returned HTTP ${retryRes.status}: ${errBody}`);
        }
        const data = await retryRes.json() as any;
        responseText = data?.choices?.[0]?.message?.content || '';
      } else {
        const errBody = await res.text();
        throw new Error(`LLM endpoint returned HTTP ${res.status}: ${errBody}`);
      }
    } else {
      const data = await res.json() as any;
      responseText = data?.choices?.[0]?.message?.content || '';
    }
  } catch (err: any) {
    throw new Error(`Failed to query LLM endpoint (${modelName}) at "${endpoint}": ${err?.message || err}`);
  }

  // Parse structured JSON with multi-pass resilience
  const parsed = parseLLMJsonResponse(responseText, context);

  // Compile deterministic Mermaid diagram
  const mermaidSource = compileDeterministicMermaid(parsed.diagramType, parsed.nodes, parsed.edges);

  return {
    ...parsed,
    enclosingFunctionName: context.enclosingFunctionName,
    enclosingStartLine: context.enclosingStartLine,
    enclosingEndLine: context.enclosingEndLine,
    isPartialSelection: context.isPartialSelection,
    mermaidSource
  };
}

/**
 * Closes unclosed quotes, brackets, and braces if the JSON was cut off mid-stream.
 */
function repairTruncatedJson(text: string): string {
  let cleaned = text.trim();
  const startIdx = cleaned.indexOf('{');
  if (startIdx === -1) return cleaned;
  cleaned = cleaned.substring(startIdx);

  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const expected = ch === '}' ? '{' : '[';
        if (stack.length > 0 && stack[stack.length - 1] === expected) {
          stack.pop();
        }
      }
    }
  }

  if (inString) {
    cleaned += '"';
  }

  cleaned = cleaned.replace(/[,:]\s*$/, '');

  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') cleaned += '}';
    else if (open === '[') cleaned += ']';
  }

  return cleaned;
}

/**
 * Multi-pass resilient JSON parser that repairs single quotes, unquoted keys,
 * trailing commas, Python objects, and truncated JSON.
 */
function resilientJsonParse(raw: string): any {
  let text = raw.trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Pass 1: Direct JSON parse
  try {
    return JSON.parse(text);
  } catch {}

  // Pass 2: Extract JSON substring between outer braces
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    } catch {}
  }

  // Pass 2.5: Use jsonrepair library for malformed/truncated JSON
  try {
    const sub = firstBrace !== -1 ? text.substring(firstBrace) : text;
    return JSON.parse(jsonrepair(sub));
  } catch {}

  // Pass 3: Repair single quotes, unquoted keys, and trailing commas
  try {
    let repaired = text
      .replace(/'((?:\\.|[^'\\])*)'/g, (_, inner) => {
        const safe = inner.replace(/"/g, '\\"');
        return `"${safe}"`;
      })
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/:\s*True\b/g, ': true')
      .replace(/:\s*False\b/g, ': false')
      .replace(/:\s*None\b/g, ': null');

    return JSON.parse(repaired);
  } catch {}

  // Pass 4: Auto-close truncated JSON structure
  try {
    const closed = repairTruncatedJson(text);
    return JSON.parse(closed);
  } catch {}

  // Pass 5: Auto-close + quote repair combined
  try {
    let combined = text
      .replace(/'((?:\\.|[^'\\])*)'/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`)
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');
    const closed = repairTruncatedJson(combined);
    return JSON.parse(closed);
  } catch {}

  return fallbackRegexExtraction(text);
}

function fallbackRegexExtraction(text: string): any {
  const summaryMatches = [...text.matchAll(/"summary"\s*:\s*\[([\s\S]*?)\]/g)];
  let summary: string[] = [];
  if (summaryMatches.length > 0) {
    summary = [...summaryMatches[0][1].matchAll(/["']([^"']+)["']/g)].map(m => m[1]);
  } else {
    const singleSummaryMatch = text.match(/"summary"\s*:\s*["']([^"']+)["']/);
    if (singleSummaryMatch) {
      summary = [singleSummaryMatch[1]];
    }
  }

  const nodesMatches = [...text.matchAll(/\{\s*["']id["']\s*:\s*["']([^"']+)["'][\s\S]*?["']label["']\s*:\s*["']([^"']+)["']/g)];
  const nodes = nodesMatches.map(m => ({
    id: m[1],
    label: m[2],
    startLine: 1,
    endLine: 1,
    explanation: m[2]
  }));

  return {
    summary: summary.length > 0 ? summary.slice(0, 3) : undefined,
    nodes: nodes.length > 0 ? nodes : undefined,
    edges: [],
    whatIfTraces: []
  };
}

/**
 * Safely normalizes the summary field whether the LLM returned an array, a single string, or an object.
 */
function normalizeSummary(rawSummary: any): [string, string, string] {
  const defaults: [string, string, string] = [
    'Executes operations within selected lines.',
    'Processes variables and evaluates conditions.',
    'Yields result or finishes block execution.'
  ];

  let items: string[] = [];

  if (Array.isArray(rawSummary)) {
    items = rawSummary
      .map(s => (typeof s === 'string' ? s : (s?.text || s?.bullet || s?.point || s?.description || '')))
      .map(s => String(s).replace(/^[-•*\d.)\s]+/, '').trim())
      .filter(s => s.length > 1);
  } else if (typeof rawSummary === 'string' && rawSummary.trim().length > 0) {
    // Split string by newlines, bullet points, or sentence boundaries (never character-by-character!)
    const byLines = rawSummary
      .split(/\r?\n|(?:^|\s)[•*-]\s+|\d+\.\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 1);

    if (byLines.length >= 2) {
      items = byLines;
    } else {
      const bySentences = rawSummary
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 1);
      items = bySentences.length > 0 ? bySentences : [rawSummary.trim()];
    }
  } else if (rawSummary && typeof rawSummary === 'object') {
    items = Object.values(rawSummary)
      .map(v => String(v).trim())
      .filter(s => s.length > 1);
  }

  return [
    items[0] || defaults[0],
    items[1] || defaults[1],
    items[2] || defaults[2]
  ];
}

/**
 * Deterministically decomposes numbered source lines into internal control-flow nodes and edges
 * whenever the LLM returns <= 1 node for a multi-statement function/block.
 */
function buildInternalFlowFromCode(context: HarvestedContext): { nodes: AnalysisNode[]; edges: AnalysisEdge[] } {
  const rawLines = context.selectedCodeNumbered.split(/\r?\n/);
  const parsedLines: { lineNum: number; code: string }[] = [];

  for (const rl of rawLines) {
    const m = rl.match(/^\[L(\d+)\]:\s*(.*)$/);
    if (m) {
      const lineNum = Number(m[1]);
      const code = m[2].trim();
      // Skip blank lines, standalone braces, and pure comment lines
      if (!code || /^[{}()[\];]+$/.test(code) || /^(\/\/|#|\/\*|\*)/.test(code)) {
        continue;
      }
      parsedLines.push({ lineNum, code });
    }
  }

  if (parsedLines.length === 0) {
    return {
      nodes: [{
        id: 'N1',
        label: context.enclosingFunctionName || 'Selected Block',
        startLine: context.startLine,
        endLine: context.endLine,
        explanation: 'Selected execution block'
      }],
      edges: []
    };
  }

  interface StepItem {
    id: string;
    kind: 'entry' | 'branch' | 'else' | 'loop' | 'try' | 'catch' | 'return' | 'action';
    label: string;
    startLine: number;
    endLine: number;
    explanation: string;
  }

  const steps: StepItem[] = [];
  let idx = 0;

  const summarizeStmt = (stmt: string): string => {
    const cleaned = stmt.replace(/[{};]+$/g, '').trim();
    return cleaned.length > 52 ? cleaned.slice(0, 49) + '...' : cleaned;
  };

  for (let i = 0; i < parsedLines.length; i++) {
    const { lineNum, code } = parsedLines[i];

    // 1. Function signature / entry
    if (i === 0 && /(?:function|def|fn|func|public|private|protected|internal|static|async|void|int|string|bool)\b/.test(code) && code.includes('(')) {
      idx++;
      steps.push({
        id: `N${idx}`,
        kind: 'entry',
        label: `Enter ${context.enclosingFunctionName || 'Function'}`,
        startLine: lineNum,
        endLine: lineNum,
        explanation: summarizeStmt(code)
      });
      continue;
    }

    // 2. Conditional branch (if / else if / switch / case)
    const branchMatch = code.match(/^(?:}\s*)?(else\s+if|elif|if|switch|case)\b\s*(.*)$/);
    if (branchMatch) {
      idx++;
      const kw = branchMatch[1].replace(/\s+/g, ' ');
      const cond = summarizeStmt(branchMatch[2] || code);
      steps.push({
        id: `N${idx}`,
        kind: 'branch',
        label: `${kw}: ${cond}`,
        startLine: lineNum,
        endLine: lineNum,
        explanation: `Evaluates condition ${cond}`
      });
      continue;
    }

    // 3. Else branch
    if (/^(?:}\s*)?else\b/.test(code)) {
      idx++;
      const rest = summarizeStmt(code.replace(/^(?:}\s*)?else\b\s*/, ''));
      steps.push({
        id: `N${idx}`,
        kind: 'else',
        label: rest ? `Else: ${rest}` : 'Else branch',
        startLine: lineNum,
        endLine: lineNum,
        explanation: 'Fallback branch when condition is false'
      });
      continue;
    }

    // 4. Loop (for / while / foreach)
    const loopMatch = code.match(/^(for\s*each|foreach|for|while)\b\s*(.*)$/);
    if (loopMatch) {
      idx++;
      const cond = summarizeStmt(loopMatch[2] || code);
      steps.push({
        id: `N${idx}`,
        kind: 'loop',
        label: `Loop: ${cond}`,
        startLine: lineNum,
        endLine: lineNum,
        explanation: `Iterates while ${cond}`
      });
      continue;
    }

    // 5. Try / Catch
    if (/^(?:}\s*)?catch\b/.test(code)) {
      idx++;
      steps.push({
        id: `N${idx}`,
        kind: 'catch',
        label: summarizeStmt(code),
        startLine: lineNum,
        endLine: lineNum,
        explanation: 'Handles exception in catch block'
      });
      continue;
    }

    // 6. Return / Throw
    if (/^(return|throw)\b/.test(code)) {
      idx++;
      steps.push({
        id: `N${idx}`,
        kind: 'return',
        label: summarizeStmt(code),
        startLine: lineNum,
        endLine: lineNum,
        explanation: `Exits with: ${summarizeStmt(code)}`
      });
      continue;
    }

    // 7. Action / Call / Assignment: merge consecutive simple action lines if we already have many steps
    const prev = steps[steps.length - 1];
    const hasCalleeCall = context.selectedCallees.some(c => c.calledFromLines.includes(lineNum));
    if (prev && prev.kind === 'action' && !hasCalleeCall && steps.length >= 5) {
      prev.endLine = lineNum;
    } else {
      idx++;
      steps.push({
        id: `N${idx}`,
        kind: 'action',
        label: summarizeStmt(code),
        startLine: lineNum,
        endLine: lineNum,
        explanation: summarizeStmt(code)
      });
    }
  }

  // Cap at 8 nodes for visual clarity by merging adjacent action nodes if needed
  while (steps.length > 8) {
    const mergeIdx = steps.findIndex((s, i) => i > 0 && s.kind === 'action' && steps[i - 1].kind === 'action');
    if (mergeIdx !== -1) {
      steps[mergeIdx - 1].endLine = steps[mergeIdx].endLine;
      steps.splice(mergeIdx, 1);
    } else {
      break;
    }
  }

  // Re-number IDs N1..Nk
  steps.forEach((s, i) => {
    s.id = `N${i + 1}`;
  });

  // Build control-flow edges (including branch Yes/No paths)
  const edges: AnalysisEdge[] = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const curr = steps[i];
    const next = steps[i + 1];

    if (curr.kind === 'branch') {
      edges.push({ from: curr.id, to: next.id, guardLabel: 'Yes' });
      // Find corresponding 'else' or join node for the 'No' path
      const elseIdx = steps.findIndex((s, j) => j > i + 1 && (s.kind === 'else' || s.kind === 'branch' || s.kind === 'return'));
      if (elseIdx !== -1) {
        edges.push({ from: curr.id, to: steps[elseIdx].id, guardLabel: 'No' });
      }
    } else if (curr.kind === 'return') {
      // Return exits; only link if no incoming edge exists on next
      const nextHasIncoming = edges.some(e => e.to === next.id);
      if (!nextHasIncoming) {
        edges.push({ from: curr.id, to: next.id });
      }
    } else {
      edges.push({ from: curr.id, to: next.id });
    }
  }

  return {
    nodes: steps.map(s => ({
      id: s.id,
      label: s.label,
      startLine: s.startLine,
      endLine: s.endLine,
      explanation: s.explanation
    })),
    edges
  };
}

/**
 * Extracts and cleans JSON from LLM output, with ranking funnel resolution and un-truncated collections.
 */
function parseLLMJsonResponse(raw: string, context: HarvestedContext): StructuredAnalysis {
  const parsed = resilientJsonParse(raw) || {};

  const summary = normalizeSummary(parsed.summary);

  const validTypes = ['flowchart TD', 'stateDiagram-v2', 'sequenceDiagram'] as const;
  const diagramType = validTypes.includes(parsed.diagramType) ? parsed.diagramType : 'flowchart TD';

  const rawNodesList = Array.isArray(parsed.nodes)
    ? parsed.nodes
    : (Array.isArray(parsed.steps) ? parsed.steps : (Array.isArray(parsed.blocks) ? parsed.blocks : []));

  let nodes: AnalysisNode[] = rawNodesList.map((n: any, idx: number) => ({
    id: String(n.id || `N${idx + 1}`),
    label: String(n.label || n.title || n.name || `Step ${idx + 1}`),
    startLine: Number(n.startLine || n.line) || context.startLine,
    endLine: Number(n.endLine || n.startLine || n.line) || context.endLine,
    explanation: String(n.explanation || n.description || n.label || '')
  }));

  let edges: AnalysisEdge[] = (Array.isArray(parsed.edges) ? parsed.edges : []).map((e: any) => ({
    from: String(e.from || e.source || 'N1'),
    to: String(e.to || e.target || 'N2'),
    guardLabel: e.guardLabel || e.label || e.explanation || e.guard ? String(e.guardLabel || e.label || e.explanation || e.guard) : undefined
  }));

  // If the LLM collapsed a multi-statement block into <= 1 node, use deterministic internal control-flow decomposition
  if (nodes.length <= 1) {
    const internalFlow = buildInternalFlowFromCode(context);
    if (internalFlow.nodes.length > nodes.length) {
      nodes = internalFlow.nodes;
      edges = internalFlow.edges;
    } else if (nodes.length === 0) {
      nodes = internalFlow.nodes;
      edges = internalFlow.edges;
    }
  }

  const rawTraces = Array.isArray(parsed.whatIfTraces) ? parsed.whatIfTraces : [];
  const whatIfTraces: [WhatIfTrace, WhatIfTrace, WhatIfTrace] = [
    sanitizeTrace(rawTraces[0], 1, context, nodes),
    sanitizeTrace(rawTraces[1], 2, context, nodes),
    sanitizeTrace(rawTraces[2], 3, context, nodes)
  ];

  // 1. Process Primary Callers (Top 3-5 selected by LLM)
  const candidatePool = [...context.candidateProductionCallers];
  const llmPrimary = Array.isArray(parsed.primaryCallers) ? parsed.primaryCallers : [];
  const primaryCallers: CallerInfo[] = [];
  const selectedCallerNames = new Set<string>();

  for (const item of llmPrimary) {
    if (!item?.name) continue;
    const match = candidatePool.find(c => c.name.toLowerCase() === String(item.name).toLowerCase());
    if (match && !selectedCallerNames.has(match.name)) {
      selectedCallerNames.add(match.name);
      primaryCallers.push({
        ...match,
        flowTag: item.flowTag ? String(item.flowTag).slice(0, 20) : 'Hot Path',
        roleHint: item.roleHint ? String(item.roleHint).slice(0, 60) : 'Primary caller'
      });
    }
  }

  // Backfill if LLM picked fewer than 3
  for (const c of candidatePool) {
    if (primaryCallers.length >= 3 || primaryCallers.length >= candidatePool.length) break;
    if (!selectedCallerNames.has(c.name)) {
      selectedCallerNames.add(c.name);
      primaryCallers.push({
        ...c,
        flowTag: 'Hot Path',
        roleHint: 'Triggers execution'
      });
    }
  }

  // Enrich context.allCallers with any assigned flowTags & roleHints from primaryCallers
  const allCallers = context.allCallers.map(c => {
    const matchedPrimary = primaryCallers.find(p => p.filePath.toLowerCase() === c.filePath.toLowerCase() && p.name.toLowerCase() === c.name.toLowerCase());
    if (matchedPrimary) {
      return {
        ...c,
        flowTag: matchedPrimary.flowTag,
        roleHint: matchedPrimary.roleHint
      };
    }
    return c;
  });

  // 2. Process Selected Callees & Tag Node IDs
  const llmCallees = Array.isArray(parsed.selectedCallees || parsed.callees) ? (parsed.selectedCallees || parsed.callees) : [];
  const selectedCallees: CalleeInfo[] = context.selectedCallees.map(c => {
    const match = llmCallees.find((lc: any) => lc.name && lc.name.toLowerCase() === c.name.toLowerCase());
    const fallbackNode = nodes.find(n => c.calledFromLines.some(l => l >= n.startLine && l <= n.endLine));
    return {
      ...c,
      roleHint: match?.roleHint ? String(match.roleHint).slice(0, 60) : 'Invoked helper method',
      nodeId: match?.nodeId ? String(match.nodeId) : (fallbackNode?.id || nodes[0]?.id || 'N1')
    };
  });

  const otherParentCallees = [...context.otherParentCallees];
  const allCallees = [...context.allCallees];

  return {
    summary,
    diagramType,
    nodes,
    edges,
    whatIfTraces,
    primaryCallers,
    allCallers,
    selectedCallees,
    otherParentCallees,
    allCallees
  };
}

function sanitizeTrace(raw: any, index: number, context: HarvestedContext, nodes: AnalysisNode[]): WhatIfTrace {
  const defaultNodeIds = nodes.map(n => n.id);

  let targetStart = context.startLine;
  let targetEnd = context.endLine;
  if (Array.isArray(raw?.targetLines) && raw.targetLines.length > 0) {
    targetStart = Number(raw.targetLines[0]) || context.startLine;
    targetEnd = raw.targetLines.length > 1 ? (Number(raw.targetLines[1]) || targetStart) : targetStart;
  }

  return {
    title: raw?.title ? String(raw.title) : `Edge Case Scenario #${index}`,
    triggerInput: raw?.triggerInput ? String(raw.triggerInput) : 'Boundary / Unexpected input',
    pathNodeIds: Array.isArray(raw?.pathNodeIds) && raw.pathNodeIds.length > 0 ? raw.pathNodeIds.map(String) : defaultNodeIds,
    potentialBlindSpot: raw?.potentialBlindSpot ? String(raw.potentialBlindSpot) : 'Unhandled state or missing defensive check.',
    targetLines: [targetStart, targetEnd]
  };
}
