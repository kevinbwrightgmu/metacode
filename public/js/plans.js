/* ══════════════════════════════════════════════
   plans.js — MetaCode's plans and what each one includes

   One table, used by the server (accounts/, which enforces it) and by the
   pages (account.js, which shows it), so what people see is what they get.

   Free  (an account, no subscription): AI coding up to 850 posts a week; no
         Survey Studio, no scraping, no network analysis.
   Pro   basic Survey Studio, a tightly limited Reddit Scraper, 2,300 posts.
   Max   full Survey Studio, near-unlimited scraping (custom code and the AI
         Scraper too), social network analysis, 4,000 posts.
   Ultra everything, with fair-use ceilings instead of limits.

   "Per week" means Monday to Sunday (the count resets Monday 00:00 UTC);
   "per month" the calendar month (UTC); "per day" the UTC day.
   Changing a number here changes it everywhere.
   ══════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MetaPlans = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ORDER = ['free', 'pro', 'max', 'ultra'];

  const PLANS = {
    free: {
      id: 'free', name: 'Free', rank: 0,
      tagline: 'Code and analyse your own data',
      features: { surveys: false, scraper: false, aiScraper: false, customCode: false, network: false, surveyAdvanced: false },
      limits: {
        aiPostsPerWeek: 850, aiRequestsPerDay: 40, aiRequestsPerMinute: 20, aiBatchesAtOnce: 1,
        scrapeJobsPerDay: 0, scrapeItemsPerJob: 0, scrapeItemsPerMonth: 0, scrapeJobsAtOnce: 0,
        publishedSurveys: 0, surveyResponsesPerMonth: 0,
        networkRunsPerDay: 0
      }
    },
    pro: {
      id: 'pro', name: 'Pro', rank: 1,
      tagline: 'Surveys and a first taste of scraping',
      features: { surveys: 'basic', scraper: true, aiScraper: false, customCode: false, network: false, surveyAdvanced: false },
      limits: {
        aiPostsPerWeek: 2300, aiRequestsPerDay: 150, aiRequestsPerMinute: 40, aiBatchesAtOnce: 2,
        scrapeJobsPerDay: 3, scrapeItemsPerJob: 100, scrapeItemsPerMonth: 1000, scrapeJobsAtOnce: 1,
        publishedSurveys: 3, surveyResponsesPerMonth: 300,
        networkRunsPerDay: 0
      }
    },
    max: {
      id: 'max', name: 'Max', rank: 2,
      tagline: 'Every method, for serious projects',
      features: { surveys: 'full', scraper: true, aiScraper: true, customCode: true, network: true, surveyAdvanced: true },
      limits: {
        aiPostsPerWeek: 4000, aiRequestsPerDay: 500, aiRequestsPerMinute: 80, aiBatchesAtOnce: 3,
        scrapeJobsPerDay: 100, scrapeItemsPerJob: 5000, scrapeItemsPerMonth: 100000, scrapeJobsAtOnce: 3,
        publishedSurveys: 25, surveyResponsesPerMonth: 5000,
        networkRunsPerDay: 100
      }
    },
    ultra: {
      id: 'ultra', name: 'Ultra', rank: 3,
      tagline: 'Unlimited, within fair use',
      features: { surveys: 'full', scraper: true, aiScraper: true, customCode: true, network: true, surveyAdvanced: true },
      limits: {
        aiPostsPerWeek: 100000, aiRequestsPerDay: 5000, aiRequestsPerMinute: 200, aiBatchesAtOnce: 6,
        scrapeJobsPerDay: 1000, scrapeItemsPerJob: 25000, scrapeItemsPerMonth: 2000000, scrapeJobsAtOnce: 5,
        publishedSurveys: 250, surveyResponsesPerMonth: 100000,
        networkRunsPerDay: 1000
      }
    }
  };

  // What each feature is called, and the lowest plan that has it
  const FEATURES = {
    surveys:        { label: 'Survey Studio' },
    surveyAdvanced: { label: 'IP address, location and session timelines in surveys' },
    scraper:        { label: 'the Reddit Scraper' },
    aiScraper:      { label: 'the AI Scraper' },
    customCode:     { label: 'custom scraper code' },
    network:        { label: 'social network analysis' }
  };

  // Usage counters and the limit each one is checked against
  const METERS = {
    aiPosts:         { limit: 'aiPostsPerWeek', period: 'week', label: 'Posts coded by the AI', unit: 'posts' },
    aiRequests:      { limit: 'aiRequestsPerDay', period: 'day', label: 'Other AI requests (assistant, column detection)', unit: 'requests' },
    scrapeJobs:      { limit: 'scrapeJobsPerDay', period: 'day', label: 'Scraper jobs', unit: 'jobs' },
    scrapeItems:     { limit: 'scrapeItemsPerMonth', period: 'month', label: 'Items scraped', unit: 'items' },
    surveyResponses: { limit: 'surveyResponsesPerMonth', period: 'month', label: 'Survey responses', unit: 'responses' },
    networkRuns:     { limit: 'networkRunsPerDay', period: 'day', label: 'Network analyses', unit: 'runs' }
  };

  // "this week", "today"… and how a period is said in a sentence
  const PERIODS = { month: { this: 'this month', a: 'a month' }, week: { this: 'this week', a: 'a week' }, day: { this: 'today', a: 'a day' } };
  const get = id => PLANS[id] || PLANS.free;
  const has = (planId, feature) => !!get(planId).features[feature];
  // The cheapest plan that includes a feature (or allows more than `atLeast` of a limit)
  function lowestWith(feature) { return ORDER.map(get).find(p => p.features[feature]) || null; }
  function lowestAbove(limit, atLeast) { return ORDER.map(get).find(p => p.limits[limit] > (atLeast || 0)) || null; }
  function namesFrom(planId) { const i = ORDER.indexOf(planId); return ORDER.slice(Math.max(0, i)).map(id => PLANS[id].name); }
  function listNames(names) { return names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]; }

  // The lines shown on each plan card
  function highlights(planId) {
    const p = get(planId), L = p.limits, f = p.features, n = v => Number(v).toLocaleString('en-US');
    const out = ['AI coding: ' + n(L.aiPostsPerWeek) + ' posts / week'];
    out.push(f.surveys === 'full' ? 'Survey Studio: full — ' + n(L.publishedSurveys) + ' live surveys, ' + n(L.surveyResponsesPerMonth) + ' responses / month'
      : f.surveys === 'basic' ? 'Survey Studio: basic — ' + n(L.publishedSurveys) + ' live surveys, ' + n(L.surveyResponsesPerMonth) + ' responses / month'
      : 'No Survey Studio');
    out.push(f.scraper ? 'Reddit Scraper: ' + n(L.scrapeJobsPerDay) + ' jobs / day, ' + n(L.scrapeItemsPerJob) + ' items / job, ' + n(L.scrapeItemsPerMonth) + ' / month' : 'No Reddit Scraper');
    if (f.aiScraper) out.push('AI Scraper and custom scraper code');
    out.push(f.network ? 'Social network analysis (NetworkX, Network Graph)' : 'No network analysis');
    return out;
  }

  return { ORDER, PLANS, FEATURES, METERS, PERIODS, get, has, lowestWith, lowestAbove, namesFrom, listNames, highlights };
});
