# Reddit Collector — data schema (version 1)

Every record is stored in the browser's IndexedDB (database `metacode-reddit-collector`) and
exported with exactly these fields. The TypeScript definitions are in `src/types.ts`.

**Conventions**

- A value Reddit didn't show is `null`. It is never guessed, and never turned into `0`: a
  score of `0` means the page showed 0, and `null` means no score was shown (for example, a
  hidden score or "Vote").
- Timestamps are ISO 8601 in UTC (`2026-10-01T12:34:56.123Z`).
- Ids are Reddit's base-36 ids without the `t3_`/`t1_` prefix. They are the deduplication
  keys: a post or comment seen again updates the same record.
- When a record is seen again, newer values replace older ones. A value the newer page
  didn't show (`null`) never erases one collected earlier. A post's full text read from its
  own page isn't replaced by a listing's shorter preview.
- Text is plain text (paragraphs separated by a blank line, list items as `- …`), up to
  100,000 characters. It is never HTML.

## Posts (`record_type: "post"`)

| Field | Type | Meaning |
|---|---|---|
| `record_type` | `"post"` | |
| `id` | string | Reddit's post id, e.g. `1abc23` |
| `fullname` | string | `t3_` + id |
| `url` | string | Canonical address: `https://www.reddit.com/r/<sub>/comments/<id>/<slug>/` |
| `subreddit` | string \| null | Name without `r/` |
| `title` | string \| null | |
| `body` | string \| null | The post's text; `null` for link/media posts, or when only a listing was read and it showed no text |
| `author` | string \| null | Username without `u/`; `[deleted]` is kept as shown; `null` when not displayed |
| `created_at` | string \| null | When the post was made |
| `score` | number \| null | Displayed score |
| `num_comments` | number \| null | Displayed comment count |
| `counts_approximate` | boolean | `true` when score or comment count came from a rounded display such as "1.2k" |
| `link_url` | string \| null | Where the post links (http/https only); `null` for text posts |
| `post_type` | string \| null | `text`, `link`, `image`, `video`, `gallery`, `poll`, `crosspost` or `other` |
| `flair` | string \| null | Post flair text |
| `over_18` | boolean \| null | `true` when marked NSFW; `null` when the page doesn't say |
| `details_collected` | boolean | Whether the post's own page was read (full text, exact details), not only a listing |
| `source_url` | string | The page the latest values were read from (shown on reddit.com, also when a test mirror was used) |
| `first_collected_at` | string | First time the collector saw the post |
| `collected_at` | string | Last time the collector saw the post |
| `job_ids` | string[] | Jobs that saw it |

## Comments (`record_type: "comment"`)

| Field | Type | Meaning |
|---|---|---|
| `record_type` | `"comment"` | |
| `id` | string | Reddit's comment id |
| `fullname` | string | `t1_` + id |
| `post_id` | string | The post's id |
| `parent_comment_id` | string \| null | The comment it replies to; `null` for a top-level comment |
| `subreddit` | string \| null | |
| `author` | string \| null | As displayed; `null` when not displayed (e.g. deleted comments on old Reddit) |
| `body` | string \| null | The comment's own text, not its replies' text; `[deleted]`/`[removed]` kept as shown |
| `created_at` | string \| null | |
| `score` | number \| null | Displayed score |
| `counts_approximate` | boolean | `true` when the score was a rounded display |
| `depth` | number \| null | `0` for top-level comments |
| `url` | string \| null | Canonical comment address, `https://www.reddit.com/r/<sub>/comments/<post>/comment/<id>/` |
| `source_url` | string | The post page it was read from |
| `first_collected_at` | string | |
| `collected_at` | string | |
| `job_ids` | string[] | |

## Jobs and errors (stored, not exported)

A job record keeps its definition (`config`), its final `state` (`completed`, `stopped` or
`failed`), its `outcome` message, start/finish times, counts (`stats`), and the robots.txt
decision made before it ran (`robots`: `checked`, `allowed`, `rule`, `policy`, `note`).
Collection errors are stored with their job id, time, page URL, kind (for example
`load_failed`, `private`, `blocked`) and message.

## Export files

**JSON**: one document.

```json
{
  "schema_version": 1,
  "exported_at": "2026-10-08T12:34:00.000Z",
  "scope": "all",
  "filter": null,
  "counts": { "posts": 7, "comments": 14 },
  "posts": [ { "record_type": "post", "id": "…", "…": "…" } ],
  "comments": [ { "record_type": "comment", "id": "…", "…": "…" } ]
}
```

`scope` is `all` (every record) or `filtered` (the records matching the Data view's filter,
which is then included under `filter`).

**JSON Lines** (`.jsonl`): one record per line, posts first, each with its `record_type`.

**CSV**: one file per record type, `…-posts.csv` and `…-comments.csv`. The columns are the
fields above, in the order listed. `job_ids` is written as `id1;id2`, booleans as
`true`/`false`, and `null` as an empty cell. Cells with commas, quotes or line breaks are
quoted; quotes are doubled. Text starting with `=`, `+`, `-` or `@` gets a leading `'` so
spreadsheets don't run it as a formula. Lines end with CRLF. Files are UTF-8, by default with
a byte-order mark (Settings → Exports).

All files are UTF-8. File names are `reddit-collector-YYYYMMDD-HHMM[-filtered].<ext>`, using
the UTC time of the export.
