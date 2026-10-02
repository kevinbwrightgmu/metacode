/* ══════════════════════════════════════════════
   reliability.js — Intercoder reliability statistics
   Cohen's Kappa, Krippendorff's Alpha, Pct Agreement
   Confusion matrices, per-dimension breakdowns
   ══════════════════════════════════════════════ */

const ReliabilityAnalyzer = (() => {

  let selectedDim = null;

  /* ── Render ─────────────────────────────────*/
  function render() {
    const { posts, codebook } = App.getState();
    const container = document.getElementById('view-container');

    const dualCoded = posts.filter(p =>
      Object.keys(p.humanCodes||{}).length > 0 &&
      Object.keys(p.aiCodes||{}).length > 0
    );

    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Reliability Analysis</div>
          <div class="view-subtitle">Compare human vs AI coding — ${dualCoded.length} dual-coded posts</div>
        </div>
        <div class="view-actions">
          <button class="btn btn-secondary" onclick="ReliabilityAnalyzer.exportReport()">Download Report</button>
        </div>
      </div>

      ${dualCoded.length < 2 ? noPairsState(dualCoded.length) : mainContent(dualCoded, codebook)}
    `;

    if (dualCoded.length >= 2 && selectedDim) {
      renderConfusionMatrix(dualCoded, codebook);
    }
  }

  function noPairsState(count) {
    return `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="empty-title">${count === 0 ? 'No dual-coded posts yet' : 'Need at least 2 dual-coded posts'}</div>
        <div class="empty-sub">
          To calculate intercoder reliability, code each post with <em>both</em> AI coding and human coding.
          Currently ${count} post${count!==1?'s':''} ha${count===1?'s':'ve'} both.
        </div>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:20px">
          <button class="btn btn-violet" onclick="App.navigate('ai-coding')">Run AI Coding</button>
          <button class="btn btn-teal"   onclick="App.navigate('human-coding')">Code Manually</button>
        </div>
      </div>`;
  }

  function mainContent(dualCoded, codebook) {
    const stats = computeAll(dualCoded);
    const overall = computeOverall(dualCoded, codebook);
    if (!selectedDim && codebook.length > 0) selectedDim = codebook[0].id;

    return `
      <!-- Overall metrics -->
      <div class="rel-header-cards">
        <div class="rel-metric">
          <div class="rel-metric-val ${ratingClass(overall.pa)}">${(overall.pa*100).toFixed(1)}%</div>
          <div class="rel-metric-name">Overall Agreement</div>
          <div class="rel-metric-desc">${dualCoded.length} paired posts · all dimensions</div>
        </div>
        <div class="rel-metric">
          <div class="rel-metric-val ${ratingClass(overall.kappa, 'kappa')}">${overall.kappa.toFixed(3)}</div>
          <div class="rel-metric-name">Cohen's κ (overall)</div>
          <div class="rel-metric-desc">${interpKappa(overall.kappa)}</div>
        </div>
        <div class="rel-metric">
          <div class="rel-metric-val ${ratingClass(overall.alpha, 'kappa')}">${overall.alpha.toFixed(3)}</div>
          <div class="rel-metric-name">Krippendorff's α (overall)</div>
          <div class="rel-metric-desc">Nominal, two raters</div>
        </div>
      </div>

      <!-- Kappa interpretation guide -->
      <div class="card mb-4" style="margin-bottom:20px">
        <div class="card-title">Interpretation Guide</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${[
            ['< 0', 'Poor','var(--error)'],
            ['0.01–0.20','Slight','#F97316'],
            ['0.21–0.40','Fair','var(--warning)'],
            ['0.41–0.60','Moderate','#84CC16'],
            ['0.61–0.80','Substantial','var(--success)'],
            ['0.81–1.0','Near Perfect','#0891B2']
          ].map(([range,label,color])=>`
            <div style="display:flex;align-items:center;gap:6px;background:var(--bg-muted);padding:6px 12px;border-radius:99px">
              <div style="width:8px;height:8px;border-radius:50%;background:${color}"></div>
              <span style="font-size:12.5px"><strong>${range}</strong> = ${label}</span>
            </div>`).join('')}
        </div>
      </div>

      <!-- Per-dimension table -->
      <div class="post-table-wrap" style="margin-bottom:24px">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border)">
          <div style="font-family:var(--f-display);font-weight:600;font-size:14px">Per-Dimension Reliability</div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>N Pairs</th>
                <th>% Agreement</th>
                <th>Cohen's κ</th>
                <th>Krippendorff's α</th>
                <th>Interpretation</th>
                <th>Confusion Matrix</th>
              </tr>
            </thead>
            <tbody>
              ${stats.map(s => `
                <tr>
                  <td style="font-weight:600">${App.esc(s.name)}</td>
                  <td>${s.n}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div style="width:60px;height:6px;background:var(--border);border-radius:99px;overflow:hidden">
                        <div style="height:100%;width:${(s.pa*100).toFixed(0)}%;background:var(--teal);border-radius:99px"></div>
                      </div>
                      <span class="${ratingClass(s.pa)}">${(s.pa*100).toFixed(1)}%</span>
                    </div>
                  </td>
                  <td><span class="${ratingClass(s.kappa,'kappa')}" style="font-family:var(--f-mono);font-weight:600">${s.kappa.toFixed(3)}</span></td>
                  <td><span class="${ratingClass(s.alpha,'kappa')}" style="font-family:var(--f-mono);font-weight:600">${s.alpha.toFixed(3)}</span></td>
                  <td><span class="badge ${interpBadge(s.kappa)}">${s.interp}</span></td>
                  <td>
                    <button class="btn btn-ghost btn-sm" onclick="ReliabilityAnalyzer.showDim('${s.id}')"
                      style="color:var(--blue)">View →</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Confusion matrix section -->
      <div id="confusion-section">
        ${selectedDim ? '' : ''}
      </div>

      <!-- Agreement breakdown -->
      <div class="card-grid card-grid-2">
        <div class="card">
          <div class="card-title">Agreement Summary</div>
          ${agreementBreakdown(dualCoded, codebook)}
        </div>
        <div class="card">
          <div class="card-title">Disagreement Analysis</div>
          ${disagreementAnalysis(dualCoded, codebook)}
        </div>
      </div>
    `;

    // render confusion matrix for first dim
    setTimeout(() => {
      if (selectedDim) renderConfusionMatrix(dualCoded, codebook);
    }, 0);
  }

  function renderConfusionMatrix(dualCoded, codebook) {
    const dim = codebook.find(d=>d.id===selectedDim);
    if (!dim) return;

    const section = document.getElementById('confusion-section');
    if (!section) return;

    const pairs = dualCoded
      .map(p => ({ h: p.humanCodes?.[dim.id], a: (p.aiCodes?.[dim.id]||{}).code }))
      .filter(p => p.h && p.a);

    if (!pairs.length) {
      section.innerHTML = `<div class="card mb-4" style="margin-bottom:20px"><div class="empty-sub">No paired data for this dimension.</div></div>`;
      return;
    }

    const codes = dim.codes.map(c=>c.id);
    const labels = Object.fromEntries(dim.codes.map(c=>[c.id,c.label]));

    // Build matrix
    const matrix = {};
    codes.forEach(h => { matrix[h]={}; codes.forEach(a => { matrix[h][a]=0; }); });
    pairs.forEach(({h,a}) => { if (matrix[h] && matrix[h][a]!==undefined) matrix[h][a]++; });

    // Row totals
    const rowTotals = {};
    codes.forEach(h => rowTotals[h] = codes.reduce((s,a)=>s+matrix[h][a],0));
    const colTotals = {};
    codes.forEach(a => colTotals[a] = codes.reduce((s,h)=>s+matrix[h][a],0));
    const total = pairs.length;
    const maxVal = Math.max(1, ...pairs.map(_=>1), ...codes.flatMap(h=>codes.map(a=>matrix[h][a])));

    const dimSelect = `
      <select onchange="ReliabilityAnalyzer.showDim(this.value)"
        style="padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-md);font-size:13px;background:var(--bg-surface)">
        ${codebook.map(d=>`<option value="${d.id}" ${d.id===selectedDim?'selected':''}>${App.esc(d.name)}</option>`).join('')}
      </select>`;

    section.innerHTML = `
      <div class="card" style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div class="card-title" style="margin-bottom:0">Confusion Matrix — ${App.esc(dim.name)}</div>
          ${dimSelect}
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
          <div style="overflow-x:auto">
            <table class="conf-matrix">
              <thead>
                <tr>
                  <th style="background:none;border:none"></th>
                  <th colspan="${codes.length}" style="color:var(--violet);font-size:13px;border-bottom:2px solid var(--violet)">
                    AI Coding →
                  </th>
                  <th style="background:var(--bg-muted)">Total</th>
                </tr>
                <tr>
                  <th style="text-align:right;color:var(--teal);font-size:12px">Human ↓</th>
                  ${codes.map(a=>`<th class="col-label">${App.esc(labels[a]||a)}</th>`).join('')}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${codes.map(h=>`
                  <tr>
                    <td class="row-label">${App.esc(labels[h]||h)}</td>
                    ${codes.map(a => {
                      const v = matrix[h][a];
                      const isDiag = h === a;
                      const intensity = maxVal > 0 ? v/maxVal : 0;
                      const bg = isDiag
                        ? `rgba(13,148,136,${0.15+intensity*0.5})`  // teal for agreement
                        : v>0 ? `rgba(239,68,68,${0.1+intensity*0.4})` : 'transparent'; // red for disagreement
                      return `<td class="${isDiag?'cell-diagonal':''}"
                        style="background:${bg};font-weight:${isDiag?'700':'400'};
                          color:${isDiag&&v>0?'var(--teal)':v>0?'var(--error)':'var(--tx-muted)'}">
                        ${v||'—'}
                        ${v>0?`<div style="font-size:10px;opacity:.7">${(v/total*100).toFixed(0)}%</div>`:''}
                      </td>`;
                    }).join('')}
                    <td style="background:var(--bg-muted);font-weight:600">${rowTotals[h]}</td>
                  </tr>`).join('')}
                <tr>
                  <th style="background:var(--bg-muted)">Total</th>
                  ${codes.map(a=>`<td style="background:var(--bg-muted);font-weight:600;text-align:center">${colTotals[a]}</td>`).join('')}
                  <td style="background:var(--bg-muted);font-weight:700">${total}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:12px">
            <div style="background:var(--teal-lt);padding:12px 14px;border-radius:var(--r-md);border-left:3px solid var(--teal)">
              <div style="font-size:12px;color:var(--tx-muted);margin-bottom:2px">Diagonal = Agreement</div>
              <div style="font-family:var(--f-display);font-weight:700;font-size:20px;color:var(--teal)">
                ${pairs.filter(p=>p.h===p.a).length} / ${total}
              </div>
            </div>
            <div style="background:var(--violet-lt);padding:12px 14px;border-radius:var(--r-md);border-left:3px solid var(--violet)">
              <div style="font-size:12px;color:var(--tx-muted);margin-bottom:2px">Off-diagonal = Disagreement</div>
              <div style="font-family:var(--f-display);font-weight:700;font-size:20px;color:var(--violet)">
                ${pairs.filter(p=>p.h!==p.a).length} / ${total}
              </div>
            </div>
            <div style="font-size:12.5px;color:var(--tx-second);line-height:1.6">
              <strong style="color:var(--teal)">Rows</strong> = Human codes<br>
              <strong style="color:var(--violet)">Columns</strong> = AI codes<br>
              Diagonal cells = agreement.<br>
              Teal intensity = higher agreement.
            </div>
          </div>
        </div>
      </div>`;
  }

  function showDim(dimId) {
    selectedDim = dimId;
    const { posts, codebook } = App.getState();
    const dualCoded = posts.filter(p =>
      Object.keys(p.humanCodes||{}).length > 0 &&
      Object.keys(p.aiCodes||{}).length > 0
    );
    renderConfusionMatrix(dualCoded, codebook);
  }

  /* ── Statistics ─────────────────────────────*/
  function computeAll(dualCoded) {
    const { codebook } = App.getState();
    if (!dualCoded) {
      const { posts } = App.getState();
      dualCoded = posts.filter(p =>
        Object.keys(p.humanCodes||{}).length > 0 &&
        Object.keys(p.aiCodes||{}).length > 0
      );
    }
    return codebook.map(dim => {
      const pairs = dualCoded
        .map(p => ({ h: p.humanCodes?.[dim.id], a: (p.aiCodes?.[dim.id]||{}).code }))
        .filter(p => p.h && p.a);

      if (pairs.length === 0) return { id:dim.id, name:dim.name, n:0, pa:0, kappa:0, alpha:0, interp:'N/A' };

      const h = pairs.map(p=>p.h);
      const a = pairs.map(p=>p.a);
      const categories = [...new Set([...h,...a])];
      const pa    = percentAgreement(h, a);
      const kappa = cohensKappa(h, a, categories);
      const alpha = krippendorffAlpha(h, a);
      return { id:dim.id, name:dim.name, n:pairs.length, pa, kappa, alpha, interp:interpKappa(kappa) };
    });
  }

  function computeOverall(dualCoded, codebook) {
    if (!dualCoded) return { pa:0, kappa:0, alpha:0 };
    const allH=[],allA=[];
    codebook.forEach(dim => {
      dualCoded.forEach(p => {
        const h = p.humanCodes?.[dim.id];
        const a = (p.aiCodes?.[dim.id]||{}).code;
        if (h && a) { allH.push(h); allA.push(a); }
      });
    });
    if (!allH.length) return { pa:0, kappa:0, alpha:0 };
    const cats = [...new Set([...allH,...allA])];
    return {
      pa:    percentAgreement(allH, allA),
      kappa: cohensKappa(allH, allA, cats),
      alpha: krippendorffAlpha(allH, allA)
    };
  }

  function percentAgreement(h, a) {
    if (!h.length) return 0;
    return h.filter((v,i)=>v===a[i]).length / h.length;
  }

  function cohensKappa(h, a, categories) {
    const n = h.length;
    if (!n) return 0;

    const agreements = h.filter((v,i)=>v===a[i]).length;
    const Po = agreements / n;

    // Expected agreement
    let Pe = 0;
    for (const cat of categories) {
      const pH = h.filter(v=>v===cat).length / n;
      const pA = a.filter(v=>v===cat).length / n;
      Pe += pH * pA;
    }

    if (Pe >= 1) return 1;
    return (Po - Pe) / (1 - Pe);
  }

  function krippendorffAlpha(h, a) {
    // For 2 nominal raters
    const n = h.length;
    if (!n) return 0;

    const disagreements = h.filter((v,i)=>v!==a[i]).length;
    const Do = disagreements / n;

    // All codes combined
    const all = [...h, ...a];
    const N = all.length;

    const counts = {};
    all.forEach(v => counts[v] = (counts[v]||0) + 1);

    // Expected agreement (based on coincidence matrix)
    const expectedAgree = Object.values(counts)
      .reduce((s, nk) => s + nk*(nk-1), 0) / (N*(N-1));
    const De = 1 - expectedAgree;

    if (De === 0) return 1;
    return 1 - Do / De;
  }

  /* ── Helper views ────────────────────────────*/
  function agreementBreakdown(dualCoded, codebook) {
    const rows = codebook.map(dim => {
      const pairs = dualCoded.map(p=>({h:p.humanCodes?.[dim.id],a:(p.aiCodes?.[dim.id]||{}).code})).filter(p=>p.h&&p.a);
      const agree = pairs.filter(p=>p.h===p.a).length;
      const pct   = pairs.length ? Math.round(agree/pairs.length*100) : 0;
      return { name:dim.name, agree, total:pairs.length, pct };
    });

    return `<div style="display:flex;flex-direction:column;gap:10px">
      ${rows.map(r=>`
        <div>
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
            <span style="font-weight:500">${App.esc(r.name)}</span>
            <span style="color:var(--tx-second)">${r.agree}/${r.total} · <strong style="color:${r.pct>=80?'var(--success)':r.pct>=60?'var(--warning)':'var(--error)'}">${r.pct}%</strong></span>
          </div>
          <div class="progress-wrap"><div class="progress-bar" style="width:${r.pct}%;background:${r.pct>=80?'var(--success)':r.pct>=60?'var(--warning)':'var(--error)'}"></div></div>
        </div>`).join('')}
    </div>`;
  }

  function disagreementAnalysis(dualCoded, codebook) {
    const rows = [];
    codebook.forEach(dim => {
      dualCoded.forEach(p => {
        const h = p.humanCodes?.[dim.id];
        const a = (p.aiCodes?.[dim.id]||{}).code;
        if (h && a && h!==a) {
          const hLabel = dim.codes.find(c=>c.id===h)?.label || h;
          const aLabel = dim.codes.find(c=>c.id===a)?.label || a;
          rows.push({ dim:dim.name, human:hLabel, ai:aLabel });
        }
      });
    });

    if (!rows.length) return `<div class="text-muted" style="font-size:13px">No disagreements found — perfect agreement!</div>`;

    // Count patterns
    const patterns = {};
    rows.forEach(r => {
      const key = `${r.dim}:${r.human}→${r.ai}`;
      patterns[key] = (patterns[key]||{dim:r.dim, human:r.human, ai:r.ai, count:0});
      patterns[key].count++;
    });
    const sorted = Object.values(patterns).sort((a,b)=>b.count-a.count).slice(0,6);

    return `
      <div style="font-size:12.5px;color:var(--tx-second);margin-bottom:10px">Top disagreement patterns:</div>
      <div style="display:flex;flex-direction:column;gap:7px">
        ${sorted.map(p=>`
          <div style="display:flex;align-items:center;gap:8px;font-size:13px">
            <span class="badge badge-gray" style="font-size:11px">${App.esc(p.dim)}</span>
            <span class="code-chip human" style="font-size:11.5px">${App.esc(p.human)}</span>
            <span style="color:var(--tx-muted)">→</span>
            <span class="code-chip ai" style="font-size:11.5px">${App.esc(p.ai)}</span>
            <span style="margin-left:auto;font-weight:600;color:var(--tx-second)">${p.count}×</span>
          </div>`).join('')}
      </div>
      <div class="form-hint mt-2">${rows.length} total disagreements across all dimensions.</div>`;
  }

  /* ── Export ──────────────────────────────────*/
  function exportReport() {
    const stats = computeAll();
    if (!stats.length || stats.every(s=>s.n===0)) { App.notify('No reliability data to export', 'warning'); return; }
    const headers = ['dimension_id','dimension_name','n_pairs','pct_agreement','cohens_kappa','krippendorff_alpha','interpretation','benchmark'];
    const rows = stats.map(s=>[
      s.id, s.name, s.n,
      (s.pa*100).toFixed(2)+'%', s.kappa.toFixed(4), s.alpha.toFixed(4),
      s.interp,
      s.kappa >= 0.61 ? 'Acceptable for research' : s.kappa >= 0.41 ? 'Moderate — consider revisions' : 'Poor — codebook revision recommended'
    ]);
    App.downloadCSV('metacode_reliability_report.csv', headers, rows);
    App.notify('Reliability report downloaded', 'success');
  }

  /* ── Helpers ─────────────────────────────────*/
  function interpKappa(k) {
    if (k <= 0)    return 'Poor';
    if (k <= 0.20) return 'Slight';
    if (k <= 0.40) return 'Fair';
    if (k <= 0.60) return 'Moderate';
    if (k <= 0.80) return 'Substantial';
    return 'Near Perfect';
  }
  function interpBadge(k) {
    if (k > 0.60) return 'badge-green';
    if (k > 0.40) return 'badge-amber';
    return 'badge-red';
  }
  function ratingClass(v, type='pa') {
    if (type === 'kappa') {
      if (v >= 0.61) return 'text-success';
      if (v >= 0.41) return 'text-warning';
      return 'text-error';
    }
    if (v >= 0.80) return 'text-success';
    if (v >= 0.60) return 'text-warning';
    return 'text-error';
  }

  return { render, computeAll, computeOverall, showDim, exportReport };
})();
