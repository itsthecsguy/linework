---
name: linework
description: Create and edit software diagrams (architecture, flowcharts, state machines, sequence diagrams, ER/database schemas) as .drawio.svg files that render in Markdown, HTML and GitHub, and that people can open and edit by hand in draw.io. Use when a design doc, README or ADR needs a diagram, or when asked to change an existing .drawio.svg.
---

# Linework

You describe the diagram as a small YAML spec. `linework` does the layout, styling and rendering, and writes a `.drawio.svg`. That's a normal SVG for docs, with the editable draw.io model embedded inside it. Never write coordinates, SVG or draw.io XML yourself.

Run it as `npx -y @itsthecsguy/linework` unless `linework` is already on PATH. The first run needs a Chromium-based browser. If it says none was found, run `npx playwright install chromium`.

## Workflow

1. **Decide what the diagram is for.** One diagram makes one point. Pick the type:
   - `architecture`: components and how they talk. Services, data stores, queues, external systems, trust boundaries.
   - `flow`: a process with steps and decisions.
   - `state`: the lifecycle of one thing, like an order, payment or job.
   - `sequence`: who calls whom, in what order, for one scenario.
   - `er`: database tables, their columns and how they relate.

   If the doc already has a Mermaid diagram, convert it instead of rewriting it: `npx -y @itsthecsguy/linework import doc.md --block 1 -o docs/diagrams/x.drawio.svg`.
2. **Write the spec** to a scratch file, or pipe it on stdin. The `.drawio.svg` is the source of truth, so you don't need to keep the YAML.
3. **Build with a preview:**
   ```bash
   npx -y @itsthecsguy/linework build spec.yaml -o docs/diagrams/checkout.drawio.svg --png /tmp/checkout.png
   ```
4. **Read the output.** `spec error` lines tell you exactly what to fix. `check:` lists layout problems. Fix every `error` and the warnings that matter, then rebuild.
5. **Look at the PNG** if you can view images. Check that the diagram tells the story you meant, flows in a sensible direction and doesn't sprawl. If `check` says `too-wide`, remove `direction` (or set `TB`) or split it.
6. **Embed the `.drawio.svg`**, never the PNG (see "Putting it in a doc").

## Spec

```yaml
type: architecture            # architecture | flow | state | sequence | er
title: Checkout               # optional
direction: auto               # auto (default) | TB | LR | BT | RL
theme: clean                  # clean (default) | soft | dark | sketch | blueprint | c4
groups:                       # optional boxes around nodes; can nest with `in`
  vpc: { label: Production VPC }
  data: { label: Data tier, in: vpc }
nodes:                        # id: { label, kind, tech, in }  (all optional)
  user:   { label: Shopper, kind: person }
  web:    { label: Web app, kind: client, tech: Next.js }
  api:    { label: Checkout API, tech: Go, in: vpc, highlight: true }
  queue:  { label: order-events, kind: queue, tech: Kafka, in: vpc }
  db:     { label: Orders, kind: database, tech: Postgres, in: data }
  stripe: { kind: external, tech: Payments API }   # label defaults to "Stripe"
edges:                        # "from ARROW to: label"
  - user -> web
  - web ==> api: HTTPS          # ==> highlighted: the path the doc is about
  - api -> db: SQL
  - api -.-> queue: OrderPlaced  # -.-> async/event, dashed
  - api -> stripe: charge
```

- Ids use letters, digits, `_`, `.` and `-`. The label defaults to the id with its first letter capitalized.
- Arrows: `->` call or flow, `==>` the same but highlighted, `-.->` async or event, `<->` two-way, `--` no arrowhead. Put spaces around the arrow.
- `tech` is the small, quieter second line. Use it for the technology, not a description.
- Node order matters a little. Layout tries to keep the declaration order, so list nodes roughly in reading order.
- Quote an edge if its label contains `: ` or `#`, for example `- "api -> db: SELECT: orders"`.
- Architecture nodes can carry a cloud icon: `icon: aws.lambda`, `gcp.cloud_run`, `k8s.pod`, `azure.<name>`. Run `npx -y @itsthecsguy/linework icons aws lambda` to search names. Use icons when the doc is about a specific cloud; leave them off for logical diagrams.
- Styles (`theme:`): use `clean` unless asked. It's minimal: white boxes, hairline borders, groups as gray grounds, IBM Plex Sans, and color only where it means something.
  - `soft`: borderless pastel cards, tinted by kind. For slides and docs that want color coding.
  - `dark`: for dark-mode docs and slides.
  - `sketch`: hand-drawn lines and handwriting. For early proposals ("this is a draft") and whiteboard-style explainers.
  - `blueprint`: light lines on deep blue, monospace. For technical deep dives that want a distinct look.
  - `c4`: C4-model conventions; labels each box with its element type.
- Color is for meaning, so most nodes stay neutral:
  - `highlight: true` on a node, group or participant, or `==>` on an edge or message, makes it the first thing a reader sees. Highlight the one path or component the surrounding text is about: often one node and the 2 or 3 edges into and out of it. `build` warns when you highlight so much that nothing stands out.
  - `color: <name>` tints a node, group or edge to mark a category, like red for failure paths or green for what's new in this proposal. Say what the color means in the doc text. Names: `blue`, `violet`, `pink`, `red`, `orange`, `amber`, `green`, `teal`, `gray`.
  - Kinds `error` and `success` are red and green in every style.
  - An edge with a color uses the object form: `- { from: api, to: dlq, label: on failure, style: async, color: red }`.

Node kinds, also listed by `linework kinds`:

| type | kinds (default first) |
|---|---|
| architecture | `service`, `person`, `client`, `function`, `database`, `cache`, `storage`, `queue`, `external` |
| flow | `step`, `decision`, `terminal`, `data`, `error` |
| state | `state`, `success`, `error` (start and end come from `[*]`) |
| sequence | `service`, `person`, `client`, `function`, `database`, `queue`, `external` |
| er | `entity`, `view`, `external` |

Flow and state specifics:

```yaml
type: flow
nodes:
  start:  { label: Refund requested, kind: terminal }
  window: { label: Within 30 days?, kind: decision }
  refund: { label: Issue refund }
  deny:   { label: Deny with reason, kind: error }
edges:
  - start -> window
  - window -> refund: "yes"     # label every edge leaving a decision
  - window -> deny: "no"
```

```yaml
type: state
nodes:
  pending: {}
  paid: { kind: success }
  failed: { kind: error }
edges:
  - "[*] -> pending"            # quote edges that use [*]
  - pending -> paid: payment_succeeded
  - pending -> failed: declined
  - "paid -> [*]"
```

Sequence diagrams use `participants` (in left-to-right order) and `messages`:

```yaml
type: sequence
participants:
  web:    { label: Web app, kind: client }
  api:    { label: Checkout API }
  stripe: { kind: external }
messages:
  - web ==> api: POST /checkout       # -> call; ==> highlighted call
  - api -> stripe: create PaymentIntent
  - stripe --> api: client_secret     # --> reply (dashed)
  - api --> web: 200 OK
  - note over api, stripe: retried with an idempotency key
  - alt:                              # alt and par take branches
      - when: payment succeeded
        do:
          - stripe -.-> api: webhook  # -.-> async
      - when: declined
        do:
          - api --> web: 402
  - loop: every 30s                   # loop, opt, critical, break take one block
    do:
      - web -> api: poll status
```

Activation bars come from call/reply pairs automatically: each `a -> b` closed by a later `b --> a`. Participants take `color` and `highlight` like nodes.

ER diagrams put `fields` on nodes and use Mermaid's crow's-foot notation for edges:

```yaml
type: er
nodes:
  users:
    fields:
      - id: uuid pk
      - org_id: uuid fk
      - email: text unique
  orgs:
    label: organizations
    fields: [ "id: uuid pk", "name: text" ]
edges:
  - users }o--|| orgs: belongs to     # many users to exactly one org
```

Field flags: `pk`, `fk`, `unique`, `null`. Cardinality ends: `||` one, `|o` zero or one, `}o` / `o{` many, `}|` / `|{` one or many. Use `--` for identifying relationships, `..` for the rest.

More examples and rules are in `references/spec.md`. Read `references/style-guide.md` before drawing anything non-trivial.

## Editing an existing diagram

Always start from the file, never from an old copy of the spec:

```bash
npx -y @itsthecsguy/linework show docs/diagrams/checkout.drawio.svg > /tmp/spec.yaml   # current spec, hand edits included
# edit /tmp/spec.yaml; keep the "# linework-base:" line at the top
npx -y @itsthecsguy/linework build /tmp/spec.yaml -o docs/diagrams/checkout.drawio.svg --png /tmp/checkout.png
```

If someone has arranged the diagram by hand in draw.io, `build` merges your changes into their layout instead of starting over. (For sequence diagrams, hand-placed lifeline columns stay; rows always follow message order.)
- Existing nodes stay exactly where they are.
- New nodes go next to the node they connect to.
- Removed nodes disappear.
- Groups grow to fit new members.
- Only new edges, and edges whose routes went stale, get rerouted.
- Their colours, label edits and notes survive.

The `merged into the existing layout:` line tells you what happened. Mention it to the user.

The `# linework-base:` line tells `build` your spec includes the latest hand edits. Without it, `build` won't delete shapes someone added by hand that your spec doesn't mention. It keeps them and prints a note. If you see that note, run `show` again and redo your edit from its output.

`--relayout` throws the hand-made layout away and lays everything out from scratch. **Only use it if the user asks,** because it undoes their layout work.

If someone moved shapes by hand and left edges crossing through boxes, `npx -y @itsthecsguy/linework tidy file.drawio.svg` reroutes just the broken edges and changes nothing else.

## Putting it in a doc

- Markdown (GitHub, GitLab, most renderers): `![Checkout architecture](diagrams/checkout.drawio.svg)`
- HTML: `<img src="diagrams/checkout.drawio.svg" alt="Checkout architecture">`
- Tell the user they can edit it by hand: open the file in VS Code with the "Draw.io Integration" extension, in draw.io desktop, or at app.diagrams.net. It saves back into the same file, and your later edits will keep their layout.
- In a git repo, offer to run `npx -y @itsthecsguy/linework git-setup` once, so `git diff` on diagrams shows readable spec changes.
- Google Docs can't hold SVG. `npx -y @itsthecsguy/linework publish file.drawio.svg` copies it into the user's Google Drive folder, and draw.io's Google Docs add-on inserts it from there and refreshes it after changes. Setup and the update steps are in `references/google-docs.md`; walk the user through them the first time.

## Letting the user edit

If the user wants to adjust a diagram by hand, `npx -y @itsthecsguy/linework edit file.drawio.svg` opens it in draw.io in their browser, served from their machine. Saving there writes the file. When they say they're done, run `show` and carry on from its output; their changes are in it.

## Commands

| command | does |
|---|---|
| `build <spec\|-> -o out.drawio.svg [--png p.png] [--relayout]` | layout (or merge into an existing file), write, lint |
| `show <file> [--geometry]` | print the spec, stamped with `linework-base` |
| `tidy <file>` | reroute edges that pass through nodes; nothing else changes |
| `import <file.mmd\|doc.md> [--block N] [-o out.drawio.svg]` | convert Mermaid (flowchart, state, sequence, ER) |
| `icons <aws\|gcp\|k8s\|azure> [filter]` | list icon names |
| `edit <file>` | open the diagram in draw.io in the user's browser; saving writes the file |
| `publish <file...> [--to dir] [--pull]` | copy diagrams into Google Drive for the Docs add-on; `--pull` brings Drive edits back |
| `git-setup` | make `git diff` show diagram changes as spec changes |
| `render <file> -o out.png [--scale 2]` | preview image |
| `check <file>` | lint only; exit 1 on errors |
| `kinds [type]` | list node kinds |
| `schema` | JSON Schema of the spec |
