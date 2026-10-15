// @ts-check
(function () {
  // Acquire VS Code API
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // State
  let currentAnalysis = null;
  let currentFilePath = '';
  let activeTraceIndex = -1;
  let navigationStack = []; // [{ name, data, filePath }]

  // Drawer & Filter state
  let callersSearchQuery = '';
  let activeCallerCategory = 'all'; // 'all' | 'same_module' | 'other_prod' | 'test'
  let isCallersDrawerOpen = false;
  let isCalleesDrawerOpen = false;

  // DOM Elements
  const emptyState = document.getElementById('empty-state');
  const loadingState = document.getElementById('loading-state');
  const errorState = document.getElementById('error-state');
  const contentState = document.getElementById('content-state');
  const errorMessageEl = document.getElementById('error-message');

  const breadcrumbBar = document.getElementById('breadcrumb-bar');
  const breadcrumbsList = document.getElementById('breadcrumbs-list');
  const copyMarkdownBtn = document.getElementById('copy-markdown-btn');
  const copyBtnText = document.getElementById('copy-btn-text');

  const scopePrefixEl = document.getElementById('scope-prefix');
  const scopeFnNameEl = document.getElementById('scope-fn-name');
  const scopeLinesInfoEl = document.getElementById('scope-lines-info');
  const expandFnBtn = document.getElementById('expand-fn-btn');

  const summaryList = document.getElementById('summary-list');
  const diagramViewport = document.getElementById('diagram-viewport');
  const tracesContainer = document.getElementById('traces-container');
  const diagramTypeBadge = document.getElementById('diagram-type-badge');

  // Upstream elements
  const callersCountBadge = document.getElementById('callers-count-badge');
  const primaryCallersContainer = document.getElementById('primary-callers-container');
  const seeAllCallersWrapper = document.getElementById('see-all-callers-wrapper');
  const toggleAllCallersBtn = document.getElementById('toggle-all-callers-btn');
  const allCallersBtnCount = document.getElementById('all-callers-btn-count');
  const allCallersPanel = document.getElementById('all-callers-panel');
  const callersFilterInput = /** @type {HTMLInputElement} */ (document.getElementById('callers-filter-input'));
  const allCallersList = document.getElementById('all-callers-list');

  const catCountAll = document.getElementById('cat-count-all');
  const catCountModule = document.getElementById('cat-count-module');
  const catCountOther = document.getElementById('cat-count-other');
  const catCountTest = document.getElementById('cat-count-test');

  // Downstream elements
  const calleesCountBadge = document.getElementById('callees-count-badge');
  const selectedCalleesContainer = document.getElementById('selected-callees-container');
  const seeAllCalleesWrapper = document.getElementById('see-all-callees-wrapper');
  const toggleParentCalleesBtn = document.getElementById('toggle-parent-callees-btn');
  const allCalleesBtnCount = document.getElementById('all-callees-btn-count');
  const allCalleesPanel = document.getElementById('all-callees-panel');
  const parentCalleesList = document.getElementById('parent-callees-list');

  // Trigger analysis button
  const triggerBtn = document.getElementById('trigger-analysis-btn');
  if (triggerBtn) {
    triggerBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'requestAnalysis' });
    });
  }

  // Copy Markdown for PR/Docs button
  if (copyMarkdownBtn) {
    copyMarkdownBtn.addEventListener('click', () => {
      if (!currentAnalysis) return;
      const md = generateMarkdownForPR(currentAnalysis);

      vscode.postMessage({ command: 'copyToClipboard', text: md });
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).catch(() => {});
      }

      copyMarkdownBtn.classList.add('copied');
      if (copyBtnText) copyBtnText.textContent = '✓ Copied!';
      setTimeout(() => {
        copyMarkdownBtn.classList.remove('copied');
        if (copyBtnText) copyBtnText.textContent = 'Copy for PR';
      }, 2200);
    });
  }

  // Toggle "See All Callers" Drawer
  if (toggleAllCallersBtn && allCallersPanel) {
    toggleAllCallersBtn.addEventListener('click', () => {
      isCallersDrawerOpen = !isCallersDrawerOpen;
      toggleAllCallersBtn.classList.toggle('expanded', isCallersDrawerOpen);
      allCallersPanel.style.display = isCallersDrawerOpen ? 'flex' : 'none';
      if (isCallersDrawerOpen && callersFilterInput) {
        callersFilterInput.focus();
      }
    });
  }

  // Filter Callers on keystroke
  if (callersFilterInput) {
    callersFilterInput.addEventListener('input', () => {
      callersSearchQuery = callersFilterInput.value.trim().toLowerCase();
      renderFilteredAllCallers();
    });
  }

  // Category filter pills
  const categoryPills = document.querySelectorAll('.category-pill');
  categoryPills.forEach(pill => {
    pill.addEventListener('click', () => {
      categoryPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeCallerCategory = pill.getAttribute('data-cat') || 'all';
      renderFilteredAllCallers();
    });
  });

  // Toggle "See All Calls in Enclosing Function" Drawer
  if (toggleParentCalleesBtn && allCalleesPanel) {
    toggleParentCalleesBtn.addEventListener('click', () => {
      isCalleesDrawerOpen = !isCalleesDrawerOpen;
      toggleParentCalleesBtn.classList.toggle('expanded', isCalleesDrawerOpen);
      allCalleesPanel.style.display = isCalleesDrawerOpen ? 'block' : 'none';
    });
  }

  // Detect VS Code theme
  function getMermaidTheme() {
    const isDark = document.body.classList.contains('vscode-dark') || 
                   document.body.classList.contains('vscode-high-contrast');
    return isDark ? 'dark' : 'default';
  }

  // Initialize Mermaid
  // @ts-ignore
  if (window.mermaid) {
    // @ts-ignore
    window.mermaid.initialize({
      startOnLoad: false,
      theme: getMermaidTheme(),
      securityLevel: 'loose',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });
  }

  // View state switcher
  function showView(viewName) {
    if (emptyState) emptyState.style.display = viewName === 'empty' ? 'flex' : 'none';
    if (loadingState) loadingState.style.display = viewName === 'loading' ? 'flex' : 'none';
    if (errorState) errorState.style.display = viewName === 'error' ? 'block' : 'none';
    if (contentState) contentState.style.display = viewName === 'content' ? 'block' : 'none';
    if (copyMarkdownBtn) copyMarkdownBtn.style.display = viewName === 'content' ? 'inline-flex' : 'none';
  }

  // Render analysis payload
  async function renderAnalysis(data, filePath) {
    currentAnalysis = data;
    if (filePath) currentFilePath = filePath;
    activeTraceIndex = -1;
    callersSearchQuery = '';
    if (callersFilterInput) callersFilterInput.value = '';

    // 1. Scope Title & Expand Button (Partial Selection)
    if (scopeFnNameEl) {
      scopeFnNameEl.textContent = data.enclosingFunctionName || 'Active Selection';
    }

    if (data.isPartialSelection && data.enclosingStartLine && data.enclosingEndLine) {
      if (scopePrefixEl) scopePrefixEl.textContent = 'INSIDE:';
      if (scopeLinesInfoEl) {
        scopeLinesInfoEl.textContent = `(Lines ${data.enclosingStartLine}-${data.enclosingEndLine})`;
      }
      if (expandFnBtn) {
        expandFnBtn.style.display = 'inline-flex';
        expandFnBtn.onclick = () => {
          vscode.postMessage({
            command: 'expandToFullFunction',
            startLine: data.enclosingStartLine,
            endLine: data.enclosingEndLine
          });
        };
      }
    } else {
      if (scopePrefixEl) scopePrefixEl.textContent = 'SCOPE:';
      if (scopeLinesInfoEl) scopeLinesInfoEl.textContent = '';
      if (expandFnBtn) expandFnBtn.style.display = 'none';
    }

    // 2. Render Executive Summary
    if (summaryList && Array.isArray(data.summary)) {
      summaryList.innerHTML = '';
      data.summary.forEach(point => {
        const li = document.createElement('li');
        const bullet = document.createElement('span');
        bullet.className = 'summary-bullet';
        bullet.textContent = '•';
        const text = document.createElement('span');
        text.textContent = point;
        li.appendChild(bullet);
        li.appendChild(text);
        summaryList.appendChild(li);
      });
    }

    // 3. Render Upstream ("Called From") Chips & See All Drawer
    renderUpstreamCallers(data);

    // 4. Render Mermaid SVG
    if (diagramTypeBadge) {
      diagramTypeBadge.textContent = data.diagramType;
    }

    if (diagramViewport && window.mermaid) {
      diagramViewport.innerHTML = '<div class="spinner"></div>';
      try {
        const uniqueId = 'mermaid-' + Math.random().toString(36).substring(2, 9);
        // @ts-ignore
        const { svg } = await window.mermaid.render(uniqueId, data.mermaidSource);
        diagramViewport.innerHTML = svg;
        bindSvgNodeInteractions(data.nodes);
      } catch (err) {
        diagramViewport.innerHTML = `<div style="color: var(--danger-color); font-size: 11px;">Diagram render error: ${err.message}</div>`;
      }
    }

    // 5. Render Downstream ("Calls Into") Chips & Partial Selection Drawer
    renderDownstreamCallees(data);

    // 6. Render What-If Edge Case Pills
    if (tracesContainer && Array.isArray(data.whatIfTraces)) {
      tracesContainer.innerHTML = '';
      data.whatIfTraces.forEach((trace, idx) => {
        const pill = document.createElement('div');
        pill.className = 'trace-pill';
        pill.dataset.index = String(idx);

        const header = document.createElement('div');
        header.className = 'trace-pill-header';

        const title = document.createElement('div');
        title.className = 'trace-pill-title';
        title.innerHTML = `<span>⚡</span> <span>${escapeHtml(trace.title)}</span>`;

        const linesTag = document.createElement('span');
        linesTag.className = 'trace-line-tag';
        linesTag.textContent = `L${trace.targetLines[0]}-${trace.targetLines[1]}`;

        header.appendChild(title);
        header.appendChild(linesTag);

        const trigger = document.createElement('div');
        trigger.className = 'trace-trigger';
        trigger.innerHTML = `Trigger: <code>${escapeHtml(trace.triggerInput)}</code>`;

        const blindspot = document.createElement('div');
        blindspot.className = 'trace-blindspot';
        blindspot.innerHTML = `<strong>Blind Spot:</strong> ${escapeHtml(trace.potentialBlindSpot)}`;

        pill.appendChild(header);
        pill.appendChild(trigger);
        pill.appendChild(blindspot);

        pill.addEventListener('click', () => {
          selectWhatIfTrace(idx, trace);
        });

        tracesContainer.appendChild(pill);
      });
    }

    updateBreadcrumbsUI();
    showView('content');
  }

  // Render Upstream Callers & See All Drawer
  function renderUpstreamCallers(data) {
    if (!primaryCallersContainer) return;
    primaryCallersContainer.innerHTML = '';

    const primary = Array.isArray(data.primaryCallers) ? data.primaryCallers : [];
    const all = Array.isArray(data.allCallers) ? data.allCallers : [];

    if (callersCountBadge) callersCountBadge.textContent = String(all.length);
    if (allCallersBtnCount) allCallersBtnCount.textContent = String(all.length);

    if (all.length === 0) {
      primaryCallersContainer.innerHTML = '<div class="empty-chips-msg">No upstream callers detected in immediate scope.</div>';
      if (seeAllCallersWrapper) seeAllCallersWrapper.style.display = 'none';
      return;
    }

    // Render Top 3-5 Pinned Callers
    primary.forEach(c => {
      primaryCallersContainer.appendChild(createCallerCard(c, true));
    });

    // Update Category Counts for the Drawer
    const countModule = all.filter(c => c.category === 'same_module').length;
    const countOther = all.filter(c => c.category === 'other_prod').length;
    const countTest = all.filter(c => c.category === 'test').length;

    if (catCountAll) catCountAll.textContent = String(all.length);
    if (catCountModule) catCountModule.textContent = String(countModule);
    if (catCountOther) catCountOther.textContent = String(countOther);
    if (catCountTest) catCountTest.textContent = String(countTest);

    // Show See All toggle button if callers exist
    if (seeAllCallersWrapper) {
      seeAllCallersWrapper.style.display = 'block';
    }

    // Render full list inside drawer based on current filters
    renderFilteredAllCallers();
  }

  // Render the un-truncated filtered callers in the drawer
  function renderFilteredAllCallers() {
    if (!allCallersList || !currentAnalysis) return;
    allCallersList.innerHTML = '';

    const all = Array.isArray(currentAnalysis.allCallers) ? currentAnalysis.allCallers : [];

    const filtered = all.filter(c => {
      // Category match
      if (activeCallerCategory !== 'all' && c.category !== activeCallerCategory) {
        return false;
      }
      // Query match
      if (callersSearchQuery) {
        const nameMatch = c.name.toLowerCase().includes(callersSearchQuery);
        const fileMatch = (c.filePath || '').toLowerCase().includes(callersSearchQuery);
        const snippetMatch = (c.callSiteSnippet || '').toLowerCase().includes(callersSearchQuery);
        const roleMatch = (c.roleHint || '').toLowerCase().includes(callersSearchQuery);
        if (!nameMatch && !fileMatch && !snippetMatch && !roleMatch) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0) {
      allCallersList.innerHTML = '<div class="empty-chips-msg">No callers match your filter.</div>';
      return;
    }

    filtered.forEach(c => {
      allCallersList.appendChild(createCallerCard(c, false));
    });
  }

  function createCallerCard(c, isPrimary) {
    const chip = document.createElement('div');
    chip.className = 'flow-chip';

    const top = document.createElement('div');
    top.className = 'flow-chip-top';

    const main = document.createElement('div');
    main.className = 'flow-chip-main';
    main.title = `Jump to line ${c.line} in ${getBasename(c.filePath)}`;

    const header = document.createElement('div');
    header.className = 'flow-chip-header';

    const name = document.createElement('span');
    name.className = 'flow-chip-name';
    name.textContent = c.name;

    const loc = document.createElement('span');
    loc.className = 'flow-chip-loc';
    const countInfo = c.callSiteCount > 1 ? ` (${c.callSiteCount} sites)` : '';
    loc.textContent = `${getBasename(c.filePath)}:${c.line}${countInfo}`;

    header.appendChild(name);
    header.appendChild(loc);

    // Category Badge
    if (c.category) {
      const catBadge = document.createElement('span');
      if (c.category === 'same_module') {
        catBadge.className = 'category-badge badge-same-module';
        catBadge.textContent = 'Module';
      } else if (c.category === 'test') {
        catBadge.className = 'category-badge badge-test';
        catBadge.textContent = 'Test';
      } else {
        catBadge.className = 'category-badge badge-other-prod';
        catBadge.textContent = 'Prod';
      }
      header.appendChild(catBadge);
    }

    // Flow Tag
    if (c.flowTag) {
      const tag = document.createElement('span');
      const tagLower = c.flowTag.toLowerCase();
      let tagClass = 'flow-tag-default';
      if (tagLower.includes('hot')) tagClass = 'flow-tag-hotpath';
      else if (tagLower.includes('init') || tagLower.includes('start')) tagClass = 'flow-tag-init';
      else if (tagLower.includes('callback') || tagLower.includes('handler')) tagClass = 'flow-tag-callback';
      else if (tagLower.includes('error') || tagLower.includes('retry')) tagClass = 'flow-tag-error';

      tag.className = `flow-tag ${tagClass}`;
      tag.textContent = c.flowTag;
      header.appendChild(tag);
    }

    main.appendChild(header);

    if (c.roleHint) {
      const hint = document.createElement('div');
      hint.className = 'flow-chip-hint';
      hint.textContent = c.roleHint;
      main.appendChild(hint);
    }

    // Jump to file & line
    main.addEventListener('click', () => {
      vscode.postMessage({
        command: 'jumpToFileLine',
        filePath: c.filePath,
        line: c.line
      });
    });

    // Explore ➔ button
    const exploreBtn = document.createElement('button');
    exploreBtn.className = 'explore-btn';
    exploreBtn.title = `Explore caller function ${c.name}`;
    exploreBtn.innerHTML = `Explore ➔`;
    exploreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({
        command: 'exploreFunction',
        filePath: c.filePath,
        line: c.line,
        name: c.name
      });
    });

    top.appendChild(main);
    top.appendChild(exploreBtn);
    chip.appendChild(top);

    // Call site snippet box
    if (c.callSiteSnippet) {
      const snippetBox = document.createElement('div');
      snippetBox.className = 'snippet-box';
      snippetBox.title = 'Exact line of code at call site';
      snippetBox.textContent = c.callSiteSnippet;
      chip.appendChild(snippetBox);
    }

    return chip;
  }

  // Render Downstream Callees & Partial-Selection Drawer
  function renderDownstreamCallees(data) {
    if (!selectedCalleesContainer) return;
    selectedCalleesContainer.innerHTML = '';

    const selectedCallees = Array.isArray(data.selectedCallees) ? data.selectedCallees : [];
    const otherParentCallees = Array.isArray(data.otherParentCallees) ? data.otherParentCallees : [];
    const totalCount = selectedCallees.length + otherParentCallees.length;

    if (calleesCountBadge) calleesCountBadge.textContent = String(totalCount);
    if (allCalleesBtnCount) allCalleesBtnCount.textContent = String(otherParentCallees.length);

    if (totalCount === 0) {
      selectedCalleesContainer.innerHTML = '<div class="empty-chips-msg">No downstream callees invoked in selected lines.</div>';
      if (seeAllCalleesWrapper) seeAllCalleesWrapper.style.display = 'none';
      return;
    }

    // Prominently show selected callees (called inside highlighted lines)
    if (selectedCallees.length > 0) {
      selectedCallees.forEach(c => {
        selectedCalleesContainer.appendChild(createCalleeCard(c, true));
      });
    } else {
      selectedCalleesContainer.innerHTML = '<div class="empty-chips-msg">No calls directly inside highlighted lines.</div>';
    }

    // "See All Calls in Enclosing Function" Drawer for partial selections
    if (data.isPartialSelection && otherParentCallees.length > 0) {
      if (seeAllCalleesWrapper) seeAllCalleesWrapper.style.display = 'block';
      if (parentCalleesList) {
        parentCalleesList.innerHTML = '';
        otherParentCallees.forEach(c => {
          parentCalleesList.appendChild(createCalleeCard(c, false));
        });
      }
    } else {
      if (seeAllCalleesWrapper) seeAllCalleesWrapper.style.display = 'none';
    }
  }

  function createCalleeCard(c, isSelectedLine) {
    const chip = document.createElement('div');
    chip.className = 'flow-chip';

    const top = document.createElement('div');
    top.className = 'flow-chip-top';

    const main = document.createElement('div');
    main.className = 'flow-chip-main';
    main.title = `Jump to line ${c.line} in ${getBasename(c.filePath)}`;

    const header = document.createElement('div');
    header.className = 'flow-chip-header';

    const name = document.createElement('span');
    name.className = 'flow-chip-name';
    name.textContent = c.name;

    const loc = document.createElement('span');
    loc.className = 'flow-chip-loc';
    const linesStr = c.calledFromLines && c.calledFromLines.length > 0 ? `L${c.calledFromLines.join(',')}` : `L${c.line}`;
    loc.textContent = `${getBasename(c.filePath)} (${linesStr})`;

    header.appendChild(name);
    header.appendChild(loc);

    if (c.nodeId) {
      const nodeTag = document.createElement('span');
      nodeTag.className = 'flow-node-tag';
      nodeTag.textContent = c.nodeId;
      nodeTag.title = `Invoked in diagram step ${c.nodeId}`;
      nodeTag.addEventListener('click', (e) => {
        e.stopPropagation();
        pulseDiagramNode(c.nodeId);
      });
      header.appendChild(nodeTag);
    }

    main.appendChild(header);

    if (c.roleHint) {
      const hint = document.createElement('div');
      hint.className = 'flow-chip-hint';
      hint.textContent = c.roleHint;
      main.appendChild(hint);
    }

    main.addEventListener('click', () => {
      vscode.postMessage({
        command: 'jumpToFileLine',
        filePath: c.filePath,
        line: c.line
      });
    });

    const exploreBtn = document.createElement('button');
    exploreBtn.className = 'explore-btn';
    exploreBtn.title = `Explore callee function ${c.name}`;
    exploreBtn.innerHTML = `Explore ➔`;
    exploreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({
        command: 'exploreFunction',
        filePath: c.filePath,
        line: c.line,
        name: c.name
      });
    });

    top.appendChild(main);
    top.appendChild(exploreBtn);
    chip.appendChild(top);

    return chip;
  }

  // Breadcrumbs UI Management
  function updateBreadcrumbsUI() {
    if (!breadcrumbBar || !breadcrumbsList) return;

    if (navigationStack.length <= 1) {
      breadcrumbBar.style.display = 'none';
      return;
    }

    breadcrumbBar.style.display = 'block';
    breadcrumbsList.innerHTML = '';

    navigationStack.forEach((item, index) => {
      const isLast = index === navigationStack.length - 1;

      const btn = document.createElement('span');
      btn.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
      btn.textContent = item.name || `Level ${index + 1}`;
      btn.title = item.filePath ? `${item.name} (${item.filePath})` : item.name;

      if (!isLast) {
        btn.addEventListener('click', () => {
          navigateToBreadcrumb(index);
        });
      }

      breadcrumbsList.appendChild(btn);

      if (!isLast) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator';
        sep.textContent = '›';
        breadcrumbsList.appendChild(sep);
      }
    });

    breadcrumbBar.scrollLeft = breadcrumbBar.scrollWidth;
  }

  function navigateToBreadcrumb(index) {
    if (index >= 0 && index < navigationStack.length) {
      const target = navigationStack[index];
      navigationStack = navigationStack.slice(0, index + 1);
      renderAnalysis(target.data, target.filePath);
    }
  }

  // Reverse Cursor Sync
  function handleCursorMoved(line) {
    if (!diagramViewport || !currentAnalysis || !currentAnalysis.nodes) return;
    const svgEl = diagramViewport.querySelector('svg');
    if (!svgEl) return;

    const matchedNode = currentAnalysis.nodes.find(n => line >= n.startLine && line <= n.endLine);
    const svgNodes = svgEl.querySelectorAll('g.node, g.actor, g[class*="statediagram-state"], g[id*="flowchart-"]');

    svgNodes.forEach(nodeEl => {
      const dataId = (nodeEl.getAttribute('data-node-id') || '').toLowerCase();
      const idAttr = (nodeEl.getAttribute('id') || '').toLowerCase();

      if (matchedNode && (dataId === matchedNode.id.toLowerCase() || idAttr.includes(matchedNode.id.toLowerCase()))) {
        nodeEl.classList.add('node-cursor-active');
      } else {
        nodeEl.classList.remove('node-cursor-active');
      }
    });
  }

  function pulseDiagramNode(nodeId) {
    if (!diagramViewport) return;
    const svgEl = diagramViewport.querySelector('svg');
    if (!svgEl) return;

    const targetId = String(nodeId).toLowerCase();
    const svgNodes = svgEl.querySelectorAll('g.node, g.actor, g[class*="statediagram-state"], g[id*="flowchart-"]');

    svgNodes.forEach(nodeEl => {
      const dataId = (nodeEl.getAttribute('data-node-id') || '').toLowerCase();
      const idAttr = (nodeEl.getAttribute('id') || '').toLowerCase();

      if (dataId === targetId || idAttr.includes(targetId)) {
        nodeEl.classList.add('node-selected');
        setTimeout(() => nodeEl.classList.remove('node-selected'), 2000);
      }
    });
  }

  // Bind click events on SVG nodes
  function bindSvgNodeInteractions(nodes) {
    if (!diagramViewport) return;
    const svgEl = diagramViewport.querySelector('svg');
    if (!svgEl) return;

    const nodeLookup = new Map();
    nodes.forEach(n => {
      nodeLookup.set(n.id.toLowerCase(), n);
    });

    const svgNodes = svgEl.querySelectorAll('g.node, g.actor, g[class*="statediagram-state"], g[id*="flowchart-"]');
    svgNodes.forEach(nodeEl => {
      const idAttr = (nodeEl.getAttribute('id') || '').toLowerCase();
      const textContent = (nodeEl.textContent || '').trim().toLowerCase();

      let matchedNode = null;
      for (const [nid, n] of nodeLookup.entries()) {
        if (idAttr.includes(nid) || textContent.includes(n.label.toLowerCase())) {
          matchedNode = n;
          break;
        }
      }

      if (matchedNode) {
        nodeEl.setAttribute('data-node-id', matchedNode.id);
        nodeEl.setAttribute('title', `Lines ${matchedNode.startLine}-${matchedNode.endLine}: ${matchedNode.explanation}`);
        
        nodeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          clearWhatIfSelection();

          svgEl.querySelectorAll('.node-selected').forEach(el => el.classList.remove('node-selected'));
          nodeEl.classList.add('node-selected');

          vscode.postMessage({
            command: 'highlightLines',
            startLine: matchedNode.startLine,
            endLine: matchedNode.endLine
          });
        });
      }
    });
  }

  // Select What-If edge case pill
  function selectWhatIfTrace(index, trace) {
    activeTraceIndex = index;

    if (tracesContainer) {
      tracesContainer.querySelectorAll('.trace-pill').forEach((pill, i) => {
        pill.classList.toggle('active', i === index);
      });
    }

    vscode.postMessage({
      command: 'highlightLines',
      startLine: trace.targetLines[0],
      endLine: trace.targetLines[1]
    });

    highlightMermaidPath(trace.pathNodeIds);
  }

  function clearWhatIfSelection() {
    activeTraceIndex = -1;
    if (tracesContainer) {
      tracesContainer.querySelectorAll('.trace-pill').forEach(p => p.classList.remove('active'));
    }
    if (diagramViewport) {
      const svgEl = diagramViewport.querySelector('svg');
      if (svgEl) {
        svgEl.querySelectorAll('.node-in-path').forEach(el => el.classList.remove('node-in-path'));
        svgEl.querySelectorAll('.node-dimmed').forEach(el => el.classList.remove('node-dimmed'));
      }
    }
  }

  function highlightMermaidPath(pathNodeIds) {
    if (!diagramViewport) return;
    const svgEl = diagramViewport.querySelector('svg');
    if (!svgEl) return;

    const normalizedPathIds = (pathNodeIds || []).map(id => String(id).toLowerCase());
    const svgNodes = svgEl.querySelectorAll('g.node, g.actor, g[class*="statediagram-state"], g[id*="flowchart-"]');

    svgNodes.forEach(nodeEl => {
      const dataId = (nodeEl.getAttribute('data-node-id') || '').toLowerCase();
      const idAttr = (nodeEl.getAttribute('id') || '').toLowerCase();

      const isInPath = normalizedPathIds.some(pid => 
        (dataId && dataId === pid) || (idAttr && idAttr.includes(pid))
      );

      if (isInPath) {
        nodeEl.classList.add('node-in-path');
        nodeEl.classList.remove('node-dimmed');
      } else {
        nodeEl.classList.remove('node-in-path');
        nodeEl.classList.add('node-dimmed');
      }
    });
  }

  // One-Click "Copy Markdown for PR/Docs" Formatter
  function generateMarkdownForPR(analysis) {
    const fnTitle = analysis.enclosingFunctionName || 'Selected Code Block';
    const lines = [];

    const scopeSubtitle = analysis.isPartialSelection && analysis.enclosingStartLine && analysis.enclosingEndLine
      ? ` (Sub-block of \`${fnTitle}\`, Lines ${analysis.enclosingStartLine}-${analysis.enclosingEndLine})`
      : '';

    lines.push(`## 🔍 Code Comprehension: \`${fnTitle}\`${scopeSubtitle}`);
    lines.push('');
    lines.push('### 📋 Executive Summary');
    if (Array.isArray(analysis.summary)) {
      analysis.summary.forEach(p => lines.push(`- ${p}`));
    }
    lines.push('');

    // Primary Upstream Callers
    const primaryCallers = Array.isArray(analysis.primaryCallers) ? analysis.primaryCallers : [];
    const allCallers = Array.isArray(analysis.allCallers) ? analysis.allCallers : [];
    if (allCallers.length > 0) {
      lines.push(`### ⬆️ Upstream Callers ("Called From") — Total: ${allCallers.length}`);
      primaryCallers.forEach(c => {
        const tag = c.flowTag ? ` [${c.flowTag}]` : '';
        const cat = c.category ? ` (${c.category})` : '';
        lines.push(`- **\`${c.name}\`**${tag}${cat} (\`${getBasename(c.filePath)}:${c.line}\`)${c.roleHint ? ` — *${c.roleHint}*` : ''}`);
        if (c.callSiteSnippet) {
          lines.push(`  \`\`\`${c.callSiteSnippet}\`\`\``);
        }
      });
      const remainingCount = allCallers.length - primaryCallers.length;
      if (remainingCount > 0) {
        lines.push(`- *+ ${remainingCount} other callers available in CodeMist Interactive Drawer*`);
      }
      lines.push('');
    }

    // Downstream Callees
    const selectedCallees = Array.isArray(analysis.selectedCallees) ? analysis.selectedCallees : [];
    if (selectedCallees.length > 0) {
      lines.push('### ⬇️ Downstream Callees ("Calls Into")');
      selectedCallees.forEach(c => {
        const lineRef = c.calledFromLines && c.calledFromLines.length > 0 ? `L${c.calledFromLines.join(',')}` : `L${c.line}`;
        lines.push(`- **\`${c.name}\`** (\`${getBasename(c.filePath)}\` at ${lineRef})${c.nodeId ? ` [Node \`${c.nodeId}\`]` : ''}${c.roleHint ? ` — *${c.roleHint}*` : ''}`);
      });
      if (analysis.otherParentCallees && analysis.otherParentCallees.length > 0) {
        lines.push(`- *+ ${analysis.otherParentCallees.length} other calls elsewhere in parent function*`);
      }
      lines.push('');
    }

    // Visual Flow Diagram
    lines.push('### 📊 Visual Execution Flow');
    lines.push('```mermaid');
    lines.push(analysis.mermaidSource || '');
    lines.push('```');
    lines.push('');

    // What-If Edge Cases
    if (Array.isArray(analysis.whatIfTraces) && analysis.whatIfTraces.length > 0) {
      lines.push('### ⚡ What-If Edge-Case Tracing');
      analysis.whatIfTraces.forEach((t, i) => {
        lines.push(`${i + 1}. **${t.title}** (Lines ${t.targetLines[0]}-${t.targetLines[1]})`);
        lines.push(`   - **Trigger Input:** \`${t.triggerInput}\``);
        lines.push(`   - **Potential Blind Spot:** ${t.potentialBlindSpot}`);
      });
      lines.push('');
    }

    lines.push('---');
    lines.push('*Generated via [CodeMist](https://github.com/kati240/KT-vscode)*');
    return lines.join('\n');
  }

  function getBasename(path) {
    if (!path) return '';
    if (path.startsWith('untitled:')) {
      return path.replace('untitled:', '');
    }
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1];
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // Listen for messages from the extension host
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
      case 'showLoading':
        showView('loading');
        break;
      case 'showError':
        if (errorMessageEl) {
          errorMessageEl.textContent = message.message || 'An unknown error occurred.';
        }
        showView('error');
        break;
      case 'renderAnalysis':
        navigationStack = [{
          name: message.data.enclosingFunctionName || 'Root Function',
          data: message.data,
          filePath: message.filePath
        }];
        renderAnalysis(message.data, message.filePath);
        break;
      case 'pushAnalysis':
        navigationStack.push({
          name: message.data.enclosingFunctionName || 'Explored Function',
          data: message.data,
          filePath: message.filePath
        });
        renderAnalysis(message.data, message.filePath);
        break;
      case 'cursorMoved':
        handleCursorMoved(message.line);
        break;
      case 'showEmpty':
        showView('empty');
        break;
    }
  });

  // Ready signal
  vscode.postMessage({ command: 'webviewReady' });
})();
