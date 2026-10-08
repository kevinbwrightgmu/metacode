/* ══════════════════════════════════════════════
   app-tour.js — the guided tour of the coding app (app.html)

   Walks through every page in the sidebar in workflow order, then offers the
   Survey Studio tour. Offered once on a first visit (a small card, bottom
   left); "Take the tour" in the sidebar replays it; app.html?tour=1 starts it.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';
  // Opens a page for a step (keeps the address bar in step, without history entries)
  function page(view) {
    return () => {
      if (App.getCurrentView().id === view) return;
      history.replaceState(null, '', '#' + view);
      App.navigate(view);
    };
  }

  Tour.define('app', [
    { title: 'Welcome to MetaCode',
      text: '<p>MetaCode helps you do <b>content analysis</b> of social media posts: you bring in posts, write a codebook, let AI code them, code some yourself, and check how well people and AI agree.</p>' +
            '<p>This tour shows each part of the platform in the order you\'d use it. It takes about two minutes — use <kbd>→</kbd> / <kbd>←</kbd> or the buttons, and <kbd>Esc</kbd> to stop.</p>' },
    { target: '#sidebar .sidebar-nav', placement: 'right',
      title: 'The sidebar: every page, in workflow order',
      text: '<p><b>Project</b> → <b>Data</b> → <b>Analysis</b> → <b>Visualize</b> → <b>Export</b>. Work top to bottom: each step uses what the one before produced.</p>' },
    { before: page('dashboard'), target: ['.dash-grid', '#view-container .stat-card', '.view-header'],
      title: 'Dashboard',
      text: '<p>Your project at a glance: how many posts you have, how many are coded by AI and by people, and a <b>Quick Start</b> checklist that ticks itself off as you go.</p>' },
    { before: page('projects'), target: ['#pj-current', '.view-header'],
      title: 'Projects — saved in your browser',
      text: '<p>Save the open project, keep several side by side, reopen or duplicate them, and export one as a file.</p>' +
            '<p>Everything you do in MetaCode is kept <b>in this browser</b>, private to you — other people using the same MetaCode server have their own projects.</p>' },
    { before: page('import'), target: ['#posts-drop', '#tab-content', '.view-header'],
      title: 'Import Data',
      text: '<p>Drop in a CSV of posts — MetaCode works out which column is the text, the author, the date and the engagement. Other tabs add engagement numbers and network data (who replies to whom).</p>' },
    { before: page('scraper'), target: ['.sc-modes', '.view-header'],
      title: 'Scraper — collect posts from Reddit',
      text: '<p><b>Standard scraper</b>: pick a subreddit, search, post or user, set limits, and start. <b>Custom code</b>: write a small Python or JavaScript scraper that runs in a safe sandbox.</p>' +
            '<p>When a job finishes, <b>Add to project</b> turns the results into posts ready to code.</p>' },
    { before: page('codebook'), target: ['#codebook-list', '#view-container .empty-state', '.view-header'],
      title: 'Codebook',
      text: '<p>Your coding scheme: <b>dimensions</b> (e.g. “Sentiment”) each with <b>codes</b> (“Positive”, “Negative”…) and descriptions. Clear descriptions make AI coding far more accurate.</p>' +
            '<p>“AI Fine-Tuning Notes” on a code give the AI extra guidance that human coders never see.</p>' },
    { before: page('ai-coding'), target: ['.coding-controls', '#view-container .empty-state', '.view-header'],
      title: 'AI Coding',
      text: '<p>The AI applies your codebook to every post and explains each choice (click 💬 on a coded post to read why).</p>' +
            '<p>The <b>at once</b> box sets how many copies of the model work side by side — more finishes sooner.</p>' },
    { before: page('human-coding'), target: ['#post-display', '#coding-panel', '#view-container .empty-state', '.view-header'],
      title: 'Human Coding',
      text: '<p>Code posts yourself, one at a time, with the same codebook — click a code for each dimension, then save and move on. The AI\'s suggestion is shown for reference, and can be adopted with one click.</p><p>Code at least some of the posts the AI coded, so the two can be compared under Reliability.</p>' },
    { before: page('reliability'), target: ['#view-container .card', '#view-container .empty-state', '.view-header'],
      title: 'Reliability',
      text: '<p>How often you and the AI agree, per dimension — percent agreement and <b>Cohen\'s kappa</b> (agreement beyond chance), plus a confusion matrix showing where you disagree.</p>' },
    { before: page('csv-analyzer'), target: ['#csvan-drop', '.view-header'],
      title: 'Analyze CSV',
      text: '<p>Drop any CSV of connections (who replied to, mentioned or shared whom) and get a network analysis from Python’s NetworkX: centrality, communities and the most influential accounts.</p>' },
    { before: page('network'), target: ['#network-svg', '#view-container .empty-state', '.view-header'],
      title: 'Network Graph',
      text: '<p>An interactive picture of the network: drag nodes, search for an account, and click one to see its connections. Nodes are coloured by their group.</p>' },
    { before: page('metrics'), target: ['#chart-dist-ai', '#view-container .card', '#view-container .empty-state', '.view-header'],
      title: 'Metrics',
      text: '<p>Charts of your results: every post\'s engagement (posts from the Scraper bring theirs), how often each code was used (by AI and by people), engagement per code, and where coders agree.</p>' },
    { before: page('export'), target: ['.export-grid', '#view-container .card', '.view-header'],
      title: 'Export Data',
      text: '<p>Download the coded posts, the reliability results, the codebook and the network as CSV or JSON for SPSS, R, Excel or a paper\'s appendix.</p>' },
    { before: page('settings'), target: ['#view-container .card:has(#s-env-status)', '#s-env-status', '#view-container .card'],
      title: 'Settings — AI connection and models',
      text: '<p>Shows whether AI is set up (the AI key in the server\'s <code>.env</code> file), lets you pick the AI model for each feature, and tests the connection.</p>' },
    { before: page('settings'), target: '#s-data-card',
      title: 'Your data',
      text: '<p>Because your work lives in this browser, download a <b>backup</b> now and then — and restore it to move to another browser or computer.</p>' },
    { target: '#asst-launcher', placement: 'bottom',
      title: 'Ask MetaCode',
      text: '<p>A help chat that knows the whole platform and your current project. Ask “How do I import a CSV?” or “What does kappa mean?” on any page.</p>' },
    { target: '#api-status', placement: 'bottom',
      title: 'AI status',
      text: '<p>Green means AI features are ready. If it says “AI not set up”, open Settings to see what\'s missing.</p>' },
    { target: '#sidebar-tour', placement: 'right',
      title: 'Take the tour again any time',
      text: '<p>This button replays the tour. Every page also has its own empty-state hints when there\'s nothing in it yet.</p>' },
    { before: page('dashboard'),
      title: 'One more thing: Survey Studio',
      text: '<p>MetaCode also has <b>Survey Studio</b>, on its own page: design surveys on a freeform canvas, add logic with Scratch-style blocks (including random assignment to conditions), publish a link and collect responses.</p>' +
            '<p>Its answers can come back here as posts to code.</p>',
      buttons: [{ label: 'Tour Survey Studio', onClick: () => { Tour.stop(); try { localStorage.setItem('metacode_tour_app', 'done'); } catch (e) { /* ignore */ } location.href = 'studio.html?tour=1'; } }] }
  ]);

  function startFromUrl() {
    const q = new URLSearchParams(location.search);
    if (!q.has('tour')) return false;
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => Tour.start('app'), 300);
    return true;
  }

  window.AppTour = {
    init() {
      const btn = document.getElementById('sidebar-tour');
      if (btn) btn.addEventListener('click', () => Tour.start('app'));
      if (!startFromUrl()) Tour.offerOnce('app', { title: 'New to MetaCode?', text: 'Take a two-minute tour of the whole platform — each page, what it\'s for, and the order to use them in.' });
    }
  };
})();
