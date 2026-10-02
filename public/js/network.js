/* ══════════════════════════════════════════════
   network.js — D3.js social network visualization
   ══════════════════════════════════════════════ */

const NetworkViz = (() => {

  const COLORS = ['#2563EB','#7C3AED','#0D9488','#F59E0B','#EF4444','#8B5CF6','#10B981','#F97316'];

  let simulation = null;

  function render() {
    const { network } = App.getState();
    const container = document.getElementById('view-container');

    if (!network.nodes.length) {
      container.innerHTML = `
        <div class="view-header">
          <div><div class="view-title">Network Graph</div>
               <div class="view-subtitle">Visualize social connections between users</div></div>
        </div>
        <div class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </div>
          <div class="empty-title">No network data</div>
          <div class="empty-sub">Upload nodes and edges CSVs in Import Data, or load the sample network.</div>
          <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
            <button class="btn btn-primary" onclick="App.navigate('import')">Import Data</button>
            <button class="btn btn-secondary" onclick="DataManager.loadSampleNetwork();App.navigate('network')">Load Sample Network</button>
          </div>
        </div>`;
      return;
    }

    // Degree centrality
    const degree = {};
    network.nodes.forEach(n => degree[n.id] = 0);
    network.edges.forEach(e => {
      if (degree[e.source] !== undefined) degree[e.source]++;
      if (degree[e.target] !== undefined) degree[e.target]++;
    });

    const groups = [...new Set(network.nodes.map(n=>n.group||'1'))].sort();
    const colorMap = Object.fromEntries(groups.map((g,i)=>[g, COLORS[i % COLORS.length]]));

    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Network Graph</div>
          <div class="view-subtitle">${network.nodes.length} nodes · ${network.edges.length} edges</div>
        </div>
      </div>

      <!-- Controls -->
      <div class="network-controls" style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:14px 18px;margin-bottom:14px;box-shadow:var(--sh-sm);display:flex;align-items:center;flex-wrap:wrap;gap:12px">
        <div class="form-group" style="flex-direction:row;align-items:center;gap:8px;margin:0">
          <label class="form-label" style="white-space:nowrap;margin:0">Search node:</label>
          <input class="form-input" id="net-search" placeholder="Label or ID…" style="width:180px" oninput="NetworkViz.search(this.value)">
        </div>
        <div class="form-group" style="flex-direction:row;align-items:center;gap:8px;margin:0">
          <label class="form-label" style="white-space:nowrap;margin:0">Link strength:</label>
          <input type="range" id="link-strength" min="0.1" max="2" step="0.1" value="0.5"
            oninput="NetworkViz.updateStrength(this.value)" style="width:100px">
        </div>
        <button class="btn btn-secondary btn-sm" onclick="NetworkViz.resetZoom()">Reset View</button>
        <button class="btn btn-secondary btn-sm" onclick="NetworkViz.toggleLabels()">Toggle Labels</button>
        <button class="btn btn-secondary btn-sm" onclick="NetworkViz.exportPNG()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export PNG
        </button>
        <button class="btn btn-secondary btn-sm" onclick="NetworkViz.exportSVG()">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:3px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Export SVG
        </button>
        <div class="net-legend">
          ${groups.map(g=>`<div class="net-legend-item"><div class="net-legend-dot" style="background:${colorMap[g]}"></div>Group ${App.esc(g)}</div>`).join('')}
        </div>
      </div>

      <!-- Stats bar -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px">
        ${[
          ['Nodes', network.nodes.length],
          ['Edges', network.edges.length],
          ['Communities', groups.length],
          ['Avg Degree', (network.edges.length*2/network.nodes.length).toFixed(1)]
        ].map(([l,v])=>`
          <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-md);padding:12px 16px;box-shadow:var(--sh-sm)">
            <div style="font-family:var(--f-display);font-weight:700;font-size:22px">${v}</div>
            <div style="font-size:12.5px;color:var(--tx-muted)">${l}</div>
          </div>`).join('')}
      </div>

      <!-- SVG -->
      <div class="network-wrap">
        <svg id="network-svg" style="height:520px"></svg>
        <div class="network-tooltip" id="net-tooltip" style="display:none"></div>
      </div>

      <!-- Node info panel -->
      <div id="node-info" style="margin-top:14px"></div>
    `;

    renderD3(network, degree, colorMap, groups);
  }

  let showLabels = true;

  function renderD3(network, degree, colorMap, groups) {
    const svg = d3.select('#network-svg');
    const rect = document.getElementById('network-svg').getBoundingClientRect();
    const W = rect.width || 900;
    const H = 520;

    svg.attr('viewBox', `0 0 ${W} ${H}`);

    // Defs for arrows
    svg.append('defs').append('marker')
      .attr('id','arrow').attr('viewBox','0 -5 10 10').attr('refX',18).attr('refY',0)
      .attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto')
      .append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#CBD5E1');

    // Zoom container
    const g = svg.append('g').attr('class', 'zoom-root');
    svg.call(d3.zoom().scaleExtent([0.2,5])
      .on('zoom', e => g.attr('transform', e.transform)));

    // Shallow copy for D3 mutation
    const nodes = network.nodes.map(n=>({...n, degree: degree[n.id]||0}));
    const edges = network.edges.map(e=>({...e}));

    // Size scale
    const maxDeg = Math.max(1, ...nodes.map(n=>n.degree));
    const rScale = d3.scaleLinear().domain([0,maxDeg]).range([8,22]);
    const wScale = d3.scaleLinear().domain([1,10]).range([0.8,4]);

    // Links
    const link = g.append('g').selectAll('line')
      .data(edges).join('line')
        .attr('stroke','#CBD5E1')
        .attr('stroke-opacity',0.7)
        .attr('stroke-width', d => wScale(d.weight||1))
        .attr('marker-end','url(#arrow)');

    // Nodes group
    const node = g.append('g').selectAll('g')
      .data(nodes).join('g')
        .attr('cursor','pointer')
        .attr('class', 'export-node')
        .attr('data-label', d => d.label || d.id)
        .attr('data-group', d => d.group || '')
        .attr('data-degree', d => d.degree)
        .call(d3.drag()
          .on('start', (event,d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
          .on('drag',  (event,d) => { d.fx=event.x; d.fy=event.y; })
          .on('end',   (event,d) => { if (!event.active) simulation.alphaTarget(0); d.fx=null; d.fy=null; }))
        .on('click', (event,d) => showNodeInfo(d, degree, network))
        .on('mouseover', (event,d) => showTooltip(event,d))
        .on('mouseout', hideTooltip);

    // Circles
    node.append('circle')
      .attr('class', 'export-node-circle')
      .attr('r', d => rScale(d.degree))
      .attr('fill', d => colorMap[d.group||'1'])
      .attr('stroke','white').attr('stroke-width',2)
      .attr('fill-opacity',0.85);

    // Labels
    const labels = node.append('text')
      .attr('text-anchor','middle').attr('dy','.35em')
      .attr('font-size','11px').attr('font-family',"'Inter',sans-serif")
      .attr('fill','#0F172A').attr('pointer-events','none')
      .attr('dy', d => rScale(d.degree) + 14)
      .text(d => d.label || d.id);

    // Simulation
    simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id(d=>d.id).strength(0.5).distance(80))
      .force('charge', d3.forceManyBody().strength(-280))
      .force('center', d3.forceCenter(W/2, H/2))
      .force('collision', d3.forceCollide().radius(d=>rScale(d.degree)+6))
      .on('tick', () => {
        link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y)
            .attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
        node.attr('transform', d=>`translate(${d.x},${d.y})`);
      });

    // Store refs for controls
    window._netRefs = { simulation, nodes, edges, link, node, labels, rScale, W, H, svg, g };
  }

  function showTooltip(event, d) {
    const tip = document.getElementById('net-tooltip');
    if (!tip) return;
    tip.style.display = 'block';
    tip.style.left = (event.offsetX + 12) + 'px';
    tip.style.top  = (event.offsetY - 8)  + 'px';
    tip.textContent = `${d.label||d.id} (Group ${d.group||'?'}, Degree: ${d.degree})`;
  }
  function hideTooltip() {
    const tip = document.getElementById('net-tooltip');
    if (tip) tip.style.display = 'none';
  }

  function showNodeInfo(d, degree, network) {
    const inEdges  = network.edges.filter(e=>e.target===d.id||e.target?.id===d.id);
    const outEdges = network.edges.filter(e=>e.source===d.id||e.source?.id===d.id);
    document.getElementById('node-info').innerHTML = `
      <div class="card" style="padding:16px 20px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="width:12px;height:12px;border-radius:50%;background:${COLORS[0]};flex-shrink:0"></div>
          <div style="font-family:var(--f-display);font-weight:600;font-size:15px">${App.esc(d.label||d.id)}</div>
          <span class="badge badge-gray">Group ${App.esc(d.group||'?')}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-size:13.5px">
          <div><div class="text-muted" style="font-size:12px">Total Degree</div><strong>${degree[d.id]||0}</strong></div>
          <div><div class="text-muted" style="font-size:12px">In-Edges</div><strong>${inEdges.length}</strong></div>
          <div><div class="text-muted" style="font-size:12px">Out-Edges</div><strong>${outEdges.length}</strong></div>
        </div>
      </div>`;
  }

  function updateStrength(val) {
    const r = window._netRefs;
    if (!r) return;
    r.simulation.force('link').strength(parseFloat(val));
    r.simulation.alpha(0.5).restart();
  }

  function toggleLabels() {
    showLabels = !showLabels;
    const r = window._netRefs;
    if (!r) return;
    r.labels.attr('display', showLabels ? null : 'none');
  }

  function resetZoom() {
    const r = window._netRefs;
    if (!r) return;
    r.svg.transition().duration(400).call(
      d3.zoom().transform, d3.zoomIdentity.translate(r.W/2, r.H/2).scale(0.9)
    );
  }

  function search(query) {
    const r = window._netRefs;
    if (!r) return;
    const q = query.toLowerCase();
    r.node.selectAll('circle')
      .attr('stroke', d =>
        !q ? 'white' :
        (d.label||d.id).toLowerCase().includes(q) ? '#F59E0B' : 'white'
      )
      .attr('stroke-width', d =>
        !q ? 2 :
        (d.label||d.id).toLowerCase().includes(q) ? 4 : 2
      );
  }

  /* ── Image export ─────────────────────────────
     Exports the FULL graph, not just whatever is currently visible in the
     zoomed/panned viewport. The live SVG's viewBox is fixed at "0 0 W H";
     only the inner .zoom-root <g>'s transform changes as the user pans/
     zooms — so a naive clone would clip out anything currently scrolled
     out of view. Instead we measure the graph's true extent via getBBox()
     (which reports a child's bounds in its OWN local coordinate space,
     unaffected by the zoom transform applied to it) and frame the export
     to that full extent, with the pan/zoom transform stripped from the
     clone so content renders at its natural layout position. */
  function getSVGSourceForExport(includeInteractivity) {
    const svgEl = document.getElementById('network-svg');
    if (!svgEl) return null;

    const r = window._netRefs;

    let bbox = null;
    if (r && r.g && typeof r.g.node === 'function') {
      try {
        const raw = r.g.node().getBBox();
        if (raw && raw.width > 0 && raw.height > 0) bbox = raw;
      } catch (e) {
        // getBBox can throw if the element isn't actually rendered;
        // fall through to the viewport-based fallback below.
      }
    }

    // 40px covers the node circles themselves comfortably; the hover
    // tooltip added below needs more room above whichever node sits at the
    // very top of the graph (worst case: max node radius 22 + the 14px gap
    // above it + the tooltip's own ~24px height), so we pad generously
    // enough to keep the tooltip from clipping against the frame's top edge.
    const PADDING = 55;
    let vbX, vbY, vbW, vbH;
    if (bbox) {
      vbX = bbox.x - PADDING;
      vbY = bbox.y - PADDING;
      vbW = bbox.width  + PADDING * 2;
      vbH = bbox.height + PADDING * 2;
    } else {
      // No usable bbox (e.g. called in an unexpected state) — fall back to
      // the original fixed viewport rather than failing the export outright.
      const rect = svgEl.getBoundingClientRect();
      vbX = 0; vbY = 0;
      vbW = (r && r.W) || rect.width  || 900;
      vbH = (r && r.H) || rect.height || 520;
    }

    // Cap the export at a sane max dimension so a very sprawling graph
    // can't produce a pathologically large canvas — browsers cap canvas
    // size, and an oversized PNG buys no visual benefit. Scaling both
    // dimensions by the same factor keeps the aspect ratio exact, so
    // nothing is cropped or distorted — the whole graph just renders
    // smaller if it's large.
    const MAX_DIM = 3000;
    let width  = Math.ceil(vbW);
    let height = Math.ceil(vbH);
    if (width > MAX_DIM || height > MAX_DIM) {
      const scaleDown = MAX_DIM / Math.max(width, height);
      width  = Math.round(width  * scaleDown);
      height = Math.round(height * scaleDown);
    }

    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);
    clone.setAttribute('viewBox', vbX + ' ' + vbY + ' ' + vbW + ' ' + vbH);
    // The live element has an inline style="height:520px" for on-screen
    // layout, and CSS gives it width:100% from its container — neither
    // means anything once serialized standalone, and in SVG2 an inline
    // style would actually override the width/height attributes we just
    // set. Drop it so the attributes above are what actually renders.
    clone.removeAttribute('style');

    // Strip the live pan/zoom transform from the cloned graph root so
    // content renders at its natural layout position — the viewBox above
    // now frames the FULL graph directly, regardless of what the user
    // currently has zoomed/panned to on screen.
    const clonedRoot = clone.querySelector('.zoom-root');
    if (clonedRoot) clonedRoot.removeAttribute('transform');

    // The visible background comes from CSS on #network-svg, which isn't
    // part of the SVG itself — without this the exported file/PNG would
    // have a transparent background instead of the white canvas shown on
    // screen. x/y match the viewBox origin (which may be negative) so the
    // rect actually covers the full visible area rather than just the
    // region starting at absolute (0,0).
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', String(vbX)); bg.setAttribute('y', String(vbY));
    bg.setAttribute('width', String(vbW)); bg.setAttribute('height', String(vbH));
    bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild);

    if (includeInteractivity) {
      addInteractiveTooltip(clone);
    }

    const svgString = new XMLSerializer().serializeToString(clone);
    return { svgString, width, height };
  }

  // Embeds a self-contained hover tooltip into the exported SVG, so opening
  // the downloaded file in a browser tab shows the same "Label (Group X,
  // Degree: Y)" popup as the live app. This only works when the SVG is
  // opened as a page (scripts run) — not when embedded via <img>, which
  // browsers always treat as non-scriptable; that path (PNG export) never
  // requests this, so it's fine either way.
  //
  // IMPORTANT: SVG embedded scripts can't use CDATA sections from an HTML
  // document (browsers throw on document.createCDATASection() there), and
  // plain textContent on a <script> gets XML-escaped by XMLSerializer —
  // so a literal "<", ">" or "&" in the source would corrupt the code into
  // invalid JS (e.g. "a < b" becomes "a &lt; b"). The script below is
  // written with that constraint in mind: no arrow functions (they contain
  // ">"), no "&&" (nested ifs instead), and transform parsing via
  // indexOf/slice instead of a comparison-heavy regex.
  function addInteractiveTooltip(clone) {
    const NS = 'http://www.w3.org/2000/svg';

    const tooltip = document.createElementNS(NS, 'g');
    tooltip.setAttribute('id', 'export-tooltip');
    tooltip.setAttribute('visibility', 'hidden');

    const tooltipBg = document.createElementNS(NS, 'rect');
    tooltipBg.setAttribute('id', 'export-tooltip-bg');
    tooltipBg.setAttribute('rx', '6');
    tooltipBg.setAttribute('fill', '#0F172A');

    const tooltipText = document.createElementNS(NS, 'text');
    tooltipText.setAttribute('id', 'export-tooltip-text');
    tooltipText.setAttribute('fill', '#ffffff');
    tooltipText.setAttribute('font-size', '12');
    tooltipText.setAttribute('font-family', "'Inter',sans-serif");
    tooltipText.setAttribute('text-anchor', 'middle');

    tooltip.appendChild(tooltipBg);
    tooltip.appendChild(tooltipText);
    clone.appendChild(tooltip);

    const scriptLines = [
      '(function() {',
      '  var svg = document.currentScript.parentNode;',
      '  var tooltip = svg.getElementById("export-tooltip");',
      '  var tooltipBg = svg.getElementById("export-tooltip-bg");',
      '  var tooltipText = svg.getElementById("export-tooltip-text");',
      '  if (!tooltip) { return; }',
      '  if (!tooltipBg) { return; }',
      '  if (!tooltipText) { return; }',
      '  var nodes = svg.querySelectorAll(".export-node");',
      '  function showTip(node) {',
      '    var label = node.getAttribute("data-label") || "";',
      '    var group = node.getAttribute("data-group") || "";',
      '    var degree = node.getAttribute("data-degree") || "0";',
      '    tooltipText.textContent = label + " (Group " + group + ", Degree: " + degree + ")";',
      '    var transform = node.getAttribute("transform") || "";',
      '    var openParen = transform.indexOf("(");',
      '    var comma = transform.indexOf(",");',
      '    var closeParen = transform.indexOf(")");',
      '    var cx = 0;',
      '    var cy = 0;',
      '    if (openParen !== -1) {',
      '      if (comma !== -1) {',
      '        if (closeParen !== -1) {',
      '          cx = parseFloat(transform.slice(openParen + 1, comma)) || 0;',
      '          cy = parseFloat(transform.slice(comma + 1, closeParen)) || 0;',
      '        }',
      '      }',
      '    }',
      '    var circle = node.querySelector(".export-node-circle");',
      '    var r = 14;',
      '    if (circle) { r = parseFloat(circle.getAttribute("r")) || 14; }',
      '    tooltipText.setAttribute("x", cx);',
      '    tooltipText.setAttribute("y", cy - r - 14);',
      '    var bbox = tooltipText.getBBox();',
      '    var padX = 10;',
      '    var padY = 6;',
      '    tooltipBg.setAttribute("x", bbox.x - padX);',
      '    tooltipBg.setAttribute("y", bbox.y - padY);',
      '    tooltipBg.setAttribute("width", bbox.width + padX * 2);',
      '    tooltipBg.setAttribute("height", bbox.height + padY * 2);',
      '    tooltip.setAttribute("visibility", "visible");',
      '    tooltip.parentNode.appendChild(tooltip);',
      '  }',
      '  function hideTip() {',
      '    tooltip.setAttribute("visibility", "hidden");',
      '  }',
      '  function bind(node) {',
      '    node.addEventListener("mouseenter", function() { showTip(node); });',
      '    node.addEventListener("mouseleave", hideTip);',
      '  }',
      '  nodes.forEach(bind);',
      '})();'
    ];
    const scriptCode = scriptLines.join('\n');

    // Belt-and-braces: verify at build time that the generated code really
    // is free of characters that XML serialization would corrupt, since
    // this whole approach depends on that being true.
    if (/[<>&]/.test(scriptCode)) {
      console.error('[NetworkViz] Interactive export script contains an unsafe character — skipping embedded interactivity for this export.');
      clone.removeChild(tooltip);
      return;
    }

    const scriptEl = document.createElementNS(NS, 'script');
    scriptEl.setAttribute('type', 'application/ecmascript');
    scriptEl.textContent = scriptCode;
    clone.appendChild(scriptEl);
  }

  function exportSVG() {
    const src = getSVGSourceForExport(true);
    if (!src) { App.notify('No graph to export — build a network first', 'warning'); return; }

    const blob = new Blob([src.svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'metacode_network_graph.svg';
    a.click();
    URL.revokeObjectURL(url);
    App.notify('Exported network graph as SVG — open it in a browser tab to hover nodes for details', 'success');
  }

  function exportPNG() {
    const src = getSVGSourceForExport(false);
    if (!src) { App.notify('No graph to export — build a network first', 'warning'); return; }

    const svgBlob = new Blob([src.svgString], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl  = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      try {
        const scale  = 2; // render at 2x for a crisper, print-quality PNG
        const canvas = document.createElement('canvas');
        canvas.width  = src.width  * scale;
        canvas.height = src.height * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, src.width, src.height);
        URL.revokeObjectURL(svgUrl);

        canvas.toBlob(blob => {
          if (!blob) { App.notify('PNG export failed — try SVG export instead', 'error'); return; }
          const pngUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = pngUrl;
          a.download = 'metacode_network_graph.png';
          a.click();
          URL.revokeObjectURL(pngUrl);
          App.notify('Exported network graph as PNG', 'success');
        }, 'image/png');
      } catch (err) {
        URL.revokeObjectURL(svgUrl);
        App.notify('PNG export failed (' + err.message + ') — try SVG export instead', 'error');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      App.notify('PNG export failed — try SVG export instead', 'error');
    };
    img.src = svgUrl;
  }

  return { render, updateStrength, toggleLabels, resetZoom, search, exportPNG, exportSVG };
})();
