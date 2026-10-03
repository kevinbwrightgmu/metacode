/* ══════════════════════════════════════════════
   data.js — Import posts, engagement, network data
   ══════════════════════════════════════════════ */

const DataManager = (() => {

  function render() {
    const container = document.getElementById('view-container');
    const { posts } = App.getState();

    container.innerHTML = `
      <div class="view-header">
        <div>
          <div class="view-title">Import Data</div>
          <div class="view-subtitle">Upload CSVs for posts, engagement, and social network data</div>
        </div>
        ${posts.length > 0 ? `<div class="view-actions">
          <button class="btn btn-secondary" onclick="DataManager.clearPosts()">Clear Posts</button>
        </div>` : ''}
      </div>

      <!-- Tabs -->
      <div style="display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:0">
        ${['posts','engagement','network'].map((t,i)=>`
          <button class="tab-btn ${i===0?'active':''}" data-tab="${t}"
            onclick="DataManager.switchTab('${t}')"
            style="padding:8px 18px;border:none;background:none;font-size:13.5px;font-weight:500;
              cursor:pointer;border-bottom:2px solid ${i===0?'var(--blue)':'transparent'};
              color:${i===0?'var(--blue)':'var(--tx-second)'};margin-bottom:-1px;transition:all .15s">
            ${t.charAt(0).toUpperCase()+t.slice(1)}
          </button>`).join('')}
      </div>

      <div id="tab-content"></div>
    `;

    renderPostsTab();
  }

  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.style.borderBottomColor = active ? 'var(--blue)' : 'transparent';
      btn.style.color = active ? 'var(--blue)' : 'var(--tx-second)';
    });
    if (tab === 'posts')      renderPostsTab();
    else if (tab === 'engagement') renderEngagementTab();
    else if (tab === 'network')    renderNetworkTab();
  }

  /* ── Posts ───────────────────────────────────*/
  function renderPostsTab() {
    const { posts } = App.getState();
    document.getElementById('tab-content').innerHTML = `
      <div class="card-grid card-grid-2" style="margin-bottom:20px">
        <div class="card">
          <div class="card-title">Upload Posts CSV</div>
          <div class="upload-zone" id="posts-drop" onclick="document.getElementById('posts-file').click()">
            <input type="file" id="posts-file" accept=".csv" onchange="DataManager.loadPostsFile(this)">
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            <div class="upload-title">Drop CSV file here or click to browse</div>
            <div class="upload-sub">Required column: <code>text</code> &nbsp;·&nbsp; Optional: <code>id, author, timestamp, likes, shares, comments, views</code></div>
          </div>
          <button class="btn btn-secondary btn-sm mt-2" onclick="DataManager.loadSamplePosts()">Load sample data</button>
        </div>
        <div class="card">
          <div class="card-title">Column Mapping Guide</div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Column</th><th>Description</th><th>Required</th></tr></thead>
              <tbody>
                ${[
                  ['text','The post/discussion text content','Yes'],
                  ['id','Unique identifier for each post','No (auto-generated)'],
                  ['author','Username or screen name','No'],
                  ['timestamp','Date/time of the post','No'],
                  ['likes','Number of likes/reactions','No'],
                  ['shares','Number of shares/retweets','No'],
                  ['comments','Number of comments/replies','No'],
                  ['views','Number of views/impressions','No']
                ].map(([col,desc,req])=>`
                  <tr>
                    <td><code style="font-family:var(--f-mono);font-size:12px">${col}</code></td>
                    <td style="font-size:13px">${desc}</td>
                    <td><span class="badge ${req==='Yes'?'badge-blue':'badge-gray'}">${req}</span></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      ${posts.length > 0 ? `
        <div class="post-table-wrap">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)">
            <div style="font-family:var(--f-display);font-weight:600;font-size:14px">${posts.length} posts loaded</div>
            <button class="btn btn-ghost btn-sm" onclick="DataManager.clearPosts()">Clear all</button>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>#</th><th>ID</th><th>Author</th><th>Text preview</th><th>Timestamp</th><th>Engagement</th></tr></thead>
              <tbody>
                ${posts.slice(0,50).map((p,i)=>`
                  <tr>
                    <td class="text-muted" style="font-size:12px">${i+1}</td>
                    <td><span class="font-mono" style="font-size:11.5px;color:var(--tx-muted)">${App.esc(p.id.slice(0,8))}</span></td>
                    <td style="font-weight:500">${App.esc(p.author||'—')}</td>
                    <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${App.esc(p.text)}</td>
                    <td style="font-size:12px;color:var(--tx-muted)">${App.esc(p.timestamp||'—')}</td>
                    <td style="font-size:12px">
                      ${p.engagement?.likes!=null?`❤ ${p.engagement.likes}`:''}
                      ${p.engagement?.shares!=null?` ↩ ${p.engagement.shares}`:''}
                      ${p.engagement?.comments!=null?` 💬 ${p.engagement.comments}`:''}
                    </td>
                  </tr>`).join('')}
                ${posts.length > 50 ? `<tr><td colspan="6" style="text-align:center;color:var(--tx-muted);font-size:13px">… and ${posts.length-50} more posts</td></tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>` :
        `<div class="empty-state">
          <div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
          <div class="empty-title">No posts imported</div>
          <div class="empty-sub">Upload a CSV file above or load the sample dataset to get started.</div>
        </div>`
      }
    `;
    setupDrop('posts-drop', f => loadPostsFile(null, f));
  }

  function loadPostsFile(input, file) {
    const f = file || input?.files?.[0];
    if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: async results => {
        const rows = results.data;
        if (!rows.length) { App.notify('CSV appears empty', 'error'); return; }

        const headers = Object.keys(rows[0]);

        // 1. Try heuristic column matching first — fast, no AI call needed
        let mapping = heuristicPostMapping(headers);

        // 2. Text column is NOT required. If heuristics found no text-like
        //    column by name, ask the AI to read the header + sample rows
        //    and infer the structure of the file itself.
        if (!mapping.text && App.hasApiKeys()) {
          App.notify('No obvious text column found — asking AI to read the file structure…', 'info');
          try {
            mapping = await aiPostMapping(headers, rows.slice(0, 5), mapping);
          } catch (e) {
            App.notify('AI structure detection failed (' + e.message + ') — importing without a text column', 'warning');
          }
        }

        const posts = buildPostsFromMapping(rows, mapping);

        if (!posts.length) {
          App.notify('No usable rows found in this CSV', 'error');
          return;
        }

        App.setState({ posts });

        if (!mapping.text) {
          App.notify(
            'Imported ' + posts.length + ' rows — no text column was found, so post text will show blank. ' +
            'Engagement and network features still work. Try the sidebar\'s "Analyze CSV" tool if this is a network/edge file.',
            'warning', 6000
          );
        } else {
          App.notify('Loaded ' + posts.length + ' posts', 'success');
        }

        renderPostsTab();
      },
      error: err => App.notify('CSV parse error: ' + err.message, 'error')
    });
  }

  // Fast, no-AI column matching using known synonym lists. Returns a mapping
  // object with the ORIGINAL header string for each detected role, or null
  // for roles with no match.
  function heuristicPostMapping(headers) {
    const norm = headers.map(h => h.toLowerCase().trim());
    const find = (...names) => {
      for (const n of names) {
        const idx = norm.indexOf(n);
        if (idx !== -1) return headers[idx];
      }
      return null;
    };
    return {
      text:      find('text','content','body','post','message','tweet','comment'),
      id:        find('id','post_id','postid'),
      author:    find('author','username','user','screen_name','name'),
      timestamp: find('timestamp','date','created_at','time','datetime'),
      likes:     find('likes','like_count','favorites','fav_count','hearts'),
      shares:    find('shares','share_count','retweets','retweet_count','rt_count'),
      comments:  find('comments','comment_count','replies','reply_count'),
      views:     find('views','view_count','impressions')
    };
  }

  // Asks the configured AI provider to read the CSV header + a few sample
  // rows and identify which column (if any) holds the main post text, plus
  // any other recognizable roles. AI-found columns override the heuristic
  // fallback only where the AI actually found something.
  async function aiPostMapping(headers, sampleRows, fallback) {
    const system =
      'You are a data analyst mapping spreadsheet columns to a known schema for social media research.\n' +
      'Given a CSV header row and sample rows, identify which column (if any) contains the MAIN free-text ' +
      'content of a social media post (e.g. the post body, tweet text, comment text), and map these other ' +
      'roles if present: id, author, timestamp, likes, shares, comments, views.\n' +
      'Respond with ONLY a JSON object, nothing else:\n' +
      '{"text":"<column or null>","id":"<column or null>","author":"<column or null>","timestamp":"<column or null>",' +
      '"likes":"<column or null>","shares":"<column or null>","comments":"<column or null>","views":"<column or null>",' +
      '"note":"<one short sentence>"}\n' +
      'Use exact column names from the header, case-sensitive as given. If a role has no matching column, use null. ' +
      'If NO column looks like free-text post content (e.g. this looks like a network edge list or purely numeric data), set "text" to null.';

    const user = 'Header: ' + JSON.stringify(headers) + '\nSample rows:\n' +
      sampleRows.map((r, i) => (i + 1) + '. ' + JSON.stringify(r)).join('\n');

    const raw    = await App.callClaude([{ role: 'user', content: user }], system, 400, { feature: 'import' });
    const parsed = App.extractJSON(raw);

    return {
      text:      parsed.text      || fallback.text,
      id:        parsed.id        || fallback.id,
      author:    parsed.author    || fallback.author,
      timestamp: parsed.timestamp || fallback.timestamp,
      likes:     parsed.likes     || fallback.likes,
      shares:    parsed.shares    || fallback.shares,
      comments:  parsed.comments  || fallback.comments,
      views:     parsed.views     || fallback.views
    };
  }

  // Builds post objects from parsed CSV rows using a resolved column mapping.
  // Text is optional — rows are only dropped if EVERY field is empty
  // (i.e. genuinely blank trailing CSV rows), never just for lacking text.
  function buildPostsFromMapping(rows, mapping) {
    const num = v => { const n = parseInt(v); return isNaN(n) ? null : n; };
    const get = (row, colName) => {
      if (!colName) return null;
      const val = row[colName];
      return (val != null && String(val).trim() !== '') ? String(val).trim() : null;
    };
    return rows.map(row => {
      const engagement = {
        likes:    num(get(row, mapping.likes)),
        shares:   num(get(row, mapping.shares)),
        comments: num(get(row, mapping.comments)),
        views:    num(get(row, mapping.views))
      };
      return {
        id:        get(row, mapping.id) || App.genId(),
        text:      get(row, mapping.text) || '',
        author:    get(row, mapping.author) || '',
        timestamp: get(row, mapping.timestamp) || '',
        engagement,
        humanCodes: {},
        aiCodes: {}
      };
    }).filter(p => {
      const hasEngagement = Object.values(p.engagement).some(v => v != null);
      return p.text || p.author || p.timestamp || hasEngagement;
    });
  }

  function loadSamplePosts() {
    const sample = [
      { id:'p1', text:'The new climate policy announced today is a huge step forward for renewable energy. We finally have leadership taking action!', author:'green_future', timestamp:'2024-01-15 09:23', engagement:{likes:342, shares:89, comments:67, views:4500} },
      { id:'p2', text:'This climate bill is going to destroy jobs. Our economy cannot afford these regulations. The data doesn\'t support the panic.', author:'realeconomics', timestamp:'2024-01-15 10:45', engagement:{likes:128, shares:212, comments:203, views:8900} },
      { id:'p3', text:'Can we please have a nuanced discussion about climate policy? Both extreme positions miss important trade-offs we need to consider.', author:'policy_wonk', timestamp:'2024-01-15 11:02', engagement:{likes:78, shares:34, comments:45, views:1200} },
      { id:'p4', text:'Scientists warn that the new policy still doesn\'t go far enough. We need more aggressive emission reductions to meet 2030 targets.', author:'dr_climatescience', timestamp:'2024-01-15 12:18', engagement:{likes:567, shares:234, comments:89, views:12000} },
      { id:'p5', text:'My family depends on the coal industry. Easy for politicians to make these decisions from their mansions.', author:'coalworker_wv', timestamp:'2024-01-15 13:30', engagement:{likes:89, shares:156, comments:312, views:6700} },
      { id:'p6', text:'The economic modeling in this new policy is flawed. Independent analysis shows costs 3x higher than official estimates.', author:'budget_analyst', timestamp:'2024-01-15 14:05', engagement:{likes:45, shares:67, comments:23, views:2100} },
      { id:'p7', text:'Young people are the ones who will live with these consequences. We support the policy 100% and urge faster implementation.', author:'youth4climate', timestamp:'2024-01-15 15:22', engagement:{likes:892, shares:445, comments:134, views:23000} },
      { id:'p8', text:'The policy includes important provisions for worker transition assistance. This is how you do just transition properly.', author:'laboradvocate', timestamp:'2024-01-15 16:45', engagement:{likes:234, shares:123, comments:56, views:5600} },
      { id:'p9', text:'Why are we trusting the same government that failed us in 2008? These regulations will be captured by industry anyway.', author:'skeptic99', timestamp:'2024-01-15 17:10', engagement:{likes:67, shares:89, comments:145, views:3400} },
      { id:'p10', text:'Breaking: International community responds positively to the new climate initiative. Three major nations signal support.', author:'globalnews', timestamp:'2024-01-15 18:00', engagement:{likes:1234, shares:678, comments:89, views:45000} },
      { id:'p11', text:'Just read the full 200-page policy document. Here are the 5 things media is getting wrong about it. Thread 🧵', author:'policy_thread', timestamp:'2024-01-15 18:45', engagement:{likes:3456, shares:2345, comments:234, views:89000} },
      { id:'p12', text:'Peaceful protest outside the capitol today. Hundreds gather to demand faster action on climate. Proud to be here.', author:'activist_now', timestamp:'2024-01-15 19:20', engagement:{likes:456, shares:234, comments:67, views:12000} }
    ].map(p => ({ ...p, aiCodes:{}, humanCodes:{} }));

    App.setState({ posts: sample });
    App.notify('Loaded 12 sample posts', 'success');
    renderPostsTab();
  }

  function clearPosts() {
    if (!confirm('Remove all posts? This also clears all coding results.')) return;
    App.setState({ posts: [] });
    App.notify('Posts cleared', 'warning');
    renderPostsTab();
  }

  /* ── Engagement ──────────────────────────────*/
  function renderEngagementTab() {
    document.getElementById('tab-content').innerHTML = `
      <div class="card-grid card-grid-2">
        <div class="card">
          <div class="card-title">Update Engagement Data</div>
          <div class="upload-zone" onclick="document.getElementById('eng-file').click()">
            <input type="file" id="eng-file" accept=".csv" onchange="DataManager.loadEngagementFile(this)">
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            <div class="upload-title">Upload engagement CSV</div>
            <div class="upload-sub">Required: <code>id</code> &nbsp;·&nbsp; Optional: <code>likes, shares, comments, views</code></div>
          </div>
          <div class="form-hint mt-2">Merges engagement data into existing posts by matching the <code>id</code> column.</div>
        </div>
        <div class="card">
          <div class="card-title">Engagement Summary</div>
          ${engagementSummary()}
        </div>
      </div>
    `;
  }

  function engagementSummary() {
    const posts = App.getState().posts;
    if (!posts.length) return '<div class="text-muted" style="font-size:13px">No posts loaded yet.</div>';
    const withEng = posts.filter(p => p.engagement?.likes != null || p.engagement?.shares != null);
    if (!withEng.length) return '<div class="text-muted" style="font-size:13px">No engagement data in current posts.</div>';
    const sum = k => withEng.reduce((s,p)=>s+(p.engagement?.[k]||0),0);
    const avg = k => (sum(k)/withEng.length).toFixed(1);
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${[['Likes','likes','❤️'],['Shares','shares','↩️'],['Comments','comments','💬'],['Views','views','👁️']].map(([label,key,icon])=>`
          <div style="background:var(--bg-muted);border-radius:var(--r-md);padding:12px">
            <div style="font-size:18px;margin-bottom:2px">${icon}</div>
            <div style="font-family:var(--f-display);font-weight:700;font-size:20px">${avg(key)}</div>
            <div style="font-size:12px;color:var(--tx-muted)">avg ${label}</div>
          </div>`).join('')}
      </div>
      <div class="form-hint mt-2">${withEng.length} of ${posts.length} posts have engagement data.</div>
    `;
  }

  function loadEngagementFile(input) {
    const f = input?.files?.[0];
    if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: results => {
        const lookup = {};
        results.data.forEach(row => {
          const id = Object.keys(row).find(k=>k.toLowerCase()==='id');
          if (id && row[id]) lookup[row[id].trim()] = row;
        });
        const num = v => { const n=parseInt(v); return isNaN(n)?null:n; };
        let updated = 0;
        const posts = App.getState().posts.map(p => {
          const row = lookup[p.id];
          if (!row) return p;
          updated++;
          const get = k => { const key=Object.keys(row).find(r=>r.toLowerCase()===k); return key?row[key]:null; };
          return { ...p, engagement: {
            likes:    num(get('likes'))    ?? p.engagement?.likes,
            shares:   num(get('shares'))   ?? p.engagement?.shares,
            comments: num(get('comments')) ?? p.engagement?.comments,
            views:    num(get('views'))    ?? p.engagement?.views
          }};
        });
        App.setState({ posts });
        App.notify(`Updated engagement for ${updated} posts`, 'success');
        renderEngagementTab();
      }
    });
  }

  /* ── Network ─────────────────────────────────*/
  function renderNetworkTab() {
    const { network } = App.getState();
    document.getElementById('tab-content').innerHTML = `
      <div class="card-grid card-grid-2" style="margin-bottom:20px">
        <div class="card">
          <div class="card-title">Upload Network Nodes</div>
          <div class="upload-zone" onclick="document.getElementById('nodes-file').click()">
            <input type="file" id="nodes-file" accept=".csv" onchange="DataManager.loadNodesFile(this)">
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/></svg>
            <div class="upload-title">Upload nodes CSV</div>
            <div class="upload-sub">Required: <code>id</code> &nbsp;·&nbsp; Optional: <code>label, group, size</code></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Upload Network Edges</div>
          <div class="upload-zone" onclick="document.getElementById('edges-file').click()">
            <input type="file" id="edges-file" accept=".csv" onchange="DataManager.loadEdgesFile(this)">
            <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="19" x2="19" y2="5"/></svg>
            <div class="upload-title">Upload edges CSV</div>
            <div class="upload-sub">Required: <code>source, target</code> &nbsp;·&nbsp; Optional: <code>weight, type</code></div>
          </div>
        </div>
      </div>
      <div class="card-grid card-grid-2">
        <div class="card">
          <div class="card-title">Network Summary</div>
          ${network.nodes.length > 0
            ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div style="background:var(--bg-muted);border-radius:var(--r-md);padding:16px;text-align:center">
                  <div style="font-family:var(--f-display);font-weight:700;font-size:28px">${network.nodes.length}</div>
                  <div style="font-size:13px;color:var(--tx-muted)">Nodes</div>
                </div>
                <div style="background:var(--bg-muted);border-radius:var(--r-md);padding:16px;text-align:center">
                  <div style="font-family:var(--f-display);font-weight:700;font-size:28px">${network.edges.length}</div>
                  <div style="font-size:13px;color:var(--tx-muted)">Edges</div>
                </div>
               </div>
               <button class="btn btn-secondary btn-sm mt-3" onclick="DataManager.clearNetwork()">Clear network</button>`
            : `<div class="text-muted" style="font-size:13px">No network data loaded.</div>`}
        </div>
        <div class="card">
          <div class="card-title">Load Sample Network</div>
          <div style="font-size:13px;color:var(--tx-second);margin-bottom:12px">
            Load a 20-node demonstration network representing a social discussion community.
          </div>
          <button class="btn btn-secondary" onclick="DataManager.loadSampleNetwork()">Load sample network</button>
        </div>
      </div>
    `;
  }

  function loadNodesFile(input) {
    const f = input?.files?.[0];
    if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: results => {
        const nodes = results.data.map(row => {
          const get = k => { const key=Object.keys(row).find(r=>r.toLowerCase()===k); return key?row[key]?.trim():null; };
          return { id: get('id')||App.genId(), label: get('label')||get('name')||get('id')||'?', group: get('group')||get('community')||'1', size: parseFloat(get('size'))||10 };
        }).filter(n=>n.id);
        const net = App.getState().network;
        App.setState({ network: { ...net, nodes } });
        App.notify(`Loaded ${nodes.length} nodes`, 'success');
        renderNetworkTab();
      }
    });
  }

  function loadEdgesFile(input) {
    const f = input?.files?.[0];
    if (!f) return;
    Papa.parse(f, {
      header: true, skipEmptyLines: true,
      complete: results => {
        const edges = results.data.map(row => {
          const get = k => { const key=Object.keys(row).find(r=>r.toLowerCase()===k); return key?row[key]?.trim():null; };
          return { source: get('source')||get('from'), target: get('target')||get('to'), weight: parseFloat(get('weight'))||1, type: get('type')||'' };
        }).filter(e=>e.source&&e.target);
        const net = App.getState().network;
        App.setState({ network: { ...net, edges } });
        App.notify(`Loaded ${edges.length} edges`, 'success');
        renderNetworkTab();
      }
    });
  }

  function loadSampleNetwork() {
    const nodes = [
      {id:'u1',label:'@climate_hawk',group:'1',size:18},{id:'u2',label:'@realskeptic',group:'2',size:15},
      {id:'u3',label:'@policy_wonk',group:'3',size:12},{id:'u4',label:'@globalnews',group:'4',size:22},
      {id:'u5',label:'@youth4climate',group:'1',size:16},{id:'u6',label:'@coalworker',group:'2',size:10},
      {id:'u7',label:'@laboradvocate',group:'3',size:11},{id:'u8',label:'@budget_analyst',group:'2',size:9},
      {id:'u9',label:'@activist_now',group:'1',size:13},{id:'u10',label:'@green_future',group:'1',size:14},
      {id:'u11',label:'@dr_science',group:'3',size:17},{id:'u12',label:'@media_watch',group:'4',size:12},
      {id:'u13',label:'@econ_prof',group:'2',size:11},{id:'u14',label:'@community_org',group:'1',size:10},
      {id:'u15',label:'@moderator',group:'3',size:8},{id:'u16',label:'@policy_lead',group:'3',size:20},
      {id:'u17',label:'@industry_rep',group:'2',size:13},{id:'u18',label:'@journalist',group:'4',size:15},
      {id:'u19',label:'@localvoice',group:'1',size:9},{id:'u20',label:'@factchecker',group:'4',size:11}
    ];
    const edges = [
      {source:'u1',target:'u5',weight:5},{source:'u1',target:'u9',weight:4},{source:'u1',target:'u10',weight:6},
      {source:'u2',target:'u6',weight:3},{source:'u2',target:'u8',weight:4},{source:'u2',target:'u13',weight:5},
      {source:'u3',target:'u7',weight:4},{source:'u3',target:'u11',weight:6},{source:'u3',target:'u15',weight:3},
      {source:'u4',target:'u18',weight:7},{source:'u4',target:'u12',weight:5},{source:'u4',target:'u20',weight:4},
      {source:'u16',target:'u3',weight:8},{source:'u16',target:'u11',weight:6},{source:'u16',target:'u4',weight:5},
      {source:'u1',target:'u2',weight:2},{source:'u3',target:'u2',weight:3},{source:'u11',target:'u2',weight:2},
      {source:'u5',target:'u14',weight:4},{source:'u9',target:'u19',weight:3},{source:'u17',target:'u2',weight:5},
      {source:'u17',target:'u13',weight:4},{source:'u18',target:'u20',weight:6},{source:'u7',target:'u14',weight:3}
    ];
    App.setState({ network: { nodes, edges } });
    App.notify('Sample network loaded (20 nodes, 24 edges)', 'success');
    renderNetworkTab();
  }

  function clearNetwork() {
    if (!confirm('Clear network data?')) return;
    App.setState({ network: { nodes:[], edges:[] } });
    App.notify('Network cleared', 'warning');
    renderNetworkTab();
  }

  /* ── Drag & drop setup ───────────────────────*/
  function setupDrop(zoneId, callback) {
    const zone = document.getElementById(zoneId);
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) callback(file);
    });
  }

  return { render, switchTab, loadPostsFile, loadSamplePosts, clearPosts,
           loadEngagementFile, loadNodesFile, loadEdgesFile,
           loadSampleNetwork, clearNetwork };
})();
