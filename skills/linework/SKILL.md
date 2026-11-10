---
name: linework
description: Draw software diagrams (architecture, system design, data flow, flowcharts, state machines, sequence diagrams, ER and database schemas) as .drawio.svg files that render in Markdown, HTML and GitHub and that people can edit by hand in draw.io. Use whenever a design doc, README, ADR, wiki page or PR needs a diagram, when asked to draw, visualize or diagram a system, when converting a Mermaid diagram, or when changing an existing .drawio.svg. Use it instead of writing Mermaid, PlantUML or ASCII art unless the user asks for one of those.
compatibility: Needs Node 20+, a Chromium-based browser (Chrome, Edge, or Playwright's Chromium via `linework install-browser`) and network access to fetch the package with npx.
---

# Linework

You describe the diagram as a small YAML spec. Linework does the layout, styling and rendering, and writes a `.drawio.svg`: a normal SVG for docs with the editable draw.io model inside it. Never write coordinates, SVG or draw.io XML yourself, and don't fall back to Mermaid, PlantUML or ASCII art unless the user asks for one.

`linework` below means `npx -y @itsthecsguy/linework` (plain `linework` if it's on the PATH). Keep specs and preview PNGs in your temp directory, not in the repo. If a command fails to download, find a browser or accept an option this guide names, read `references/troubleshooting.md`.

## New diagram

1. **Look for existing diagrams.** Search for `*.drawio.svg`. If one already shows what you need, change it (next section). Save new ones where the others live, else `docs/diagrams/`.
2. **Pick the type.** One diagram makes one point.
   - `architecture`: components and how they talk.
   - `flow`: a process with steps and decisions.
   - `state`: the lifecycle of one thing.
   - `sequence`: who calls whom, in order, for one scenario.
   - `er`: tables, columns and relationships.
3. **Write the spec**, starting from the closest file in `examples/` next to this guide: `checkout.yaml` and `platform.yaml` (architecture), `serverless-aws.yaml`, `orders-azure.yaml` and `gcp-ingest.yaml` (cloud icons), `refund-flow.yaml` and `deploy-flow.yaml` (flow), `payment-state.yaml` and `job-state.yaml` (state), `pay-sequence.yaml` and `auth-seq.yaml` (sequence), `billing-er.yaml` and `shop-er.yaml` (ER). A Mermaid block converts directly: `linework import doc.md --block 1 -o out.drawio.svg`.
4. **Build:** `linework build /tmp/spec.yaml -o docs/diagrams/checkout.drawio.svg --png /tmp/checkout.png`
5. **Read the output.** `spec error` lines say exactly what to fix. `check:` lists layout problems. Fix every error and the warnings that matter, then rebuild. Look at the PNG if you can view images.
6. **Embed the `.drawio.svg`**, never the PNG: `![Checkout API charges cards through Stripe and writes orders to Postgres](diagrams/checkout.drawio.svg)`. Write alt text that says what the diagram shows in one sentence.
7. **Tell the user** where the file is and that they can edit it by hand in draw.io (`linework edit <file>` opens it in their browser).

## Changing a diagram

The `.drawio.svg` is the source of truth. Every command below keeps what is already there in place, including boxes someone moved by hand in draw.io. Only what you change moves.

For one or two changes, edit the file directly:

```bash
linework set d.drawio.svg api.label="Checkout API v2" api.highlight=true   # id.field=value; empty value clears; also theme= accent= title= direction=
linework add d.drawio.svg "fraud: { label: Fraud check, in: vpc }" "api -> fraud: score"
linework rm  d.drawio.svg cache "api -> stripe"                              # a box goes with its edges
```

For a larger change, round-trip the spec. Always start from the file, never from an old copy of the spec:

```bash
linework show d.drawio.svg > /tmp/spec.yaml    # current spec, hand edits included
# edit it; keep the "# linework-base:" line at the top
linework build /tmp/spec.yaml -o d.drawio.svg --png /tmp/d.png
```

- The `merged into the existing layout:` line says what was kept, placed, grown and rerouted. Pass it on to the user.
- If the user moved boxes by hand and left lines or labels in odd places, `linework tidy d.drawio.svg` reroutes those edges and re-places those labels. Boxes stay put.
- `--relayout` throws the layout away and starts over. Use it only if the user asks: it undoes their work.
- When the user says they finished editing in draw.io, run `show` and carry on from its output.

## Spec

```yaml
type: architecture            # architecture | flow | state | sequence | er
title: Checkout               # optional
direction: auto               # auto (default) | TB | LR | BT | RL
theme: clean                  # clean (default) | soft | paper | dark | midnight | mono | bold | sketch | blueprint | c4
accent: "#E11D48"             # optional: the highlight color, a name or a quoted hex
groups:                       # optional boxes around nodes; nest with `in`
  vpc: { label: Production VPC }
nodes:                        # id: { label, kind, tech, in }, all optional
  web:    { label: Web app, kind: client, tech: Next.js }
  api:    { label: Checkout API, tech: Go, in: vpc, highlight: true }
  queue:  { label: order-events, kind: queue, tech: Kafka, in: vpc }
  db:     { label: Orders, kind: database, tech: Postgres, in: vpc }
  stripe: { kind: external }   # label defaults to "Stripe"
edges:                        # "from ARROW to: label"
  - web ==> api: HTTPS         # ==> highlighted: the path the doc is about
  - api -> db: SQL
  - api -.-> queue: OrderPlaced # -.-> async or event, dashed
  - api -> stripe: charge
```

- Arrows: `->` call or flow, `==>` highlighted, `-.->` async, `<->` two-way, `--` no arrowhead. Spaces around the arrow. Quote an edge whose label contains `: ` or `#`.
- List nodes and edges in reading order. Layout follows it, and an edge that points back at an earlier node is drawn as the loop.
- `tech` is the quiet second line: the technology, not a description.
- Color is for meaning. `highlight: true` or `==>` marks the one path the text is about. `color: red|green|blue|...` marks a category; say what it means in the doc.
- Cloud icons on architecture nodes: `icon: aws.lambda`, `gcp.cloud_run`, `azure.functions`, `k8s.pod`. Search with `linework icons aws lambda`.

| type | kinds (default first) |
|---|---|
| architecture | `service`, `person`, `client`, `function`, `database`, `cache`, `storage`, `queue`, `external` |
| flow | `step`, `decision`, `terminal`, `data`, `error` |
| state | `state`, `success`, `error`; start and end are `"[*] -> first"` and `"last -> [*]"`, quoted |
| sequence | `participants:` and `messages:` instead of nodes and edges; `-->` is a reply |
| er | `fields:` on nodes (`- id: uuid pk`), crow's-foot edges (`users }o--|| orgs: belongs to`) |

In a flow, keep decision text to a short question and label every edge leaving it (`window -> refund: "yes"`).

## More

- `references/spec.md`: every option, sequence blocks (`alt`, `loop`, notes), ER fields and cardinalities, themes, colors.
- `references/style-guide.md`: what makes a diagram read well. Read it before anything non-trivial.
- `references/troubleshooting.md`: download, browser and sandbox failures.
- `references/google-docs.md`: putting a diagram in Google Docs with `linework publish`.
- `linework help` lists every command, including `check`, `render`, `kinds`, `schema` and `git-setup` (readable `git diff` for diagrams).
