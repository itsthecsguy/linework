# Team config: linework.yaml

A `linework.yaml` in a repo makes every diagram in it use the same theme, names and rules, whoever or whatever draws it. Linework finds it by walking up from the diagram file. Run `linework config` to print what applies where you are, and `linework config init` to write a starter file.

```yaml
extends: "@acme/linework-config"   # an npm package or a ./path; this file wins where both set something

theme: acme            # theme for specs that don't name one
lockTheme: true        # a spec may not pick another
direction: TB
out: docs/diagrams     # where new diagrams go
templates: docs/diagrams/templates   # starter specs for "linework new"

themes:                # your own, built on a built-in one
  acme:
    extends: clean     # clean | soft | dark | sketch | blueprint | c4 | paper | midnight | mono | bold
    text: "#0B1F33"    # every color is hex
    muted: "#4A5D70"   # the second line of a box
    box: "#FFFFFF"
    border: "#9DB2C7"
    edge: "#6B8299"
    edgeText: "#3D5166"
    canvas: "#FFFFFF"
    groupFill: "#EEF4FA"
    groupText: "#3D5166"
    accent: "#0A6E5C"  # highlights: a hex color, or blue, violet, pink, red, orange, amber, green, teal, gray
    radius: 4
    lineWidth: 1.25
    font:              # WOFF2, TTF or OTF files, relative to this file
      family: Acme Sans
      regular: fonts/AcmeSans-Regular.woff2
      bold: fonts/AcmeSans-SemiBold.woff2

statuses:              # what a color means, once, for every diagram
  new: green
  deprecated: { color: gray, label: Being retired }
  failure: red
legend: true           # draw a legend for the statuses a diagram uses

components:            # systems many diagrams share
  stripe: { label: Stripe, kind: external, tech: Payments }
  orders-db: { label: Orders, kind: database, tech: Postgres }

kinds:                 # extra node kinds: architecture, flow and state
  architecture:
    ml-model: { shape: pill, color: teal, icon: aws.sagemaker, description: a trained model served online }

naming:
  case: sentence       # sentence | title | any
  maxLength: 28
  banned: [microservice, "new"]

limits: { nodes: 12, width: 1200 }
rules:                 # off | warn | error, by the name in [brackets] after a finding
  raw-color: error
  hand-styled: off
handStyles: keep       # keep | reset: what a build does with colors changed in draw.io
```

## What each part does

- **Themes.** A theme whose text falls under a 4.5:1 contrast against what it sits on is rejected, with the pair named. Text is measured and drawn in the team font, and each SVG carries a subset of it.
- **Statuses.** Write `status: new` on a node, group or object-form edge instead of `color: green`. With statuses defined, a bare `color:` gets a `raw-color` finding that names the status to use.
- **Components.** A node whose id matches gets the shared label, kind, tech and icon for any field the spec leaves out: `stripe: {}`. A spec that sets one differently gets a `component-drift` finding.
- **Rules.** Layout rules (`overlap`, `edge-through-node`, `too-wide`, ...) and team rules (`off-theme`, `raw-color`, `component-drift`, `naming-case`, `naming-length`, `naming-banned`, `hand-styled`) all take a level.

## Keeping a repo consistent

```bash
linework lint docs            # every diagram under docs; exit 1 on errors, --strict on warnings too
linework restyle docs         # bring old diagrams to the current theme; boxes stay where they are
```

GitHub Actions:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx -y @itsthecsguy/linework install-browser
- run: npx -y @itsthecsguy/linework lint docs --strict
```

A pre-commit hook, in `.git/hooks/pre-commit` or your hook manager:

```bash
git diff --cached --name-only --diff-filter=ACM | grep '\.drawio\(\.svg\)\?$' | xargs -r npx -y @itsthecsguy/linework lint
```

## Sharing one config across repos

Publish a package whose root holds a `linework.yaml` (plus any font files it names), and have each repo's file start with `extends: "@acme/linework-config"`. A path works too: `extends: ../shared/linework.yaml`. Maps (themes, statuses, components, kinds, rules) merge key by key; everything else is replaced by the repo's value.
