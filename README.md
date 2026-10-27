# CodeMist 🌫️

**Visual Code Comprehension & What-If Edge-Case Tracing for VS Code.**

CodeMist is a language-agnostic extension that instantly demystifies complex code. Select any block of code or function, and CodeMist synthesizes an interactive **Mermaid.js execution diagram**, maps out **upstream callers and downstream callees**, and runs **What-If edge-case scenario tracing** to expose potential runtime blind spots—all powered by local LLMs (Ollama/vLLM) or remote providers (OpenAI, Gemini).

![CodeMist Interactive Demo](https://raw.githubusercontent.com/kati240/KT-vscode/main/resources/demo.gif)

---

## ✨ Features

### 📊 1. Visual Execution Flow
- Generates clean, deterministic **Mermaid.js** diagrams (`flowchart TD`, `stateDiagram-v2`, `sequenceDiagram`) dynamically adapted to code structure.
- Interactive SVG diagram with pan, zoom, reset, and fit controls.
- Click any node in the diagram to instantly jump to and highlight the corresponding source lines in the active editor.

### ⬆️ 2. Upstream ("Called From") & ⬇️ Downstream ("Calls Into") Flow Lists
- Automatically harvests incoming callers and outgoing callees via Language Server Protocol (LSP) Call Hierarchy with fallback heuristic AST/regex scanning.
- **Top Candidates Pinned**: Highest-confidence production callers tagged with semantic flow hints (`Hot Path`, `Init`, `Callback`, `Error/Retry`).
- **Interactive "See All" Drawer**: Searchable panel with live keystroke filtering, category tabs (`All`, `Same Module`, `Other Prod`, `Tests`), call site snippets, and one-click jump.

### 🧭 3. Breadcrumb Drill-Down Stack
- Click **"Explore →"** on any caller or callee chip to automatically open that function, harvest its full scope, and trace its UML execution flow.
- A breadcrumb bar (`Func A → Func B → Func C`) keeps track of your exploration path so you can effortlessly navigate back and forth.

### ⚡ 4. What-If Edge-Case Tracing
- Synthesizes 3 real-world edge-case scenarios (e.g. `null`/empty inputs, race conditions, boundary values, unexpected state transitions).
- Displays the step-by-step node execution path and highlights potential code blind spots with target line ranges.

### 🔄 5. Bidirectional Reverse Cursor Sync
- Move your cursor in the editor, and CodeMist automatically highlights the corresponding node in the active Mermaid diagram in real time.

### 📋 6. One-Click PR / Architecture Markdown Export
- Export the entire trace—executive summary, caller/callee trees, raw Mermaid diagram, and edge cases—formatted as clean GitHub-compatible Markdown ready to paste into Pull Requests or architecture notes.

### 🔒 7. 100% Private & Local-First
- Designed for local-first inference using **Ollama** (`gemma4`, `qwen2.5-coder`, `llama3`, `deepseek-coder`) or **vLLM** / **LMStudio**.
- Also compatible with OpenAI, Google Gemini, and Groq via OpenAI-compatible endpoints.

---

## 🚀 Quick Start

1. **Select Code** in any file (or place your cursor inside a function).
2. Press **`Ctrl+Shift+U`** (Mac: **`Cmd+Shift+U`**) or **`Alt+U`**, or click the CodeMist icon in the Activity Bar.
3. CodeMist opens the **Visual Trace** sidebar and renders your interactive UML diagram, call graphs, and edge cases.

---

## ⚙️ Configuration

Open VS Code Settings (`Ctrl+,` or `Cmd+,`) and search for `codemist`:

| Setting | Default | Description |
|---|---|---|
| `codemist.apiEndpoint` | `http://localhost:11434/v1/chat/completions` | OpenAI-compatible LLM endpoint (Ollama, vLLM, LMStudio, OpenAI, Gemini). |
| `codemist.modelName` | `gemma4:latest` | Model identifier to query (e.g. `gemma4:latest`, `qwen2.5-coder:7b`, `llama3:8b`, `gpt-4o-mini`). |
| `codemist.apiKey` | `""` | Optional API key (required for OpenAI, Gemini, Groq, or authenticated gateways). |

### Using with Local Ollama (Recommended)
```bash
# Pull your preferred coding model
ollama run gemma4:latest
# or
ollama run qwen2.5-coder:7b
```
No API key required! CodeMist connects to `http://localhost:11434/v1/chat/completions` out of the box.

### Using with OpenAI or Gemini
- **Endpoint**: `https://api.openai.com/v1/chat/completions`
- **Model**: `gpt-4o-mini`
- **API Key**: `sk-...`

---

## ⌨️ Keybindings

| Shortcut | Command | When |
|---|---|---|
| `Ctrl+Shift+U` / `Cmd+Shift+U` | `codemist.explainSelection` | Editor has selection |
| `Alt+U` | `codemist.explainSelection` | Editor has selection |
| `Ctrl+Alt+U` / `Cmd+Alt+U` | `codemist.explainSelection` | Editor focused |

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.

