# Shared projects (collaboration)

With accounts on (see [accounts.md](accounts.md)), the project open in MetaCode can be shared with other
MetaCode accounts. People with access work on the same project at the same time, see who else has it open,
get each other's changes as they happen and chat about it. Without accounts, nothing changes: the Share
button isn't shown and the `/api/collab` routes answer `403 sharing_unavailable`.

| | Owner | Editor | Viewer |
|---|:-:|:-:|:-:|
| Open and read the project | ✓ | ✓ | ✓ |
| Change it (posts, codes, codebook, network, name) | ✓ | ✓ | — |
| Chat | ✓ | ✓ | ✓ |
| Invite people, revoke invitations, change roles, remove people | ✓ | — | — |
| Delete the shared project | ✓ | — | — |
| Leave it | — (delete it instead) | ✓ | ✓ |

**The server decides.** Every `/api/collab` request is checked on the server against the account it is signed
in as (the `mc_session` cookie or a Bearer token, verified with Supabase) and the member list stored with the
project. The page only shows what the server allows. People who aren't members get `404` for everything about a
project, so its existence isn't revealed; members without the needed role get `403 forbidden`. A role change or
removal applies to the very next request, and the server also re-checks membership while a live connection is
open (every 20 seconds) and ends it on removal.

## Using it

- **Share** (top bar, or *Share…* on the Projects page) puts a copy of the open project on the server and makes
  you its owner. From then on the open project in your browser is linked to the shared one. Each post is shared
  under its id, so a post without one, or with an id an earlier post already has (a CSV whose id column repeats,
  say), gets a new id first — when you share and whenever such posts are added later. No post is left out.
- **Invite people** by email, as editors or viewers. MetaCode doesn't send email: you get a link for each person
  and send it yourself. A link
  - works for 14 days and once;
  - works only for the account with that email address, and only once the address is confirmed (an
    unconfirmed address could belong to anyone);
  - can be revoked. Inviting the same address again replaces its link (the old one stops working).

  The Share dialog keeps the links of everyone you invite while it's open (newest first), until an invitation is
  renewed or revoked. Only a hash of each link is stored, so copy them before closing it; to get a lost link
  again, invite the address again.

  People without an account open the link, create an account with that address, confirm it, and accept. The link
  that confirms a new account (or an emailed sign-in link) opens MetaCode's dashboard, not the invitation: the
  browser remembers an invitation opened before signing in (for a day) and shows it again once you're signed in.
- **Shared projects** on the Projects page lists the shared projects you belong to, with your role; *Open*
  replaces the open project in your browser with the shared one (saving or sending the current one first).
- **The top bar** shows the connection (*Live*, *Sending…*, *Reconnecting…*, *Offline*), who else has the
  project open, *View only* for viewers, how many conflicts wait for you, *Chat* (with unread messages) and
  *Share/People*.
- **Chat** keeps the project's messages on the server (the newest 5,000 per project), shown to everyone with
  access. Messages are plain text. A message that couldn't be sent can be retried; a retried message is never
  stored twice.
- **Removed, or the project deleted:** your browser says so, and the copy that was open stays open (unshared).
  Save it in Projects to keep it.
- **Save a private copy** (Projects page) keeps a copy in your browser that isn't shared.

## How changes are kept consistent

The shared copy is split into parts: the name and description (`meta`), each post with its codes (`post:<id>`),
the codebook, the network and the network analysis. The server stores the revision at which each part last
changed; every accepted batch of changes gets one new project revision.

1. Your browser keeps working on its own copy, as before (localStorage). About a second after a change it works
   out which parts changed since it last synced (a hash of each part) and sends only those, each with the
   revision it was made from (`POST /projects/:id/changes`).
2. The server applies a part only if nobody changed it since that revision. Otherwise it is a **conflict**: it is
   not applied, and the current version comes back. The other parts of the batch still apply.
3. Everyone else with the project open is told at once (`updated` event) and fetches what changed since the
   revision they have (`GET /projects/:id?since=<revision>`). A part they didn't change here is replaced; a part
   they also changed is a conflict.
4. **Conflicts are never resolved silently.** *Choose which version to keep* shows both versions, part by part:
   *Keep mine* sends yours as a change made from theirs (so it replaces theirs for everyone), *Use theirs*
   replaces yours. Until then, that part isn't sent.

Two people coding *different* posts, or one changing the codebook while another codes, never conflict. Posts are
updated in place in the browser, so pages that are open keep working with the current post. Overview pages
(Dashboard, Projects) redraw at once; on working pages (coding, codebook, network…) a *Show others' changes*
button appears instead, so nobody loses their place while they work.

**Offline:** changes stay in the browser and are sent when the server can be reached again (retries back off up
to a minute; the *Reconnect* button starts again). The browser's copy is always the working copy, so nothing is
lost if the page closes before a change is sent — it is sent the next time the project is opened.

**Viewers** can change their own browser's copy (for example to try something), but nothing is sent, the
server would refuse it anyway, and others' changes replace theirs. *Undo my changes here* puts the shared
version back.

## Limits

| | |
|---|---|
| Shared projects owned per account | 100 |
| People per project (members and open invitations) | 25 |
| Open invitations per project | 50 |
| Emails per invitation request | 20 |
| Chat messages per account and project | 30 per minute |
| Live connections per account and project (tabs) | 8 |
| Change requests per account | 240 per minute |
| Size of one request | 25 MB (bigger projects: share a smaller copy) |

## Server

- Code: `collab/index.js` (routes, roles, invitations, live events), `collab/store.js` (storage, change
  application). Mounted at `/api/collab` in `server.js`, which also refuses state-changing requests from other
  websites (the `Origin` / `Sec-Fetch-Site` check every MetaCode API uses).
- Storage: JSON files under `COLLAB_DATA_DIR` (default `collab-data/` next to `server.js`, gitignored), written
  to a temporary file and renamed into place, readable only by the server's user (`0600`). Changes to one project
  are applied one at a time (a per-project queue); a write that fails leaves the file as it was and the next
  request reads it again.
  - `projects/<id>.json` — the project: members, invitations (only a SHA-256 hash of each link's token), data,
    revisions
  - `chat/<id>.json` — its messages
  - `by-user/<hash of account id>.json` — which shared projects each account belongs to
  - `invites/<token hash>.json` — which project an invitation link is for
- Back up `COLLAB_DATA_DIR` like `SURVEY_DATA_DIR`. One MetaCode process should serve it (the per-project queue
  and the live connections are in that process's memory); for several processes, put a database with row
  locking behind `collab/store.js` and a shared message bus behind the live events.
- Live events are Server-Sent Events (`GET /api/collab/projects/:id/events`): `hello`, `presence`, `updated`,
  `chat`, `members`, `revoked`, `deleted`. Behind nginx, `proxy_buffering off` (as in
  [deploy-vps.md](deploy-vps.md)) — the server also sends `X-Accel-Buffering: no` — and a read timeout above
  20 seconds (the keep-alive interval).

## API

All routes need a signed-in account except `GET /config` and `GET /invites/:token`.

| Route | Who | |
|---|---|---|
| `GET /config` | anyone | `{ enabled, signedIn, roles, inviteDays, limits }` |
| `GET /projects` | signed in | the shared projects you belong to, with your role |
| `POST /projects` | signed in | `{ name, data }` → you own the shared copy; `skipped` counts posts that couldn't be shared (no usable or a repeated id; the page gives such posts new ids before sending) |
| `GET /projects/:id[?since=rev]` | viewer+ | the project, or the parts changed after `rev` (deleted posts come back as `null`) and the post order |
| `POST /projects/:id/changes` | editor+ | `{ changes: [{ key, baseRev, value }] }` → `{ revision, applied, conflicts: [{ key, rev, value }], invalid }` |
| `PATCH /projects/:id` | editor+ | `{ name }` |
| `DELETE /projects/:id` | owner | |
| `GET /projects/:id/members` | viewer+ | members, who is online; open invitations for the owner |
| `POST /projects/:id/invites` | owner | `{ emails, role }` → a result per address: `invited` / `renewed` (with the link), `already_member`, `self`, `invalid`, `limit` |
| `DELETE /projects/:id/invites/:inviteId` | owner | revoke |
| `PATCH /projects/:id/members/:userId` | owner | `{ role: 'editor' \| 'viewer' }` |
| `DELETE /projects/:id/members/:userId` | owner, or yourself | remove someone, or leave |
| `GET /invites/:token` | anyone with the link | project name, who invited, role, the masked address, status |
| `POST /invites/:token/accept` | the invited account | errors: `invite_wrong_account`, `email_unconfirmed`, `invite_expired`, `invite_used`, `invite_revoked`, `invite_not_found` |
| `GET /projects/:id/chat[?before=seq\|after=seq&limit=n]` | viewer+ | messages |
| `POST /projects/:id/chat` | viewer+ | `{ text, clientId }` (up to 2,000 characters; the same `clientId` is stored once) |
| `GET /projects/:id/events` | viewer+ | live events |

## Tests

- `test/collab.test.js` — the server with a stand-in Supabase: roles on every route, non-members, invitations
  (renewal, masking, expiry, single use, revocation, unconfirmed and wrong accounts, accounts created after the
  invitation), concurrent changes and conflicts, `?since` deltas, live events, chat (idempotency, history,
  limits), removal and deletion ending live connections, a live connection closed while it's being set up (it
  doesn't stay "open now"), limits, accounts off, requests from other websites.
- `test/collab-e2e.test.js` — three real browsers (owner, editor, viewer): share, invite, sign in from the link
  and accept, live edits, presence, a conflict on one post resolved in the dialog, chat (unread count, text
  never rendered as HTML), a viewer's edits not sent, removal; posts with repeated ids all shared, earlier
  invitation links kept in the dialog until renewed or revoked, and an invitation opened before signing in shown
  again after signing in from the dashboard.

The tests use a local stand-in for Supabase; they prove MetaCode's pages and server, not a live Supabase
project's configuration.

## Known limits

- Conflicts are detected per part: two people changing *different codes of the same post* at the same time is
  still a conflict (they choose which version of the post to keep). Merging inside a post isn't done.
- The same project open in two tabs of one browser shares one link record; it works, but the tabs may show a
  conflict between their own changes. Use one tab per project.
- Invitations are links you send yourself; MetaCode doesn't send email.
- AI settings, saved projects, surveys and scraper jobs aren't shared — only the open project's data.
