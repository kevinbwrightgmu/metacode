/* ══════════════════════════════════════════════
   engagement.js — Metrics section: engagement & coding charts via Chart.js
   (route id "metrics"; module keeps its original EngagementViz name)
   ══════════════════════════════════════════════ */

const EngagementViz = (() => {

  const chartInstances = {};

  function render() {
    const { posts, codebook } = App.getState();
    const container = document.getElementById('view-container');

    // Destroy old charts
    Object.values(chartInstances).forEach(c => c?.destroy());

    const withEng = posts.filter(p => p.engagement?.likes != null || p.engagement?.shares != null);

    if (!posts.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div>
        <div class="empty-title">No data to visualize</div>
        <div class="empty-sub">Import posts first, then return here to explore engagement patterns.</div>
        <button class="btn btn-primary" onclick="App.navigate('import')">Import Posts</button>
      </div>`;
      return;
    }

    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Metrics</div>
          <div class="view-subtitle">${posts.length} posts · ${withEng.length} with engagement data · ${codebook.length} dimensions</div>
        </div>
      </div>

      <!-- Summary stats -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px">
        ${summaryStats(withEng)}
      </div>

      ${!codebook.length ? `
        <div class="card" style="text-align:center;padding:40px">
          <div style="font-size:14px;color:var(--tx-second)">Build a codebook and code your posts to see engagement breakdowns by code.</div>
          <button class="btn btn-primary mt-3" onclick="App.navigate('codebook')">Build Codebook</button>
        </div>` : `

      <!-- Code distribution chart -->
      <div class="card-grid card-grid-2" style="margin-bottom:20px">
        <div class="chart-card">
          <div class="chart-card-title">Code Distribution (AI)</div>
          <div style="margin-bottom:10px">
            <select class="form-select" id="dim-select-ai" onchange="EngagementViz.updateDimAI(this.value)" style="font-size:13px">
              ${codebook.map(d=>`<option value="${d.id}">${App.esc(d.name)}</option>`).join('')}
            </select>
          </div>
          <div class="chart-wrap" style="height:220px"><canvas id="chart-dist-ai"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-card-title">Code Distribution (Human)</div>
          <div style="margin-bottom:10px">
            <select class="form-select" id="dim-select-human" onchange="EngagementViz.updateDimHuman(this.value)" style="font-size:13px">
              ${codebook.map(d=>`<option value="${d.id}">${App.esc(d.name)}</option>`).join('')}
            </select>
          </div>
          <div class="chart-wrap" style="height:220px"><canvas id="chart-dist-human"></canvas></div>
        </div>
      </div>

      ${withEng.length > 0 ? `
      <!-- Engagement by code -->
      <div class="card-grid card-grid-2" style="margin-bottom:20px">
        <div class="chart-card">
          <div class="chart-card-title">Avg Likes by AI Code</div>
          <div style="margin-bottom:10px">
            <select class="form-select" id="dim-select-eng-ai" onchange="EngagementViz.updateEngAI(this.value)" style="font-size:13px">
              ${codebook.map(d=>`<option value="${d.id}">${App.esc(d.name)}</option>`).join('')}
            </select>
          </div>
          <div class="chart-wrap" style="height:220px"><canvas id="chart-eng-ai"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-card-title">Avg Engagement by Human Code</div>
          <div style="margin-bottom:10px">
            <select class="form-select" id="dim-select-eng-human" onchange="EngagementViz.updateEngHuman(this.value)" style="font-size:13px">
              ${codebook.map(d=>`<option value="${d.id}">${App.esc(d.name)}</option>`).join('')}
            </select>
          </div>
          <div class="chart-wrap" style="height:220px"><canvas id="chart-eng-human"></canvas></div>
        </div>
      </div>` : ''}

      <!-- Agreement rate chart -->
      ${codebook.length > 0 ? `
      <div class="card-grid card-grid-2">
        <div class="chart-card">
          <div class="chart-card-title">AI vs Human Agreement by Dimension</div>
          <div class="chart-wrap" style="height:240px"><canvas id="chart-agree"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-card-title">Coding Completion Status</div>
          <div class="chart-wrap" style="height:240px"><canvas id="chart-completion"></canvas></div>
        </div>
      </div>` : ''}
    `}
    `;

    // Build charts after DOM is ready
    setTimeout(() => buildCharts(posts, codebook, withEng), 50);
  }

  function summaryStats(withEng) {
    const avg = (arr, key) => arr.length ? (arr.reduce((s,p)=>s+(p.engagement?.[key]||0),0)/arr.length).toFixed(1) : '—';
    return [
      ['Avg Likes',    avg(withEng,'likes'),   '#EF4444', 'M0,10 C5,-5 15,25 20,10'],
      ['Avg Shares',   avg(withEng,'shares'),  '#3B82F6', 'M0,10 C5,20 15,0 20,10'],
      ['Avg Comments', avg(withEng,'comments'),'#7C3AED', 'M0,15 C5,0 15,20 20,5'],
      ['Avg Views',    avg(withEng,'views'),   '#0D9488', 'M0,5 C5,20 15,0 20,15']
    ].map(([label,val,color,wave])=>`
      <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px 20px;box-shadow:var(--sh-sm)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-family:var(--f-display);font-weight:700;font-size:26px;color:${color}">${val}</div>
            <div style="font-size:12.5px;color:var(--tx-muted);margin-top:2px">${label}</div>
          </div>
          <svg width="40" height="20" viewBox="0 0 20 20" style="opacity:.4">
            <path d="${wave}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
      </div>`).join('');
  }

  function buildCharts(posts, codebook, withEng) {
    if (!codebook.length) return;
    const dim0 = codebook[0];

    // Distribution charts
    chartInstances.distAI    = buildDistChart('chart-dist-ai',    posts, codebook, dim0.id, 'ai');
    chartInstances.distHuman = buildDistChart('chart-dist-human', posts, codebook, dim0.id, 'human');

    if (withEng.length > 0) {
      chartInstances.engAI    = buildEngChart('chart-eng-ai',    withEng, codebook, dim0.id, 'ai');
      chartInstances.engHuman = buildEngChart('chart-eng-human', withEng, codebook, dim0.id, 'human');
    }

    // Agreement chart
    buildAgreementChart('chart-agree', posts, codebook);
    // Completion chart
    buildCompletionChart('chart-completion', posts);
  }

  function buildDistChart(canvasId, posts, codebook, dimId, coder) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const dim = codebook.find(d=>d.id===dimId);
    if (!dim) return null;

    const counts = {};
    dim.codes.forEach(c => counts[c.id] = 0);
    posts.forEach(p => {
      const code = coder==='ai' ? (p.aiCodes?.[dimId]||{}).code : p.humanCodes?.[dimId];
      if (code && counts[code]!==undefined) counts[code]++;
    });

    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: dim.codes.map(c=>c.label),
        datasets: [{
          label: coder==='ai' ? 'AI codes' : 'Human codes',
          data: dim.codes.map(c=>counts[c.id]),
          backgroundColor: coder==='ai' ? 'rgba(124,58,237,0.75)' : 'rgba(13,148,136,0.75)',
          borderColor:     coder==='ai' ? '#7C3AED' : '#0D9488',
          borderWidth: 1, borderRadius: 6
        }]
      },
      options: chartOptions('Number of Posts')
    });
  }

  function buildEngChart(canvasId, withEng, codebook, dimId, coder) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const dim = codebook.find(d=>d.id===dimId);
    if (!dim) return null;

    const groups = {};
    dim.codes.forEach(c => groups[c.id] = []);
    withEng.forEach(p => {
      const code = coder==='ai' ? (p.aiCodes?.[dimId]||{}).code : p.humanCodes?.[dimId];
      if (code && groups[code]!==undefined) groups[code].push(p.engagement?.likes||0);
    });

    const avgs = dim.codes.map(c => {
      const vals = groups[c.id];
      return vals.length ? (vals.reduce((s,v)=>s+v,0)/vals.length).toFixed(1) : 0;
    });

    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: dim.codes.map(c=>c.label),
        datasets: [{
          label: 'Avg Likes',
          data: avgs,
          backgroundColor: 'rgba(239,68,68,0.7)',
          borderColor: '#EF4444', borderWidth:1, borderRadius:6
        }]
      },
      options: chartOptions('Avg Likes')
    });
  }

  function buildAgreementChart(canvasId, posts, codebook) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const data = codebook.map(dim => {
      const pairs = posts.filter(p => p.humanCodes?.[dim.id] && (p.aiCodes?.[dim.id]||{}).code);
      const agree = pairs.filter(p => p.humanCodes[dim.id] === (p.aiCodes[dim.id]||{}).code).length;
      return pairs.length ? Math.round(agree/pairs.length*100) : 0;
    });
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: codebook.map(d=>d.name),
        datasets: [{
          label: '% Agreement',
          data,
          backgroundColor: data.map(v => v>=80?'rgba(16,185,129,0.75)':v>=60?'rgba(245,158,11,0.75)':'rgba(239,68,68,0.75)'),
          borderRadius: 6
        }]
      },
      options: { ...chartOptions('%'), plugins:{ legend:{display:false} }, scales:{ y:{ min:0,max:100, ticks:{callback:v=>v+'%'} } } }
    });
  }

  function buildCompletionChart(canvasId, posts) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ai    = posts.filter(p=>Object.keys(p.aiCodes||{}).length>0).length;
    const human = posts.filter(p=>Object.keys(p.humanCodes||{}).length>0).length;
    const both  = posts.filter(p=>Object.keys(p.aiCodes||{}).length>0&&Object.keys(p.humanCodes||{}).length>0).length;
    const uncoded = posts.filter(p=>!Object.keys(p.aiCodes||{}).length&&!Object.keys(p.humanCodes||{}).length).length;
    new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['AI Only','Human Only','Both','Uncoded'],
        datasets: [{
          data: [ai-both, human-both, both, uncoded],
          backgroundColor: ['rgba(124,58,237,0.75)','rgba(13,148,136,0.75)','rgba(37,99,235,0.75)','rgba(203,213,225,0.75)'],
          borderWidth: 2, borderColor: '#fff'
        }]
      },
      options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{font:{size:12}} } } }
    });
  }

  function chartOptions(yLabel) {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend:{ display:false } },
      scales: {
        x: { ticks:{ font:{size:12} }, grid:{ display:false } },
        y: { title:{ display:!!yLabel, text:yLabel, font:{size:11} }, ticks:{ font:{size:12} }, grid:{ color:'#F1F5F9' }, beginAtZero:true }
      }
    };
  }

  /* ── Update callbacks ────────────────────────*/
  function updateDimAI(dimId) {
    chartInstances.distAI?.destroy();
    chartInstances.distAI = buildDistChart('chart-dist-ai', App.getState().posts, App.getState().codebook, dimId, 'ai');
  }
  function updateDimHuman(dimId) {
    chartInstances.distHuman?.destroy();
    chartInstances.distHuman = buildDistChart('chart-dist-human', App.getState().posts, App.getState().codebook, dimId, 'human');
  }
  function updateEngAI(dimId) {
    const withEng = App.getState().posts.filter(p=>p.engagement?.likes!=null);
    chartInstances.engAI?.destroy();
    chartInstances.engAI = buildEngChart('chart-eng-ai', withEng, App.getState().codebook, dimId, 'ai');
  }
  function updateEngHuman(dimId) {
    const withEng = App.getState().posts.filter(p=>p.engagement?.likes!=null);
    chartInstances.engHuman?.destroy();
    chartInstances.engHuman = buildEngChart('chart-eng-human', withEng, App.getState().codebook, dimId, 'human');
  }

  return { render, updateDimAI, updateDimHuman, updateEngAI, updateEngHuman };
})();
