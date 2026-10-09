// ── Page classification ───────────────────────────────────────────────────────
// Before extracting anything the bot asks: is this content, still loading,
// or something Reddit shows instead of content (a block page, a CAPTCHA, a
// login wall, an age check, a private or missing community)? The collector
// never tries to get past any of these: it stops that part of the job (or
// the whole job, for blocks and CAPTCHAs) and says why.

import { PAGE_TEXT, SELECTORS, first } from './selectors';
import { detectVariant, extractListing, extractPostPage } from './parse';

export type PageKind =
  | 'content' | 'empty' | 'proxy_error'
  | 'captcha' | 'blocked' | 'rate_limited'
  | 'login_required' | 'age_gate' | 'quarantined' | 'private' | 'banned' | 'not_found';

export interface PageStatus {
  kind: PageKind;
  /** What to tell the user. */
  message: string;
  /** Stop the whole job (Reddit is refusing this browser), not just this page. */
  stopJob: boolean;
  /** Worth loading again after a pause. */
  retryable: boolean;
}

const MESSAGES: Record<Exclude<PageKind, 'content' | 'empty'>, [string, boolean, boolean]> = {
  proxy_error:    ['The page couldn\'t be loaded through the MetaCode proxy.', false, true],
  captcha:        ['Reddit asked for a CAPTCHA / human check. The collector doesn\'t solve or bypass these, so the job stopped. Try again later, or use Reddit\'s API instead.', true, false],
  blocked:        ['Reddit blocked this browser\'s requests (block page). The job stopped; the collector doesn\'t work around blocks. Reddit often blocks server and data-centre addresses this way: use the Reddit API scraper (link at the top of MetaCode\'s Scraper page) with your own Reddit API keys.', true, false],
  rate_limited:   ['Reddit says there were too many requests. The job stopped; raise the page delay in Settings before trying again.', true, false],
  login_required: ['Reddit requires logging in to see this page. The collector only reads public pages and doesn\'t log in, so it was skipped.', false, false],
  age_gate:       ['This page is behind Reddit\'s 18+ check. The collector doesn\'t confirm age checks, so it was skipped.', false, false],
  quarantined:    ['This community is quarantined; Reddit requires opting in, which the collector doesn\'t do. It was skipped.', false, false],
  private:        ['This community is private, so it was skipped.', false, false],
  banned:         ['This community or account has been banned, so there is nothing to collect.', false, false],
  not_found:      ['Reddit says this page doesn\'t exist.', false, false]
};

function status(kind: PageKind, detail?: string): PageStatus {
  if (kind === 'content') return { kind, message: 'Content found.', stopJob: false, retryable: false };
  if (kind === 'empty') return { kind, message: detail || 'The page shows nothing to collect.', stopJob: false, retryable: false };
  const [message, stopJob, retryable] = MESSAGES[kind];
  return { kind, message: detail ? message + ' (' + detail + ')' : message, stopJob, retryable };
}

function visibleText(doc: Document): string {
  const body = doc.body;
  if (!body) return '';
  return (body.textContent || '').replace(/\s+/g, ' ').slice(0, 20000);
}

/**
 * What the page shows. `expect` is what the bot opened it for: a listing
 * (subreddit/search) or a single post's page.
 */
export function classifyPage(doc: Document, url: string, expect: 'listing' | 'post'): PageStatus {
  const proxyError = first(doc, SELECTORS.denial.proxyError);
  if (proxyError) return status('proxy_error', proxyError.getAttribute('content') || undefined);
  if (first(doc, SELECTORS.denial.captcha)) return status('captcha');

  const hasContent = expect === 'listing'
    ? extractListing(doc, url).posts.length > 0
    : extractPostPage(doc, url).post !== null && detectVariant(doc) !== 'generic';
  if (hasContent) return status('content');

  const text = (doc.title || '') + ' ' + visibleText(doc);
  if (PAGE_TEXT.captcha.test(text)) return status('captcha');
  if (PAGE_TEXT.blocked.test(text)) return status('blocked');
  if (PAGE_TEXT.rateLimited.test(text)) return status('rate_limited');
  if (first(doc, SELECTORS.denial.ageGateForm) || PAGE_TEXT.ageGate.test(text)) return status('age_gate');
  if (PAGE_TEXT.quarantined.test(text)) return status('quarantined');
  if (PAGE_TEXT.private.test(text)) return status('private');
  if (PAGE_TEXT.banned.test(text)) return status('banned');
  if (PAGE_TEXT.notFound.test(text)) return status('not_found');
  if (PAGE_TEXT.loginRequired.test(text)) return status('login_required');
  if (PAGE_TEXT.noResults.test(text)) return status('empty', 'Reddit shows no posts here.');
  return status('empty');
}
