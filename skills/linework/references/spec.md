# Linework spec reference

`linework schema` prints the full JSON Schema.

## Top level

| key | required | notes |
|---|---|---|
| `type` | yes | `architecture`, `flow`, `state`, `sequence` or `er` |
| `title` | no | stored in the file and used as the page name in draw.io |
| `direction` | no | `auto` (default), `TB`, `LR`, `BT` or `RL`. Not for sequence. |
| `theme` | no | the style: `clean` (default), `soft`, `dark`, `sketch`, `blueprint` or `c4` |
| `groups` | no | map of id to `{ label, in, color, highlight }`, or to a label string |
| `nodes` | yes | map of id to `{ label, kind, tech, in, icon, color, highlight }`, or to a label string |
| `edges` | no | list of edge strings, or `{ from, to, label, style, color, highlight }` objects |
| `participants` | sequence only | ordered map of id to `{ label, kind, tech }` |
| `messages` | sequence only | list of messages, notes and frames |

Unknown keys are errors, so typos surface right away.

## Nodes

```yaml
nodes:
  api: { label: Checkout API, kind: service, tech: Go, in: vpc }
  db: Orders                    # shorthand: just a label
  cache: {}                     # label "Cache", default kind
```

- `label` defaults to the id with `_`/`-` turned into spaces and the first letter capitalized.
- `kind` defaults to `service`, `step` or `state`, depending on the type.
- `in` names the group the node sits in.
- `highlight: true` draws the node in the style's accent color, solid. Use it for the one thing the doc is about.
- `color` tints it: `blue`, `violet`, `pink`, `red`, `orange`, `amber`, `green`, `teal` or `gray`. With `highlight`, it picks the highlight's color.

## Styles

| style | looks like | font |
|---|---|---|
| `clean` | white boxes with hairline borders, groups drawn as gray grounds, cobalt accent. Nodes are neutral unless the kind means something (error, success). | IBM Plex Sans |
| `soft` | borderless pastel cards, each kind its own tint | IBM Plex Sans |
| `dark` | `clean` in GitHub's dark colors, so it sits flush on a dark README | IBM Plex Sans |
| `sketch` | hand-drawn strokes, pastel fills, blue accent | Kalam (handwriting) |
| `blueprint` | blue ink on pale drafting paper, drafting capitals for group titles | IBM Plex Mono |
| `c4` | C4's colors (dark person, blue containers, gray external systems) in quiet tones; each box says its element type | IBM Plex Sans |

The "drawn as" columns below describe `soft`. In `clean`, `dark` and `blueprint`, kinds differ by shape and dash only, and color comes from `highlight`, `color` and the error/success kinds.

Linework embeds the font, subset to the characters the diagram uses (about 10 to 15KB), so the SVG looks the same on GitHub, in a browser and in docs.

### Architecture kinds

| kind | drawn as | use for |
|---|---|---|
| `service` | violet box | your own service, API or app server |
| `person` | pink box | a human user or role |
| `client` | blue box | browser app, mobile app, CLI |
| `function` | dashed violet box | serverless function, cron job, worker |
| `database` | green cylinder | relational or document database |
| `cache` | green box | Redis, Memcached, CDN |
| `storage` | green cylinder | object storage, file store, data lake |
| `queue` | amber pill | queue, topic, event stream |
| `external` | dashed grey box | a system you don't own |

### Flow kinds

| kind | drawn as | use for |
|---|---|---|
| `step` | grey box | an action |
| `decision` | amber diamond | a branch; label every outgoing edge |
| `terminal` | grey pill | start or end |
| `data` | blue parallelogram | input or output data |
| `error` | red box | rejection or failure path |

### State kinds

| kind | drawn as | use for |
|---|---|---|
| `state` | violet box | a state |
| `success` | green box | a good terminal state |
| `error` | red box | a failure state |

Write the initial and final pseudo-states as `[*]` in edges, as in Mermaid. Each `x -> [*]` gets its own end marker next to `x`.

## Groups

```yaml
groups:
  vpc: { label: Production VPC }
  data: { label: Data tier, in: vpc }   # nested
```

Edges connect nodes, not groups. To show "the API talks to the data tier", connect to the specific store.

## Edges

```yaml
edges:
  - a -> b                 # call / flow
  - a -> b: HTTPS          # with label
  - a ==> b: HTTPS         # highlighted (accent color, thicker)
  - a -.-> b: OrderPlaced  # async or event (dashed)
  - a <-> b: sync          # two-way
  - a -- b                 # association, no arrowhead
  - "[*] -> pending"       # state pseudo-state; quote lines starting with [
  - "a -> b: label: with colon"
```

For a colored edge, or a highlighted one that isn't a plain call, use the object form:

```yaml
  - { from: api, to: dlq, label: on failure, style: async, color: red }
  - { from: a, to: b, style: bidir, highlight: true }
```

The arrow needs a space on each side. Repeated edges between the same two nodes are allowed and get separate ids.

## Full examples

### Architecture

```yaml
type: architecture
title: Checkout
groups:
  vpc: { label: Production VPC }
  data: { label: Data tier, in: vpc }
nodes:
  user:    { label: Shopper, kind: person }
  web:     { label: Web app, kind: client, tech: Next.js }
  gw:      { label: API gateway, tech: Envoy, in: vpc }
  api:     { label: Checkout API, tech: Go, in: vpc }
  worker:  { label: Fulfillment worker, tech: Go, in: vpc }
  queue:   { label: order-events, kind: queue, tech: Kafka, in: vpc }
  db:      { label: Orders, kind: database, tech: Postgres, in: data }
  cache:   { label: Session cache, kind: cache, tech: Redis, in: data }
  stripe:  { kind: external, tech: Payments API }
  email:   { label: SendGrid, kind: external, tech: Email }
edges:
  - user -> web: browses
  - web -> gw: HTTPS
  - gw -> api: gRPC
  - api -> cache: read session
  - api -> db: SQL
  - api -> stripe: charge
  - api -.-> queue: OrderPlaced
  - queue -.-> worker: consume
  - worker -> db: update status
  - worker -> email: receipt
```

### Flow

```yaml
type: flow
title: Refund request
nodes:
  start:    { label: Refund requested, kind: terminal }
  lookup:   { label: Look up order }
  window:   { label: Within 30 days?, kind: decision }
  amount:   { label: Over $500?, kind: decision }
  auto:     { label: Auto-approve }
  review:   { label: Queue for manual review }
  approved: { label: Approved?, kind: decision }
  refund:   { label: Issue refund via Stripe }
  notify:   { label: Email customer }
  deny:     { label: Deny with reason, kind: error }
  done:     { label: Done, kind: terminal }
edges:
  - start -> lookup
  - lookup -> window
  - window -> amount: "yes"
  - window -> deny: "no"
  - amount -> auto: "no"
  - amount -> review: "yes"
  - review -> approved
  - approved -> refund: "yes"
  - approved -> deny: "no"
  - auto -> refund
  - refund -> notify
  - deny -> notify
  - notify -> done
```

### State

```yaml
type: state
title: Payment lifecycle
nodes:
  created:     {}
  authorizing: {}
  authorized:  {}
  captured:    { kind: success }
  failed:      { kind: error }
  voided:      {}
  refunded:    {}
edges:
  - "[*] -> created"
  - created -> authorizing: submit
  - authorizing -> authorized: approved
  - authorizing -> failed: declined
  - authorized -> captured: capture
  - authorized -> voided: void
  - captured -> refunded: refund
  - failed -> created: retry
  - "captured -> [*]"
  - "voided -> [*]"
  - "refunded -> [*]"
```

## Icons (architecture)

```yaml
nodes:
  fn:  { label: Resizer, kind: function, icon: aws.lambda }
  run: { label: API, icon: gcp.cloud_run }
  pod: { label: Worker pods, icon: k8s.deploy }
```

`linework icons aws` lists every AWS name (about 1,000); add a filter word to search. Common short names work too: `aws.s3`, `aws.sqs`, `aws.kms`, `aws.msk`, `gcp.pubsub`, `gcp.gke`, `k8s.service`, `k8s.ingress`. An unknown name is a warning, and the node is drawn without an icon.

## Sequence

```yaml
type: sequence
title: Card payment
participants:
  user:   { label: Shopper, kind: person }
  web:    { label: Web app, kind: client }
  api:    { label: Checkout API }
  stripe: { kind: external }
  db:     { label: Orders DB, kind: database }
messages:
  - user -> web: Click "Pay"
  - web -> api: POST /checkout
  - api -> db: insert order (pending)
  - db --> api: order id
  - api -> stripe: create PaymentIntent
  - stripe --> api: client_secret
  - api --> web: client_secret
  - web -> stripe: confirmCardPayment
  - alt:
      - when: succeeded
        do:
          - stripe -.-> api: webhook payment_succeeded
          - api -> db: mark paid
          - note over api, db: idempotent on event id
      - when: declined
        do:
          - stripe --> web: card_declined
          - web -> web: show error
  - web --> user: result page
```

| item | form |
|---|---|
| call | `a -> b: text` |
| highlighted call | `a ==> b: text` (accent color) |
| reply | `b --> a: text` (dashed, open arrow) |
| async | `a -.-> b: text` (open arrow) |
| self call | `a -> a: text` |
| note | `note over a: text`, `note over a, b: text`, `note left of a: text`, `note right of a: text` |
| branches | `- alt:` or `- par:` with a list of `{ when: condition, do: [items] }` |
| block | `- loop: label`, `- opt: label`, `- critical: label` or `- break: label`, each with `do: [items]` |

Frames nest. Keep it to 6 participants or fewer, so it fits a page.

## ER

```yaml
type: er
title: Billing schema
nodes:
  orgs:
    label: organizations
    fields:
      - id: uuid pk
      - name: text
  users:
    fields:
      - id: uuid pk
      - org_id: uuid fk
      - email: text unique
  invoices:
    fields:
      - id: uuid pk
      - org_id: uuid fk
      - paid_at: timestamptz null
edges:
  - users }o--|| orgs: belongs to
  - invoices }o--|| orgs: billed to
```

A field is `name: type flags`, a plain string `"name type flags"`, or `{ name, type, flags: [...] }`. Flags: `pk`, `fk`, `unique`, `null`. Kinds: `entity` (default), `view` (dashed) and `external` (a table another system owns).

Relationships use Mermaid's crow's-foot notation:

| left end | right end | means |
|---|---|---|
| `\|\|` | `\|\|` | exactly one |
| `\|o` | `o\|` | zero or one |
| `}o` | `o{` | zero or more |
| `}\|` | `\|{` | one or more |

The middle is `--` for an identifying relationship (solid line) or `..` for a non-identifying one (dashed).

## Importing Mermaid

`linework import file.mmd` prints a linework spec. `-o out.drawio.svg` builds it straight away. A Markdown file works too; use `--block N` when it has several Mermaid blocks. Supported: `flowchart`/`graph`, `stateDiagram`, `sequenceDiagram`, `erDiagram`.

A flowchart with diamonds becomes a `flow`. One with subgraphs or cylinders becomes an `architecture` diagram. In that case a `<br>` second line becomes `tech`, and kinds are guessed from shapes and names: a cylinder becomes a database, "Kafka" becomes a queue, "Stripe" becomes external. Mermaid styling (`classDef`, `style`, `click`) is dropped. Review the printed spec before building, and fix any kinds it guessed wrong.
