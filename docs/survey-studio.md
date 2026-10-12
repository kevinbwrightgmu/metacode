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

1. On the front page, click **Survey Studio**. The dashboard lists your surveys with their status
   (draft, live, closed, unpublished, or *edited* when saved changes aren't published yet), response counts and quick links to Design, Theme, Preview and Responses; search,
   filter by status and sort them. Pick **Create survey** or one of the templates: Customer feedback,
   Research study, Event registration or Scored quiz. The logo at the top left goes back to the front page.
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

The **Theme** tab is a grouped editor on the left and a live preview of the survey on the right (it
updates as you change things, on any page of the survey):

- **Typography:** body, heading, question-title, button and monospace fonts, and text sizes.
- **Colours:** the colour tokens (primary, text, muted, surface, border, error…), with a contrast check
  against the background (WCAG AA).
- **Background:** the page background behind the survey and the survey card.
- **Layout:** page width, padding, radius, spacing, responsive mode (*reflow* or *scale*).
- **Question styling, Buttons, Progress:** the defaults for those element types, the button labels, and the
  progress bar.
- **Advanced:** every token and every element type's defaults, and **Theme JSON** for copying a theme
  between surveys.

**Fonts.** Every font control opens the font library: 250+ Google Fonts and 7 system fonts, with search
(by name or by style words such as *serif*, *geometric*, *handwriting*, *legible*), categories (sans,
serif, display, handwriting, monospace, system) and each name shown in its own typeface. Hovering a font
previews it; choosing it saves it in the theme. The fonts a survey uses are loaded from Google Fonts in the
editor, the preview and on the published page (respondents' browsers request them from
`fonts.googleapis.com`; choose a system font to avoid that).

Survey-wide settings (title, completion message, going back, respondent identification and the session
timeline) are on the **Settings** tab — see [Respondent identification and the session
timeline](#respondent-identification-and-the-session-timeline).

An element's style is resolved in this order: the built-in style of its type, then the theme default for
that type, then the element's own overrides. Colours can refer to tokens, so changing **primary** recolours
everything that uses it.

## Components, saved styles and templates

The **Library** tab (left panel) holds three things:

- **Components:** save any selection as a reusable component. It appears in the palette for every survey.
- **Saved styles:** save an element's style under a name and apply it to other elements with one click.
- **Style clipboard:** the style you last copied with **Ctrl+Alt+C**.

The library is kept in your browser, so it is shared by every survey you make there.

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

## Respondent identification and the session timeline

Both are on the **Settings** tab and are off by default.

### Respondent information block

**Settings → Respondent identification → Add the block** (or *Respondent information* in the Add palette)
puts a block on the page. In its inspector, choose what it collects:

| Field | Where the value comes from | Stored as |
|---|---|---|
| Name | Typed by the respondent | `respondent.name` |
| Participant code | Typed by the respondent, **or** read from the survey link (e.g. `/s/<id>?pid=P-0042`, parameter name configurable) | `respondent.participantId` with `participantIdSource: 'entered' \| 'link'` |
| Country, region | Derived by the server from the reverse proxy's location headers (needs `SURVEY_GEO_HEADERS`) | `respondent.derived.country`, `.region`, `.geoSource` |
| IP address | Derived by the server from the request (needs `TRUST_PROXY` behind a proxy) | `respondent.derived.ip` |

Typed fields can be required and labelled. Derived values are never typed or sent by the respondent's
browser — the server takes them from the request when the response is saved, so a respondent can't
substitute someone else's. When the server can't know them it says why (`ipNote: 'behind_proxy'`,
`geoNote: 'not_configured'`) instead of guessing. The block can be hidden from respondents (a link code is
still read), but derived fields are always announced: the respondent page shows a notice listing what is
collected before the survey starts.

On the Responses page these appear as, e.g., `🇺🇸 127.0.0.1 · California`, with *entered*, *from link* and
*derived* labels.

### Session timeline

**Settings → Session timeline:** *Off* (default), *Notice* or *Consent*.

- **Notice:** the respondent page says the session is recorded (your text, or a default) before the
  respondent starts.
- **Consent:** the respondent chooses **Allow and start** or **Start without the timeline**; declining
  stores no events.

What is recorded: start, page changes (next / back / jump), focus on a question, answers (choices and
numbers as values; open text as its **length only**), cleared answers, skips, validation errors,
leaving and returning to the tab, and submit — each with a time offset. At most 3,000 events per response.
Keystrokes, mouse movements, the screen and anything outside the survey are **not** recorded; there is no
video. Responses from before the timeline was turned on, or with it declined, show an empty state — nothing
is reconstructed.

## Responses

The **Responses** tab shows:

- **Overview:** total, complete, in progress, abandoned (no activity for 30 minutes, or the respondent
  closed the page), completion rate and median time. The *Summary* tab charts each question (bar charts for choices,
  averages for numbers and ratings, recent answers for text).
- **Individual:** a list (search by response ID, participant code, name, IP, location or answer text;
  filter by status and date range; sort) next to the selected response, with **previous / next**:
  - **Answers:** every question in the order it was presented, with its full text, type, the formatted
    answer (choices by label, rankings in order, matrices as a grid), and *Not answered*, *Skipped* or
    *Not shown to this respondent*.
  - **Timeline:** time per page, the event list and a step-by-step **replay** of how the answers changed
    (play, or jump to any event; **Open page** goes to that page in the editor).
  - **Details:** respondent information (with entered / from link / derived labels), response ID,
    status, version, start / last activity / submit times, duration, pages seen, device type, browser
    language, score, timeline status and variables.

**Exports** (CSV, JSON, events CSV) leave out the participant code, name, IP, location and timelines unless
you tick them, and can be limited to the current filter. **Privacy** erases IP addresses, locations,
identities or timelines from every response (the answers stay), deletes one response, or deletes them all.

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

## Tutorial and guided tour

**Tutorial & tour** in the top bar, or the compass button in the editor's top bar, opens *Learn Survey
Studio* with two choices:

- **Hands-on tutorial** (about 5 minutes) — *Build your first survey*. The tutorial creates a practice
  survey and walks through the whole workflow on it, one action per step:
  1. name the survey;
  2. add a single-choice question and write its text on the canvas;
  3. make it required (Properties panel);
  4. add a long-text follow-up;
  5. open Logic and add a script (drag blocks, or **Add an example for me**: *if the first answer is
     picked, show the follow-up, else hide it*), then read how it works;
  6. change the theme's primary colour;
  7. preview on a phone and submit an answer;
  8. publish and see the link;
  9. open Responses.

  The step's control is spotlighted and stays usable; the tutorial notices when the step is done and moves
  on (**Skip step** goes on without doing it). On phones the Add and Properties panels open by themselves and
  the card docks at the top or bottom of the screen. Keys aimed at the card work (→ / ← / Esc); typing in the
  editor isn't intercepted. Each new step moves focus to the card and announces completion, for screen
  readers. Closing the tutorial keeps its place: the menu then offers **Resume the tutorial** (or start again
  with a new practice survey). It also starts from the empty survey list (**Start the tutorial**), from the
  first-visit card, or with `studio.html?tutorial=1`. The practice survey is an ordinary survey — delete it
  from the list when you're done.
- **Quick tour of the screen** (about 2 minutes) — see below.

The quick tour (`studio.html?tour=1`) shows: on the list,
the templates, new/import and your surveys; in the editor, every tab — Design (elements, canvas, tools,
properties), Logic (blocks, the Random category, scripts), Theme, Preview and its test panel, Responses —
then saving and publishing. From the list, the tour can make a practice survey to show the editor on.
The coding app's tour ends by offering it. The first visit to the list offers the tutorial, and the first
visit to the editor offers the quick tour, once each.

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

All editor routes are under `/api/surveys`. They are same-origin only, the JSON limit is 26 MB, and each
works only on surveys owned by the requesting browser (see Storage). Survey Studio itself uses the publish,
versions and responses routes; drafts stay in the browser. `POST /:id/publish` with `{ doc }` creates the
server copy of a browser draft on its first publish.

| Method & path | Purpose |
|---|---|
| `GET /` · `POST /` | List · create (empty, from `{ doc }` for templates/imports, with a fresh id) |
| `GET /:id` · `PUT /:id` · `DELETE /:id` | Load · save `{ doc, baseRevision, force? }` (409 on conflict) · move to trash |
| `POST /:id/duplicate` | Copy a survey |
| `POST /:id/publish` · `PATCH /:id/publish` · `DELETE /:id/publish` | Publish a new version (422 with `problems` when logic is broken) · open/close responses · unpublish |
| `GET /:id/versions` · `GET /:id/versions/:n` | Published versions |
| `GET /:id/responses` · `DELETE /:id/responses/:rid` · `DELETE /:id/responses` | Responses |
| `POST /:id/responses/erase` | `{ what: 'ip' \| 'location' \| 'identity' \| 'timeline' }` — erase that data from every response |
| `GET /library` · `PUT /library` | This browser's components, saved styles, templates |

### Respondent routes

Respondent routes are under `/api/public/surveys`. They are rate limited to 120 requests per minute per
client.

| Method & path | Purpose |
|---|---|
| `GET /:publicId` | The current published version |
| `POST /:publicId/responses` | Start or submit a response → `{ responseId, token }` |
| `PUT /:publicId/responses/:rid` | Update with the token; `complete: true` submits |
| `POST /:publicId/responses/:rid/events` | Append session-timeline events with the token (used when the page is closed); 409 after submit |

Responses carry `respondent` (`name`, `participantId`, `participantIdSource`, and `derived` with `ip`,
`country`, `region`, `geoSource` and notes — only the fields the survey collects) and `session`
(`recording`, `startedAt`, `events`). Events are checked against a fixed list of types and fields on the
server; anything else is dropped.

`GET /s/:publicId` serves the respondent page.

### Storage

Drafts and the library live in the **browser** that made them (IndexedDB through `public/js/local-db.js`;
`survey-store.js`'s `api()` answers the draft routes itself, with the same answers as the server routes
below). Other people using the same MetaCode server never see them.

The server stores a survey only once it is **published** — the published copy, its versions and its
responses — as JSON files under `SURVEY_DATA_DIR`:

```
surveys/<id>.json          versions/<id>/<n>.json
responses/<id>.json        libraries/<owner>.json        trash/
```

Each record has an `owner`: a hash of the publishing browser's random identity (the `mc_owner` cookie,
see `owner.js`). Editor routes only show and change the requesting browser's surveys; anyone else gets
404, and a request without an identity gets 401. Surveys saved by older versions (no owner, plus the old
shared `library.json`) are listed at `GET /legacy` and taken over with `POST /legacy/:id/claim` — only from
the computer running MetaCode (loopback, not through a proxy). Settings → Your data in the coding app backs
up and restores everything, identity included.

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
- IP address and location are taken from the request on the server, never from the respondent's browser.
  Forwarded-IP headers (`X-Forwarded-For`, `Forwarded`) are believed only from the proxies `TRUST_PROXY`
  names; location only from the headers `SURVEY_GEO_HEADERS` names. Both are collected only when the survey
  asks for them, and disclosed on the respondent page.
- Nothing is tracked covertly: the session timeline is off unless the author turns it on, and then the
  respondent is told (or asked) first. Respondent data isn't written to the server log.

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
| `TRUST_PROXY` | unset (forwarded headers ignored) | Which reverse proxy to believe for the visitor's IP: a hop count (`1` = one proxy in front, e.g. nginx or Cloudflare → MetaCode), `loopback`, or a comma-separated list of proxy addresses/CIDR ranges. Used for rate limits and the respondent IP. Don't set it when MetaCode is reached directly — anyone could then fake their address. |
| `SURVEY_GEO_HEADERS` | unset (no location) | Where the proxy puts the visitor's location: `cloudflare` (`CF-IPCountry`, and `CF-Region` with Cloudflare's visitor-location headers on), or `<country-header>[,<region-header>]`, e.g. `X-Country-Code,X-Region` from nginx GeoIP2. Only set it when the proxy overwrites those headers on every request. |

Respondents open `/s/<publicId>` on **your** MetaCode server. To collect responses from other people, the
server must be reachable by them, for example deployed or exposed through a tunnel. On `localhost`, only
your own computer can answer.

## Limitations

- There are no user accounts. Published surveys and their responses belong to the browser that published
  them (see Storage); anyone with that browser (or its backup file) can see them.
- The session timeline is an event log with a replay of the answers, not a screen recording.
- Location needs a proxy or CDN that adds location headers; MetaCode has no IP-geolocation database.
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
  studio-tour.js                     The quick tour of the list and the editor (uses ../tour.js)
  studio-tutorial.js                 The hands-on tutorial and the Learn Survey Studio menu
  survey-templates.js                Built-in templates
  survey-studio.js                   Survey dashboard, editor shell, theme editor, settings, preview, publish
  survey-fonts.js                    Font library (catalog, search, picker, loading the fonts a survey uses)
  survey-responses.js                Responses page: overview, list + detail, timeline/replay, exports, privacy
test/survey-core.test.js             Model + logic unit tests
test/survey-api.test.js              API integration tests
test/survey-e2e.test.js              Browser tests (full authoring → response flow)
test/survey-privacy.test.js          Respondent information, trusted IP/location, session events, erase
test/survey-fonts.test.js            Font catalog/search and Responses helpers
test/platform-e2e.test.js            Browser tests: front page, dashboard, theme/fonts, respondent block, timeline, Human Coding
```
