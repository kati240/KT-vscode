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

  if (diagramType === 'stateDiagram-v2') {
    lines.push('stateDiagram-v2');
    nodes.forEach((node, idx) => {
      const nid = idMap.get(node.id) || `N${idx + 1}`;
      const label = sanitizeMermaidLabel(node.label);
      lines.push(`    state "${label}" as ${nid}`);
    });
    edges.forEach((edge) => {
      const from = idMap.get(edge.from) || edge.from;
      const to = idMap.get(edge.to) || edge.to;
      const guard = edge.guardLabel ? ` : ${sanitizeMermaidLabel(edge.guardLabel)}` : '';
      lines.push(`    ${from} --> ${to}${guard}`);
    });
  } else if (diagramType === 'sequenceDiagram') {
    lines.push('sequenceDiagram');
    lines.push('    autonumber');
    nodes.forEach((node, idx) => {
      const nid = idMap.get(node.id) || `N${idx + 1}`;
      const label = sanitizeMermaidLabel(node.label);
      lines.push(`    participant ${nid} as ${label}`);
    });
    edges.forEach((edge) => {
      const from = idMap.get(edge.from) || edge.from;
      const to = idMap.get(edge.to) || edge.to;
      const guard = sanitizeMermaidLabel(edge.guardLabel || 'call');
      lines.push(`    ${from}->>${to}: ${guard}`);
    });
  } else {
    // Default: flowchart TD
    lines.push('flowchart TD');
    nodes.forEach((node, idx) => {
      const nid = idMap.get(node.id) || `N${idx + 1}`;
      const label = sanitizeMermaidLabel(node.label);
      lines.push(`    ${nid}["${label}"]`);
    });
    edges.forEach((edge) => {
      const from = idMap.get(edge.from) || edge.from;
      const to = idMap.get(edge.to) || edge.to;
      if (edge.guardLabel && edge.guardLabel.trim().length > 0) {
        const guard = sanitizeMermaidLabel(edge.guardLabel);
        lines.push(`    ${from} -->|"${guard}"| ${to}`);
      } else {
        lines.push(`    ${from} --> ${to}`);
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

  const systemPrompt = `You are CodeMist, a visual code comprehension engine.
CRITICAL CONSTRAINT: You must ONLY explain, diagram, and trace the user's SELECTED lines (from line ${context.startLine} to line ${context.endLine}).
${context.isPartialSelection ? `The user highlighted a sub-block inside parent function "${context.enclosingFunctionName}". Focus strictly on the highlighted lines.` : ''}

RULES:
1. Return ONLY a single raw valid JSON object.
2. ALWAYS use standard double quotes (") for all keys and strings. Never use single quotes (').
3. Keep descriptions concise (under 15 words per bullet or explanation).
4. Output 3 to 6 logical step nodes. All startLine and endLine numbers MUST be between ${context.startLine} and ${context.endLine}.
5. Upstream Callers: From the "Candidate Upstream Callers" provided, pick the Top 3 to 5 most architecturally distinct callers. Assign each:
   - "flowTag": choose from "Hot Path", "Init", "Callback", "Error/Retry", "Handler", or "Worker"
   - "roleHint": concise trigger explanation (under 8 words).
   Return these under "primaryCallers".
6. Downstream Callees: For each callee in "Selected Callees", assign:
   - "roleHint": concise intent (under 8 words)
   - "nodeId": tag it with the Mermaid step id (e.g. "N1", "N2") where it is invoked.

Schema:
{
  "summary": [
    "First crisp bullet point explaining the selected code",
    "Second crisp bullet point explaining key operations or mutations",
    "Third crisp bullet point explaining the return value or outcome"
  ],
  "diagramType": "flowchart TD",
  "nodes": [
    {
      "id": "N1",
      "label": "Short label (max 5 words)",
      "startLine": ${context.startLine},
      "endLine": ${context.endLine},
      "explanation": "Brief explanation"
    }
  ],
  "edges": [
    {
      "from": "N1",
      "to": "N2",
      "guardLabel": "condition (optional)"
    }
  ],
  "whatIfTraces": [
    {
      "title": "Edge Case Name",
      "triggerInput": "Concrete input value",
      "pathNodeIds": ["N1"],
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
      "nodeId": "N1"
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
 * Extracts and cleans JSON from LLM output, with ranking funnel resolution and un-truncated collections.
 */
function parseLLMJsonResponse(raw: string, context: HarvestedContext): StructuredAnalysis {
  const parsed = resilientJsonParse(raw) || {};

  const summary = normalizeSummary(parsed.summary);

  const validTypes = ['flowchart TD', 'stateDiagram-v2', 'sequenceDiagram'] as const;
  const diagramType = validTypes.includes(parsed.diagramType) ? parsed.diagramType : 'flowchart TD';

  const nodes: AnalysisNode[] = (Array.isArray(parsed.nodes) ? parsed.nodes : []).map((n: any, idx: number) => ({
    id: String(n.id || `N${idx + 1}`),
    label: String(n.label || n.title || `Step ${idx + 1}`),
    startLine: Number(n.startLine) || context.startLine,
    endLine: Number(n.endLine) || context.endLine,
    explanation: String(n.explanation || n.label || '')
  }));

  if (nodes.length === 0) {
    nodes.push({
      id: 'N1',
      label: 'Selected Execution Block',
      startLine: context.startLine,
      endLine: context.endLine,
      explanation: 'Block of selected lines'
    });
  }

  const edges: AnalysisEdge[] = (Array.isArray(parsed.edges) ? parsed.edges : []).map((e: any) => ({
    from: String(e.from || e.source || 'N1'),
    to: String(e.to || e.target || 'N2'),
    guardLabel: e.guardLabel || e.label || e.explanation || e.guard ? String(e.guardLabel || e.label || e.explanation || e.guard) : undefined
  }));

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
