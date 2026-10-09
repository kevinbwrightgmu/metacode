// ── Selectors ─────────────────────────────────────────────────────────────────
// Every CSS selector and text pattern the extractor uses, in one place, so
// they can be updated when Reddit changes its markup. Each entry is a list
// tried in order: the first selector that finds something wins.
//
// Two Reddit front-ends are understood:
//  • "shreddit" — www.reddit.com: web components whose attributes carry the
//    data (<shreddit-post post-title="…" score="…">, <shreddit-comment
//    thingid="…" depth="…">), loaded with infinite scrolling;
//  • "old" — old.reddit.com: <div class="thing" data-fullname="…"
//    data-score="…">, paginated with a "next" link.
// When neither is recognised, a generic fallback reads any link to a post's
// comments page (/r/<sub>/comments/<id>/…).

export const SELECTORS = {
  shreddit: {
    /** Present on any www.reddit.com page rendered by shreddit. */
    marker: ['shreddit-app', 'shreddit-post', 'shreddit-comment', 'shreddit-feed'],
    post: ['shreddit-post'],
    /** Promoted posts: never collected. */
    ad: ['shreddit-ad-post'],
    title: ['[slot="title"]', 'a[slot="full-post-link"]', 'h1'],
    permalinkLink: ['a[slot="full-post-link"]', 'a[href*="/comments/"]'],
    body: ['[slot="text-body"]', '[property="schema:articleBody"]', '.md'],
    flair: ['shreddit-post-flair', '[slot="post-flair"]', 'flair-tag'],
    time: ['faceplate-timeago[ts]', 'time[datetime]'],
    comment: ['shreddit-comment'],
    commentBody: ['[slot="comment"]', '[id$="-comment-rtjson-content"]'],
    /** Elements that load more content when scrolled into view. */
    lazyLoader: ['faceplate-partial[loading="lazy"]', 'faceplate-partial', 'shreddit-loading']
  },
  old: {
    marker: ['#siteTable', 'body.listing-page', 'body.comments-page', '.thing[data-fullname]'],
    post: ['#siteTable > .thing.link[data-fullname]', '.thing.link[data-fullname]', '.search-result-link[data-fullname]'],
    title: ['a.title', '.search-title'],
    flair: ['.linkflairlabel', '.linkflair .flairrichtext', '.search-result-meta .linkflairlabel'],
    body: ['.expando .usertext-body .md', '.usertext-body .md'],
    next: ['.next-button a[href]', 'a[rel~="next"][href]'],
    comment: ['.commentarea .thing.comment[data-fullname]', '.thing.comment[data-fullname]'],
    /** The comment's own entry (not its replies). */
    commentEntry: [':scope > .entry'],
    commentBody: ['.usertext-body .md'],
    commentScore: ['.score.unvoted', '.score'],
    commentAuthor: ['a.author'],
    time: ['time[datetime]']
  },
  generic: {
    permalink: ['a[href*="/comments/"]'],
    pageTitle: ['h1']
  },
  /** Things that mean "Reddit didn't show the content". */
  denial: {
    captcha: ['iframe[src*="captcha"]', '.g-recaptcha', '.h-captcha', '[data-sitekey]', 'iframe[src*="challenges.cloudflare.com"]'],
    ageGateForm: ['form[action*="over18"]', 'shreddit-async-loader[bundlename*="nsfw"]', '[bundlename*="nsfw_blocking"]'],
    /** The page the collector's own proxy error hook renders (see browser/bridge.ts). */
    proxyError: ['meta[name="collector-proxy-error"]']
  }
} as const;

/** Text patterns for pages that aren't content. Checked against the page's title and visible text. */
export const PAGE_TEXT = {
  captcha: /verify (?:that )?you(?:'| a)re (?:a )?human|are you a robot|complete the (?:captcha|security check)|prove you(?:'| a)re not a (?:robot|bot)/i,
  blocked: /you've been blocked by network security|whoa there,? pardner|your request has been blocked|blocked due to (?:unusual|suspicious) activity/i,
  rateLimited: /too many requests|you(?:'| a)re doing that too much|rate.?limit(?:ed)?/i,
  loginRequired: /log ?in to (?:continue|view|see)|please log ?in|you must (?:be )?log(?:ged)? ?in/i,
  ageGate: /you must be (?:18|over 18)|are you over 18|mature content|over 18 only/i,
  quarantined: /quarantined/i,
  private: /(?:this community|r\/[A-Za-z0-9_]+) is private|private community/i,
  banned: /has been banned|banned from reddit/i,
  notFound: /page not found|nobody on reddit goes by that name|community not found|this community doesn't exist|there doesn't seem to be anything here|sorry, there aren't any communities/i,
  noResults: /no results? (?:found|for)|hm+[.…]* (?:we couldn't find|looks like) (?:any results|nothing)|no posts? (?:yet|found)|nothing (?:to see )?here/i
};

/** querySelector over a list of selectors; the first that matches wins. Invalid selectors are skipped. */
export function first(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const s of selectors) {
    try {
      const el = root.querySelector(s);
      if (el) return el;
    } catch { /* a selector the engine doesn't support */ }
  }
  return null;
}

/** querySelectorAll over a list of selectors; the first that finds anything wins. */
export function all(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const s of selectors) {
    try {
      const found = root.querySelectorAll(s);
      if (found.length) return Array.from(found);
    } catch { /* unsupported selector */ }
  }
  return [];
}

/**
 * Like `first`, but only matches that belong to `owner` itself — not to a
 * nested element of the same kind (e.g. a reply inside a comment).
 */
export function own(owner: Element, selectors: readonly string[], ownerSelector: string): Element | null {
  for (const s of selectors) {
    try {
      for (const el of Array.from(owner.querySelectorAll(s))) {
        if (el.closest(ownerSelector) === owner) return el;
      }
    } catch { /* unsupported selector */ }
  }
  return null;
}
