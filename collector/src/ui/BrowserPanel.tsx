// The live Scramjet browser: the bot works in this frame, and you can browse
// public Reddit pages in it between jobs.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserStatus, ScramjetBrowser } from '../browser/scramjet';
import { resolveBrowserInput, type Site } from '../lib/urls';

interface Props {
  browser: ScramjetBrowser;
  site: Site | null;
  /** A job is using the browser: manual navigation is off. */
  busy: boolean;
  /** Problem that keeps Scramjet from starting (server down, browser disabled). */
  blocker: string | null;
}

export function BrowserPanel({ browser, site, busy, blocker }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<BrowserStatus>(browser.getStatus());
  const [address, setAddress] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  useEffect(() => browser.subscribe(s => {
    setStatus(s);
    if (s.url) setAddress(s.url);
  }), [browser]);

  // Start Scramjet as soon as the server is known to allow it
  useEffect(() => {
    if (blocker || !site || !frameRef.current) return;
    let cancelled = false;
    browser.init(frameRef.current).then(() => {
      if (cancelled) return;
      setStarted(true);
      if (!browser.getStatus().url) browser.go(new URL('/', site.base).href);
    }).catch(() => { /* shown through the status */ });
    return () => { cancelled = true; };
  }, [browser, site, blocker]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!site) return;
    try {
      const url = resolveBrowserInput(address, site);
      setInputError(null);
      browser.go(url.href);
    } catch (err) {
      setInputError((err as Error).message);
    }
  }

  const ready = started && !busy && status.state !== 'initializing';
  const stateText = blocker ? blocker
    : status.state === 'initializing' ? 'Starting Scramjet (service worker, rewriter and Wisp transport)…'
    : status.state === 'loading' ? 'Loading through Scramjet…'
    : status.state === 'error' ? status.message
    : status.state === 'ready' ? (status.title || 'Ready') + (status.failedRequests ? ' · ' + status.failedRequests + ' resources didn\'t load (images or embeds outside Reddit)' : '')
    : 'Not started';

  return (
    <section className="card browser" aria-label="Reddit browser (Scramjet)">
      <div className="browser-head">
        <h2>Browser <span className="muted small">Scramjet</span></h2>
        <span className={'dot dot-' + (blocker ? 'error' : status.state)} aria-hidden="true" />
      </div>
      <form className="browser-bar" onSubmit={submit}>
        <button type="button" className="btn btn-icon" onClick={() => browser.back()} disabled={!ready} aria-label="Back" title="Back">‹</button>
        <button type="button" className="btn btn-icon" onClick={() => browser.forward()} disabled={!ready} aria-label="Forward" title="Forward">›</button>
        <button type="button" className="btn btn-icon" onClick={() => browser.reload()} disabled={!ready} aria-label="Reload" title="Reload">↻</button>
        <input className="input" value={address} onChange={e => setAddress(e.target.value)} disabled={!ready} aria-label="Reddit address"
          placeholder="r/technology or a Reddit link" spellCheck={false} autoComplete="off" />
        <button className="btn" type="submit" disabled={!ready}>Go</button>
      </form>
      {inputError ? <div className="field-error">{inputError}</div> : null}
      <div className={'browser-status' + (status.state === 'error' || blocker ? ' is-error' : '')} role="status" aria-live="polite">
        {busy ? <strong>The bot is using this browser. </strong> : null}{stateText}
      </div>
      {status.connection ? (
        <div className={'browser-conn' + (status.connection === 'http' ? ' is-relay' : '')} id="browser-connection">
          {status.connection === 'wisp' ? 'Connected through Wisp (WebSocket, end-to-end TLS).' : 'Connected through MetaCode\'s HTTP relay.'}
          {status.connectionNote ? <span className="muted"> {status.connectionNote}</span> : null}
        </div>
      ) : null}
      <div className="frame-wrap">
        <iframe ref={frameRef} id="collector-frame" title="Reddit through Scramjet" referrerPolicy="no-referrer" />
        {blocker ? <div className="frame-overlay">{blocker}</div> : null}
      </div>
      <p className="hint">Only public Reddit pages open here; login, account and message pages are blocked. Don't log in to Reddit in this frame.</p>
    </section>
  );
}
