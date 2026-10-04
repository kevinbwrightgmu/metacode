# Survey Studio

Survey Studio is MetaCode's survey builder. It has its own page, `studio.html`: open it from the front page
with **Open Survey Studio**. You design a survey on a freeform canvas, build its logic from Scratch-style
blocks, preview it on different devices, publish it to a public link, and collect responses.

It is separate from the coding app (`app.html`) and does not change it. Open-text answers can be sent to your
MetaCode project in this browser with **Add text answers to project**, so you can code them there.

The design goal is that **everything is editable**. A survey is a tree of elements. A single answer
choice, its radio dot, its label, a matrix row and a navigation button are all separate elements. Each one
has its own:

- position, size, rotation, scale, skew, origin and perspective;
- appearance, typography and effects;
- interaction states;
- behaviour, accessibility, animation and responsive settings.

---

## Contents

1. [Quick tour](#quick-tour)
2. [The canvas](#the-canvas)
3. [Elements](#elements)
4. [Properties inspector](#properties-inspector)
5. [Theme and inheritance](#theme-and-inheritance)
6. [Components, saved styles and templates](#components-saved-styles-and-templates)
7. [Logic](#logic)
8. [Preview](#preview)
9. [Saving, versions and publishing](#saving-versions-and-publishing)
10. [Responses](#responses)
11. [Keyboard shortcuts](#keyboard-shortcuts)
12. [Data model](#data-model)
13. [Server API](#server-api)
14. [Security](#security)
15. [Configuration](#configuration)
16. [Limitations](#limitations)
17. [File map](#file-map)

---

## Quick tour

1. On the front page, click **Open Survey Studio**. Pick **New survey** or one of the templates: Customer
   feedback, Research study, Event registration or Scored quiz. The logo at the top left goes back to the
   front page.
2. Click an item in the **Add** palette on the left, for example **Single choice**. It appears on the page,
   already selected.
3. Click the question to select it. **Double-click** to go inside it, for example to select one answer.
   Double-click a text to edit it in place.
4. Change anything in the **inspector** on the right. *Basic* shows the common settings; *All* shows every
   setting.
5. Open the **Logic** tab and snap blocks together to show, hide, skip or calculate things.
6. Use **Preview** to answer the survey yourself (desktop, tablet or mobile) and watch the test panel.
7. **Publish**. You get a link like `http://your-server:3000/s/AbC123…`. Responses appear under
   **Responses**.

Changes autosave. The status next to the title reads *Saving…*, *Saved* or *Unsaved changes*. **Ctrl+S**
saves immediately.

## The canvas

- **Select:** click to select; **Shift-click** to add to the selection; drag on empty space to draw a
  marquee. **Ctrl-click** selects the deepest element under the pointer. **Enter** goes to a child and
  **Esc** goes back to the parent.
- **Move:** drag to move. The behaviour depends on where the element lives:
  - Free-positioned elements move anywhere, snapping to the grid, the page edges and other elements, with
    guides.
  - In a stacked or grid layout, dragging reorders.
  - Dragging a stacked element outside its parent pulls it out and makes it free-positioned.
  - **Alt-drag** duplicates while dragging.
- **Handles:**
  - Eight resize handles. **Shift** keeps proportions; **Alt** resizes from the centre. Resizing a rotated
    element keeps the opposite corner fixed.
  - A rotation handle. **Shift** snaps to 15°.
  - The **K** (scale) tool turns the handles into scale handles.
- **Tools:**
  - **V** select, **H** hand.
  - **T** draws a text, **R** a shape, **F** a container.
  - **Q** adds a question.
- **View:**
  - Zoom with Ctrl + wheel, pinch, or the zoom menu. **Fit** and **Fit width** are in the toolbar.
  - **Space + drag** pans.
  - The grid and snapping can be turned on or off in the toolbar.
- **Arrange:**
  - The toolbar aligns (left, centre, right, top, middle, bottom) and distributes.
  - Group with **Ctrl+G** and ungroup with **Ctrl+Shift+G**.
  - Bring forward or send backward.
  - Lock and hide.
- **Clipboard:**
  - Copy, cut and paste work inside a survey and between surveys, including other browser tabs.
  - **Ctrl+Alt+C / V** copies and pastes only the style.
  - Pasted or duplicated answers get their own stored values.
- **Undo/redo:** every change can be undone, including theme and logic changes. Continuous edits, such as a
  drag or scrubbing a number, count as one step.
- **Right-click** opens a context menu with the same commands.
- **Layers** (left panel) shows each page and the element tree:
  - rename with a double-click;
  - hide and lock;
  - drag to reorder or to move into another container;
  - arrow keys to move between rows.
- **Pages** (bar under the canvas): add, rename, duplicate, reorder and delete pages. **Tidy page** stacks
  free elements neatly.

## Elements

| Category | Elements |
|---|---|
| Text | Heading, Paragraph, Label, Rich text, Instructions, Caption |
| Questions | Single choice, Multiple choice, Yes / No, Rating, Likert scale, Dropdown, Short text, Long text, Number, Slider, Date, Time, Ranking, Matrix / grid |
| Media | Image (upload or URL), Video (YouTube/Vimeo/file URL), Audio, Embedded content |
| Layout | Container, Group, Section, Divider, Spacer, Tabs, Shape |
| Interactive | Button, Progress bar |

### What a question is made of

A question is a container made of editable parts:

- title, optional description and error message;
- the choices or field;
- for choice questions, one **option** element per answer, each holding an **indicator** (radio, check,
  star…) and a **label**.

Matrices are made of rows. Ranking questions are made of rank items. Tabs are made of panels.

Containers lay out their children in one of three modes:

- **Free:** absolute positions.
- **Stack:** a vertical or horizontal flow, with gap, alignment and wrap.
- **Grid:** columns.

## Properties inspector

The inspector shows the settings that apply to the selected element. Sections:

- **Content:** text, options, media, rating count and so on.
- **Layout:** layout mode, gap, alignment, padding.
- **Transform:** X/Y, width/height (number, *fill* or *auto*), rotation, scale X/Y, skew, origin,
  perspective, 3D rotation and 4-corner distortion.
- **Appearance:** fill (colour, gradient or image), border, radius, opacity, blend, clip shape, mask.
- **Typography:** font, size, weight, line height, letter spacing, alignment, transform, decoration.
- **Spacing**, **Effects** (shadows, blur, filters, backdrop blur).
- **States:** hover, focus, pressed, checked and disabled overrides. *Show on canvas* previews a state while
  you edit it.
- **Behaviour & validation:** required, answer key, default, minimum/maximum, length, format (email, URL,
  phone, pattern), custom messages, scores, *initially hidden*.
- **Animation:** entrance and loop animations with duration, delay and easing.
- **Accessibility:** label, description, role, tab order, *hide from screen readers*.
- **Responsive:** hide on narrow or wide screens; overrides for narrow screens.
- **Advanced:** custom CSS for this element (sanitised) and the element's raw JSON.

### Number fields

- Drag the label to scrub the value.
- Arithmetic works, for example `120+24` or `*2`.
- Arrow keys step by 1; with **Shift**, by 10.

### Inherited and overridden values

A value you set yourself is shown as **overridden**, with a reset button. A value the element inherits is
shown greyed, together with the place it comes from.

## Theme and inheritance

The **Theme** tab edits:

- **Tokens:** the colours, fonts, radius and spacing used everywhere. The defaults are MetaCode's own
  palette and fonts.
- **Element defaults:** the default style for each element type, for example every option or every
  question title.
- **Survey settings:** page width, the background behind the page, responsive mode (*reflow* or *scale*),
  progress bar, button labels, completion title and message (formulas allowed), and whether respondents
  can go back.
- **Theme JSON:** for copying a theme between surveys.

An element's style is resolved in this order: the built-in style of its type, then the theme default for
that type, then the element's own overrides. Colours can refer to tokens, so changing **primary** recolours
everything that uses it.

## Components, saved styles and templates

The **Library** tab (left panel) holds three things:

- **Components:** save any selection as a reusable component. It appears in the palette for every survey.
- **Saved styles:** save an element's style under a name and apply it to other elements with one click.
- **Style clipboard:** the style you last copied with **Ctrl+Alt+C**.

The library is stored on the server, so it is shared by every survey.

## Logic

The **Logic** tab is block coding, like Scratch. Drag blocks from the palette on the left onto the
workspace and snap them together into **scripts**. For example:

```
when leaving page [1. Consent ▾]
if < (answer to [Do you agree…? ▾]) = [No ▾] > then
    end survey saying [Thank you for your time.]
else
    show [About you ▾]
```

### Block categories

| Category | Colour | Blocks |
|---|---|---|
| Events | yellow | Hat blocks that start a script: *when any answer changes*, *when page … opens*, *when leaving page …*, *when … is clicked* (a button), *when the survey is submitted* |
| Control | orange | *if ⟨ ⟩ then* and *if ⟨ ⟩ then … else*. They hold other blocks and can be nested |
| Random | indigo | *when the survey starts*, *assign [condition ▾] [at random ▾ / balanced] to one of [A] [B] +*, *pick one of [2 ▾] at random* (a C-block with one mouth per option), ⟨*chance [50] %*⟩, ⟨*(condition) = A*⟩, *(random number from 1 to 10)*, *shuffle the choices of …*. See [Randomization](#randomization) |
| Looks | purple | *show* / *hide* / *enable* / *disable* an element, *make … required* / *optional*, *set text of … to …*, *set [fill ▾] of … to …* (conditional styling), *show message* |
| Pages | blue | *go to page*, *go to next page*, *go back a page*, *skip page*, *include page*, *submit the survey*, *end survey saying …*, *open link* |
| Answers | teal | *(answer to …)*, ⟨*(answer to …) is answered*⟩, ⟨*(answer to …) = …*⟩, *(score)*, *(page number)*, *set answer of … to …* |
| Operators | green | ⟨*( ) = ( )*⟩ and the other comparisons (≠ > ≥ < ≤ contains, is answered), ⟨*and*⟩, ⟨*or*⟩, ⟨*not*⟩, *( ) + ( )* (and − × ÷ mod min max), *join*, *round*, *(formula …)*, ⟨*formula …*⟩ |
| Variables | pink | **Make a variable**, then a reporter for each variable, *set … to ( )* and *change … by ( )* |

Block shapes show where they fit, as in Scratch:

- **Hat blocks** start a script.
- **Stack blocks** snap above and below each other.
- **C-blocks** wrap a stack.
- **Hexagonal** blocks are true/false conditions; they go in hexagonal slots.
- **Round** blocks are values; they go in round slots.

Any round slot also accepts a typed value. When the slot compares an answer to a choice question, it offers
that question's choices.

### Using the workspace

- **Add a block:** drag it from the palette, or click it to drop it on the workspace.
- **Move blocks:** drag a stack block to move it together with the blocks below it, or drag a hat to move
  its whole script.
- **Snap:** a grey bar shows where a stack will snap; a highlighted slot shows where a condition or value
  will go. A block dropped onto a filled slot pops the old block out next to it.
- **Delete:** drag blocks back onto the palette, or select a block and press **Delete**.
- **Right-click** a block for *Duplicate*, *Delete* and *Edit script as JSON…* (the advanced
  representation). Right-click the workspace for *Clean up blocks*.
- **Pan and zoom:** drag empty space to pan; use **+ / = / −** or Ctrl + wheel to zoom.
- **Undo/redo** (Ctrl+Z / Ctrl+Shift+Z) covers every block change.
- **Try a block:** click a block to run it, as in Scratch; click a hat to run its whole script. The script
  glows. *Open link* opens its address in a new tab and *show message* / *end survey saying* show their
  text. Blocks that change the survey (show, go to page…) are listed instead; try those with answers in
  **Preview**. Conditions are checked as if nothing has been answered yet.
- The **↗** button on an *open link* block is a real link to the address: click it to check the address
  (browsers never block a link you click yourself).

Blocks that aren't under a hat never run. They are kept where you left them.

Surveys made before the block editor open with each old rule shown as a hat block holding an
*if … then … else* block, so nothing needs converting by hand.

### Variables

**Make a variable** asks for:

- a name;
- a starting value;
- optionally, a formula that recalculates it continuously.

Click ✎ next to a variable to rename it, change it or delete it. Renaming updates every block that uses it.
Variables can be shown in any text with `{{name}}`.

Every question can have an **answer key**, for example `age`; formulas refer to answers by that key.

### How scripts run

- **When any answer changes** scripts run again after every answer, so they describe how the survey should
  look *now*. An element that such a script can **show** starts hidden; elements it can **enable** or
  **require** also start in the opposite state.
- **Event** scripts (page opens, leaving a page, a click, submit) run once when the event happens, top to
  bottom. Navigation blocks (*go to page*, *end survey*…) belong in these.
- **Open link** and **show message** blocks in a *when any answer changes* script run when an answer changes
  and the block is reached: with no *if*, on the first answer; inside an *if*, when its condition becomes
  true. They don't run again on every keystroke, only after the condition has been false in between.
  Under the other hats they run when the event happens (page opens, leaving a page, a click, submit).
- **Open link … in [a new tab ▾ / this tab]**: *this tab* takes the respondent to the page (it can't be
  blocked; on submit it waits until the response is saved). In Preview it opens a new tab instead, so you
  don't leave the editor. *A new tab* opens a tab, and the survey's message bar also shows the link, so it can
  be clicked if the browser blocks or swallows the tab. `example.com` is read as `https://example.com`, and `{{…}}` fills in
  answers. Browsers only open tabs right after a click or key press; if one is blocked, the survey shows the
  link in its message bar, or on the completion screen if the survey has ended, for the respondent to click.
- An **if** with an empty condition slot never runs its blocks, like in Scratch. An empty slot in *and* or
  *or* counts as false.
- Hidden questions are skipped by validation. Their answers are not stored unless **Keep answers to
  questions hidden by logic** is turned on in Theme → Survey settings.

### Randomization

The **Random** blocks assign participants to conditions (between-subjects designs, A/B messages,
counterbalancing). For example:

```
when the survey starts
assign [condition ▾] [balanced ▾] to one of [control] [treatment]

when any answer changes
if < (condition) = [treatment] > then
    show [Persuasive message ▾]
else
    show [Neutral message ▾]
```

or, without a variable to compare:

```
when any answer changes
pick one of [3 ▾] at random · [record it in message ▾]
    set text of [Intro ▾] to [Message one]
or (option 2)
    set text of [Intro ▾] to [Message two]
or (option 3)
    set text of [Intro ▾] to [Message three]
```

- **assign … at random** gives each participant one of the conditions with equal probability. **balanced**
  gives a new participant one of the conditions that the fewest stored responses have so far (ties are
  broken at random), so groups stay close to equal in size. Click **+** to add a condition and **×** to
  remove one. The variable is created if it doesn't exist (pick *New variable…* to name it).
- **pick one of N at random** runs exactly one of its mouths for each participant. *Record it in* a variable
  to save which one (1, 2, 3 …) with the response.
- ⟨**chance 50 %**⟩ is true for about that share of participants; *(random number from a to b)* is a whole
  number in that range.
- **shuffle the choices of** a question shows its choices in a random order (“Other” and “None of the
  above” style options stay last). The stored answers are the same whatever the order.
- **when the survey starts** runs once when a participant begins, before the first page opens.

Every random draw is **fixed for the participant**: each participant gets a random seed when they start,
and every block draws from that seed. The same participant sees the same condition on every page, after a
reload of the published page (the seed is kept in their browser), and when the server checks the
submitted response. The server recomputes assignments itself and only accepts one of the block's
conditions, so a respondent can't submit a condition that doesn't exist. Assigned variables are stored with
the response and appear as columns in the Responses table and CSV export.

In **Preview**, **Restart** draws a new seed, so you can see the other conditions; clicking a random block
in the Logic tab also uses a fresh draw each time.

### Problems

The bar at the bottom of the workspace checks the logic as you work. It flags:

- blocks that point to a deleted question, page, button or variable;
- invalid formulas;
- navigation blocks in a *when any answer changes* script;
- empty *if* conditions.

Click a problem to jump to its script. Publishing is blocked until the problems are fixed; notes don't block
it.

### Formula language

A small, safe expression language. It is parsed and interpreted, and it cannot reach JavaScript.

- Arithmetic: `+ - * / %`.
- Comparisons and logic: `and`, `or`, `not`.
- Text in `"quotes"`.
- Lists in `[ ]`.
- `{{formula}}` inside any text (titles, messages, button labels) is replaced with the formula's value.

Functions:

- `answer("key")`, `selected("key", value)`
- `score()`, `score("key")`
- `count(x)`
- `sum` `avg` `min` `max`
- `round(x, digits)` `floor` `ceil` `abs` `sqrt` `pow`
- `if(test, a, b)`
- `contains(text, part)`
- `lower` `upper` `trim` `concat` `len`
- `isEmpty` `notEmpty`
- `today()` `daysBetween(a, b)`

## Preview

The **Preview** tab runs the real respondent runtime:

- **Devices:** Desktop (a browser window), Tablet (an iPad-size 820 × 1180 screen) or Mobile (an
  iPhone-size 390 × 844 screen with status bar, camera cut-out, side buttons and home bar). The screen
  scrolls inside the device, the device is scaled to fit, and **⟳ Portrait / Landscape** rotates it.
- **Start on:** start on any page.
- **Restart test:** clears all answers.

The test panel shows the current page, the path taken, the score, every answer and variable, which rules
are active, and an event log. Nothing is recorded.

## Saving, versions and publishing

### Saving

- Drafts autosave to the server. Each save carries the revision it was based on.
- **Another tab changed the survey:** the save is refused (HTTP 409). A dialog lets you load the other
  version or keep yours.
- **The server can't be reached:** a backup is kept in the browser and offered the next time you open the
  survey.

### Publishing

**Publish** freezes the current draft as an immutable **version** and gives the survey a random public link
(`/s/<publicId>`). Re-publishing creates version 2, 3 and so on behind the **same link**. Each response
records the version it answered.

From the publish dialog you can:

- **Untick Accepting responses:** the link shows a closed message.
- **Unpublish:** the link stops working.

### The respondent page

The respondent page is a standalone page with no MetaCode interface. It:

- saves progress as the respondent moves between pages;
- validates on the client;
- is validated again on the server with the same logic engine;
- announces errors to screen readers and supports the keyboard;
- reflows to one column on narrow screens, or scales the design if you chose *scale*.

## Responses

The **Responses** tab shows:

- totals: complete, in progress, completion rate and median time;
- a per-question summary: bar charts for choices, averages for numbers and ratings, recent answers for text;
- a table of every response.

You can delete one response or all of them.

Exports:

- **CSV:** one column per answer key, then one per variable (such as the condition a Random block
  assigned).
- **JSON:** includes the path, score, variables and version.

**Add text answers to project** turns open-text answers into MetaCode posts, ready for the codebook, AI
coding and human coding.

## Keyboard shortcuts

Also shown by the ⌨ button in the editor.

| Keys | Action |
|---|---|
| V / H / K | Select · Hand · Scale tool |
| T / R / F | Draw text · shape · container |
| Q | Add a question |
| Space + drag | Pan |
| Ctrl + wheel / pinch | Zoom |
| Ctrl+= / Ctrl+- / Ctrl+0 / Shift+1 | Zoom in · out · 100% · fit |
| Double-click | Go into a group/question · edit text |
| Ctrl-click | Select the deepest element |
| Enter / Esc | Select child or edit text · select parent |
| Arrows (Shift) | Nudge 1px (10px); reorder in stacks |
| Alt + drag | Duplicate while dragging |
| Shift + drag handle | Keep proportions · rotate in 15° steps |
| Alt + drag handle | Resize from the centre |
| Ctrl+C / X / V / D | Copy · cut · paste · duplicate |
| Ctrl+Alt+C / V | Copy · paste style |
| Ctrl+G / Ctrl+Shift+G | Group · ungroup |
| Ctrl+] / [ (with Shift) | Forward · backward (to front · to back) |
| Ctrl+Shift+H / L | Hide · lock |
| Ctrl+A | Select all at this level |
| Ctrl+Z / Ctrl+Shift+Z | Undo · redo |
| Ctrl+S | Save now |

## Data model

A survey is one JSON document:

```js
{
  schema: 1, id, title, description,
  settings: { width, responsive: 'reflow' | 'scale' | 'fixed', reflowBelow, showProgress, allowBack, nextLabel, backLabel, submitLabel,
              completionTitle, completionMessage, keepHiddenAnswers, grid },
  theme:    { tokens: { primary, accent, text, surface, background, error, fontBody, fontDisplay, radius, … }, types: { option: { …style } }, page: { …style } },
  pages:    [{ id, name, children: [elementId…], minHeight, style, props }],
  elements: { [id]: {
    id, type, name, parent: 'page:<pageId>' | '<elementId>', children?: [],
    props:   { text, value, score, layout: { mode: 'free' | 'stack' | 'grid', dir, gap, align, justify, wrap, cols }, … },
    frame:   { x, y, w, h, rot, sx, sy, kx, ky, ox, oy, pos: 'flow' | 'free', rx, ry, persp, distort },
    style:   { fill, color, fontSize, borderRadius, shadows, …, states: { hover, focus, active, checked, disabled } },
    behavior: { required, dataKey, validation, initiallyHidden, … },
    a11y, anim, responsive, locked, hidden } },
  variables: [{ id, name, type, initial, formula? }],
  rules:     [{ id, name, enabled, trigger: { type, page?, element? }, when, then: [statement], else: [statement], ui?: { x, y }, loose? }],
  // a script: trigger = its hat block; then = the blocks under it; ui = where it sits on the workspace
  // statement: an action ({ type: 'show', target } …) or a C-block
  //            { type: 'if', when: { op: 'all', items: [condition] }, then, else, withElse }
  // condition: { left: value, cmp, right: value } | { group: { op: 'all' | 'any' | 'not', items } } | { expr }
  // value:     { kind: 'value', value } | { kind: 'answer', ref } | { kind: 'var', name } | { kind: 'score' }
  //            | { kind: 'page' } | { kind: 'expr', expr } | { kind: 'calc', op, a, b }
  // Blocks without a hat are kept as rules with trigger { type: 'none' }; a lone value or condition in rule.loose.
  styles:    [], meta: {}
}
```

### Repair on load

`normalizeDoc` (in `survey-core.js`) runs on every load, save and import. It repairs a damaged document
without dropping content:

- unknown types become containers;
- orphaned elements are moved to a page;
- invalid values are reset.

### Shared code

The same model (`survey-core.js`) and logic engine (`survey-logic.js`) run in three places: the editor, the
respondent page and the server.

## Server API

### Editor routes

All editor routes are under `/api/surveys`. They are same-origin only, and the JSON limit is 26 MB.

| Method & path | Purpose |
|---|---|
| `GET /` · `POST /` | List · create (empty, from `{ doc }` for templates/imports, with a fresh id) |
| `GET /:id` · `PUT /:id` · `DELETE /:id` | Load · save `{ doc, baseRevision, force? }` (409 on conflict) · move to trash |
| `POST /:id/duplicate` | Copy a survey |
| `POST /:id/publish` · `PATCH /:id/publish` · `DELETE /:id/publish` | Publish a new version (422 with `problems` when logic is broken) · open/close responses · unpublish |
| `GET /:id/versions` · `GET /:id/versions/:n` | Published versions |
| `GET /:id/responses` · `DELETE /:id/responses/:rid` · `DELETE /:id/responses` | Responses |
| `GET /library` · `PUT /library` | Shared components, saved styles, templates |

### Respondent routes

Respondent routes are under `/api/public/surveys`. They are rate limited to 120 requests per minute per
client.

| Method & path | Purpose |
|---|---|
| `GET /:publicId` | The current published version |
| `POST /:publicId/responses` | Start or submit a response → `{ responseId, token }` |
| `PUT /:publicId/responses/:rid` | Update with the token; `complete: true` submits |

`GET /s/:publicId` serves the respondent page.

### Storage

Data is stored as JSON files under `SURVEY_DATA_DIR`:

```
surveys/<id>.json          versions/<id>/<n>.json
responses/<id>.json        library.json        trash/
```

Every write is atomic: it goes to a temporary file, which is then renamed. Writes to the same file are
serialised.

## Security

### Respondents

- Respondents can reach only the published version of a survey and the response routes for it. Draft data,
  other surveys and responses are not reachable with a public link.
- Responses are validated on the server against the version they answer:
  - unknown questions are dropped;
  - answers to questions that logic hides are dropped (unless *Keep answers to questions hidden by logic* is on);
  - options must exist;
  - required, format and range rules apply.
- Response tokens are random and stored only as SHA-256 hashes. A response can't be changed after it is
  submitted.

### Editor and content

- State-changing editor requests must come from MetaCode's own pages. Requests whose `Origin` or
  `Sec-Fetch-Site` header shows another site are refused.
- Formulas are interpreted by a small parser. They have no access to JavaScript, the page or the network.
- Rich text is sanitised to an allow-list of tags. URLs are restricted to `http`, `https` and `mailto`;
  images may also use `data:image/…`.
- Custom CSS and style values are filtered so they can't break out of the element's rule.
- Videos are embedded only from YouTube (`youtube-nocookie.com`), Vimeo or a direct file URL.
- Errors return short messages, never server paths or stack traces.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SURVEY_DATA_DIR` | `survey-data/` (next to `server.js`) | Where surveys, versions, responses and the library are stored. Gitignored. |

Respondents open `/s/<publicId>` on **your** MetaCode server. To collect responses from other people, the
server must be reachable by them, for example deployed or exposed through a tunnel. On `localhost`, only
your own computer can answer.

## Limitations

- There are no user accounts. Anyone who can open MetaCode on your server can edit its surveys, as with the
  rest of MetaCode.
- The options inside a native **Dropdown** menu are drawn by the browser and can't be styled one by one.
  Use **Single choice** for fully styled options.
- `pattern` (regular expression) validation runs only in the respondent's browser. The server checks the
  other formats (email, URL, phone, number ranges, lengths) but doesn't run user-written regular
  expressions.
- Free-positioned designs **reflow** to a single column on narrow screens, in reading order (top to bottom,
  then left to right). Rotation and skew of top-level elements are flattened there, so stacked elements
  don't overlap. Choose **Scale** in Theme → Survey settings to keep the exact design and shrink it instead.

## File map

```
surveys/index.js                     Editor + public API routes, /s/:publicId page
surveys/store.js                     JSON-file storage (atomic writes, versions, responses, trash)
public/studio.html                   Survey Studio's own page (opened from the front page)
public/survey.html                   Respondent page
public/css/survey.css                Survey rendering (shared by editor, preview and respondent page)
public/css/survey-studio.css         Editor UI
public/css/survey-blocks.css         Logic blocks
public/js/survey/
  survey-core.js                     Model: element types, normalise, styles → CSS, transforms, sanitising
  survey-logic.js                    Formula language, rules, scoring, validation (also used by the server)
  survey-render.js                   Renders a page to DOM (design + live modes)
  survey-runtime.js                  Respondent runtime: answers, logic, navigation, validation, submit
  survey-public.js                   Respondent page bootstrap (load, save progress, submit)
  survey-store.js                    Editor state: transactions, undo/redo, selection, autosave, backup
  survey-commands.js                 Editor commands (add, delete, duplicate, clipboard, group, align, …)
  survey-canvas.js                   Canvas: viewport, selection, handles, snapping, drawing, inline text
  survey-inspector.js                Properties inspector
  survey-panels.js                   Palette, layers, library
  survey-blocks.js                   Logic tab: Scratch-style blocks (palette, workspace, drag and drop)
  studio-shell.js                    studio.html bootstrap: routing, dialogs, notifications, project access
  survey-templates.js                Built-in templates
  survey-studio.js                   Survey list, editor shell, theme, preview, publish, responses
test/survey-core.test.js             Model + logic unit tests
test/survey-api.test.js              API integration tests
test/survey-e2e.test.js              Browser tests (full authoring → response flow)
```
