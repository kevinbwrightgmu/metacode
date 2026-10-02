/* ══════════════════════════════════════════════
   assistant-knowledge.js — What the MetaCode Assistant knows about the app

   This text is sent to the AI provider as part of the assistant's
   instructions with EVERY chat message, so:
     • keep it accurate — update it whenever a page, button label or
       workflow changes (README.md describes the same features for people);
     • keep it compact — every character costs tokens on every message,
       and free-tier provider limits are counted in tokens per minute;
     • never put secrets in it.
   ══════════════════════════════════════════════ */

const MetaCodeKnowledge = `
ABOUT
MetaCode is a self-hosted tool for content analysis of social media data. Researchers import posts (plus optional engagement and network data), build a codebook, let AI auto-code the posts, hand-code some of the same posts, and measure human–AI intercoder reliability. It also runs social network analysis with Python NetworkX. Start it with \`npm start\` and open http://localhost:3000 (the landing page's "Launch MetaCode" opens the app). AI features need that server running. Project data is saved in the browser's localStorage (private/incognito windows lose it); only AI requests leave the computer.

NAVIGATION (left sidebar — use these exact names)
Project: Dashboard, Settings. Data: Import Data, Codebook. Analysis: AI Coding, Human Coding, Reliability. Visualize: Analyze CSV, Network Graph, Metrics. Then Export Data. The top bar shows the page title, an API status dot ("API connected"/"Not connected"), the project name and the "Ask MetaCode" button that opens this assistant.

WORKFLOW
Import Data → Codebook → AI Coding → Human Coding (code some of the same posts) → Reliability → Metrics / Analyze CSV / Network Graph → Export Data. The Dashboard shows Total Posts, AI Coded, Human Coded and Dual-Coded counts, a Quick Start checklist and a codebook summary.

PAGES
Settings: Project name and description (Save Project). AI Provider: Groq (free, no card; keys from console.groq.com) or Anthropic. API Keys: one per line; with several keys, requests rotate and retry on the next key when one is rate-limited (429) or invalid. Groq and Anthropic limit per account, so extra keys help only if they come from separate accounts. Keys can instead live in the server's .env file (GROQ_API_KEY / ANTHROPIC_API_KEY, comma-separated), which keeps them out of the browser. Fetch Models lists the models your keys can use. Model. Delay between calls (ms, default 500 — raise it if rate-limited). Save Settings. Test Connection. Key Rotation Status shows each masked key as Available, Cooling down or Invalid, with request counts. Danger Zone: Clear All Codes, Reset All Data (permanent).

Import Data — tabs Posts, Engagement, Network. Posts: drop or browse a CSV, or Load sample data (12 climate-policy posts). Columns: text, id, author, timestamp, likes, shares, comments, views; common alternatives are recognized (content, body, tweet, username, created_at, retweets, replies…). If no column is obviously the text, MetaCode asks the AI to identify the columns from the header and sample rows; if there is none, rows still import with blank text. Engagement tab: adds likes/shares/comments/views to existing posts by matching id. Network tab: nodes CSV (id, label, group, size) and edges CSV (source, target, weight, type), or Load sample network.

Codebook — "+ Add Dimension" (a coding question, e.g. Sentiment), then "+ Code" for each allowed answer. A code has a Code ID (short key used in exports, fixed after creation), Label, Description (shown to human coders and the AI) and AI Fine-Tuning Notes (read only by the AI; codes with notes show a violet dot). Use notes to correct recurring AI mistakes without changing what coders see. Import CSV (dimension_name, code_id, code_label; optional dimension_description, code_description, code_ai_notes) or Load example codebook (Sentiment, Policy Stance, Incivility, Primary Topic).

AI Coding — Run AI Coding codes every uncoded post in the current filter (All / Uncoded / Coded), one post at a time with the Settings delay. Stop pauses; Clear AI Codes resets. Per post: "Code this", Clear, and 💬 to read the AI's reasoning. Each code shows a confidence %. A failing post is tried up to 3 times, then skipped. Needs posts, a codebook and an API key.

Human Coding — click one code per dimension (saved immediately). "AI suggests" shows the AI's code with an Adopt link. Filter: All posts / Uncoded only / Human coded / Dual-coded. Auto-advance moves on once every dimension is coded; Save & Next; keys → or J (next post), ← or K (previous). Clear My Codes removes human codes.

Reliability — compares AI and human codes on dual-coded posts (needs at least 2). Shows overall agreement, Cohen's κ and Krippendorff's α, a Per-Dimension Reliability table, an Interpretation Guide, a Confusion Matrix (rows = human, columns = AI, diagonal = agreement), Agreement Summary and Disagreement Analysis (most common human→AI mismatches). Download Report saves a CSV.

Analyze CSV — upload any relationship CSV (mentions, replies, follows…). Source and target columns are auto-detected (source/target, from/to, follower/followee, sender/receiver, src/dst…) or identified by the AI; you can change the mapping, choose weight and node-label columns and tick "Directed graph". Run NetworkX Analysis needs Python with networkx (\`pip install -r requirements.txt\`); a banner shows whether it is ready. Results: Nodes, Edges, Density, Avg Degree, Components, Avg Clustering, Diameter, Communities; Most Central Nodes (Degree / Betweenness / Closeness / Eigenvector tabs, top 15); Detected Communities. Self-loops are skipped; duplicate edges have their weights summed. Above 500 nodes, closeness and eigenvector are skipped and betweenness is estimated by sampling. "Send to Network Graph" loads the result, colored by community.

Network Graph — force-directed graph: node size = number of connections, color = group or community, arrows show direction. Drag nodes, scroll to zoom, drag the background to pan, click a node for its degree and in/out edges, hover for a tooltip. Search node highlights matches; Link strength slider; Reset View; Toggle Labels. Export PNG (2× resolution) and Export SVG (vector; hover tooltips work when opened in a browser) both save the whole graph, not just the visible area.

Metrics — charts of the project: average likes, shares, comments and views; Code Distribution (AI) and (Human) for a chosen dimension; Avg Likes by AI Code and Avg Engagement by Human Code (need engagement data); AI vs Human Agreement by Dimension (% agreement; green ≥ 80%, amber ≥ 60%, red below); Coding Completion Status (AI only / Human only / Both / Uncoded). The coding charts need a codebook.

Export Data — CSV downloads: Coded Posts (Full), Reliability Report, Codebook (includes AI notes), Network Data (nodes + edges, Gephi-ready), Network Analysis (NetworkX) (summary + every node's centrality and community). Graph images come from Network Graph.

TERMS
Dimension = one coding question; code = one allowed answer; dual-coded = coded by both AI and a human. Percent agreement = matching pairs ÷ all pairs (ignores chance). Cohen's κ = (Po − Pe) / (1 − Pe): agreement corrected for chance. Krippendorff's α = 1 − Do/De (nominal data, two coders: AI and human). κ guide: ≤ 0 poor, 0.01–0.20 slight, 0.21–0.40 fair, 0.41–0.60 moderate, 0.61–0.80 substantial, 0.81–1 near perfect; κ ≥ 0.61 is the usual threshold for research. κ can be low despite high agreement when one code dominates. Density = share of all possible edges that exist. Degree centrality = share of other nodes a node connects to; betweenness = how often it sits on shortest paths between others (bridges); closeness = how near it is to everyone; eigenvector = connected to well-connected nodes. Avg clustering = how often a node's neighbors are connected. Components = disconnected parts; diameter and average path length use the largest one. Communities come from greedy modularity.

TROUBLESHOOTING
"Not connected" or "Enter your API key in Settings first": add a key in Settings, Save Settings, then Test Connection (or put it in .env and restart the server). Rate-limit (429) errors: wait, raise Delay between calls, or add a key from another account. Model errors: click Fetch Models and pick a listed model. AI Coding skipped posts: read the status line, then use "Code this". Reliability empty: needs at least 2 posts coded by both AI and a human. Metrics charts empty: build a codebook and code posts; engagement charts need likes/shares data. "NetworkX not available": run \`pip install -r requirements.txt\` and refresh. Network Graph blank: edge source/target values must match node ids — or use Analyze CSV. CSV problems: save as UTF-8 with a header row. Data gone: private windows clear localStorage; Reset All Data cannot be undone.
`;
