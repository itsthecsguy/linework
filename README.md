# Linework

Software diagrams an AI can write and a person can edit by hand. The CLI is `aiviz`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero/hero-dark.png">
  <img alt="A design doc with an architecture diagram. In front of it, the ten-line YAML spec that drew it." src="docs/hero/hero-light.png">
</picture>

An agent writes a short YAML spec. aiviz lays it out with ELK, styles it, and writes a `.drawio.svg`. That's an ordinary SVG that renders in Markdown, on GitHub and in HTML, and it carries the full draw.io model. Open it in draw.io, move things around, save, and the same file updates.

Later the agent runs `aiviz show` to get the spec back, hand edits included, changes it and rebuilds. The rebuild merges into your layout. Your boxes stay where you put them, new ones go next to their neighbours, and only the edges that need it get rerouted (with draw.io's own libavoid router).

```yaml
type: architecture
nodes:
  web: { label: Web app, kind: client, tech: Next.js }
  api: { label: Checkout API, tech: Go }
  db:  { label: Orders, kind: database, tech: Postgres }
edges:
  - web -> api: HTTPS
  - api -> db: SQL
```

```bash
npx -y aiviz build spec.yaml -o docs/checkout.drawio.svg --png /tmp/preview.png
```

It draws architecture, flow, state, sequence and ER diagrams, with AWS, GCP, Kubernetes and Azure icons. It also converts Mermaid.

## Styles

Set `theme:` in the spec.

| style | for |
|---|---|
| `clean` (default) | docs and READMEs. White boxes with hairline borders on gray group grounds, IBM Plex Sans. |
| `soft` | slides. Borderless pastel cards, tinted by kind. |
| `dark` | dark-mode pages |
| `sketch` | early drafts. Hand-drawn lines and a handwriting font. |
| `blueprint` | technical deep dives. Light lines on deep blue, monospace. |
| `c4` | C4-model diagrams |

Color is for meaning. Nodes stay neutral by default, and errors and successes are red and green in every style. Mark the part the doc is about with `highlight: true` on a node or `==>` on an edge, and it's drawn in the style's accent color. Use `color: red` (or blue, violet, pink, orange, amber, green, teal, gray) for categories.

aiviz sizes every box from the real width of its text in the font it renders with, wrapping long labels instead of widening boxes. Each SVG carries a subset of that font (about 10 to 15KB), so text fits the same way on GitHub, in a browser or in a doc. `check` flags labels that overflow, overlap a box, another label, another edge or a group border, and `build` moves edge labels until they're clear.

aiviz needs Node 20+ and a Chromium-based browser, which it uses headless to measure text and render. It tries Playwright's Chromium, then Chrome, then Edge. If none is found, run `npx playwright install chromium`, or set `AIVIZ_CHROME` to a browser binary.

## Set it up for your agent

**Agents that load skills** (Claude Code, Codex, Cursor, Gemini CLI and others that read `SKILL.md`):

```bash
npx -y aiviz skill install .claude/skills      # or wherever your agent looks for skills
```

**Chat apps and agents without a shell** use the MCP server. Add this to the app's MCP config (Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "aiviz": { "command": "npx", "args": ["-y", "aiviz", "mcp", "--root", "/path/to/your/docs"] }
  }
}
```

For Claude Code: `claude mcp add aiviz -- npx -y aiviz mcp`. Relative paths in tool calls resolve against `--root`, which defaults to the folder the server starts in. The tools are `build_diagram`, `show_diagram`, `check_diagram`, `render_diagram`, `tidy_diagram`, `import_mermaid`, `list_icons`, `edit_diagram`, `publish_diagram`, and `aiviz_guide`, which hands the model the spec format and style rules. `build_diagram` returns a PNG preview, so a model that can see images checks its own work.

**Anything else:** add a line to your AGENTS.md:

```markdown
For diagrams, use aiviz. Read the guide first: run `npx -y aiviz skill` for its path, then read SKILL.md there.
```

## Editing by hand

Any draw.io editor works on these files: draw.io desktop, VS Code with the Draw.io Integration extension, or app.diagrams.net. Or:

```bash
npx -y aiviz edit docs/checkout.drawio.svg
```

That opens the bundled draw.io editor in your browser, served from 127.0.0.1. Nothing goes online. Cmd/Ctrl+S writes the file. If an agent rebuilt the file while you had it open, your save goes to a side copy (`checkout.edited-<time>.drawio.svg`) instead of overwriting the agent's work.

## Google Docs

Docs can't hold an SVG, so the diagram lives in Google Drive and draw.io's Google Docs add-on inserts it and refreshes it. `aiviz publish` copies diagrams into your Drive folder (via Google Drive for desktop) at a fixed path, and `--pull` brings back edits made from the doc. The steps are in [skill/aiviz/references/google-docs.md](skill/aiviz/references/google-docs.md).

## Commands

| command | does |
|---|---|
| `aiviz build <spec\|-> -o out.drawio.svg [--png p.png] [--relayout]` | layout (or merge into an existing file), write, lint |
| `aiviz show <file> [--geometry]` | print the spec of a diagram, including hand edits |
| `aiviz edit <file> [--no-open]` | edit in the bundled draw.io, in your browser; saves write the file |
| `aiviz check <file>` | lint: overlaps, edges through nodes, labels that don't fit, too wide |
| `aiviz render <file> -o out.png [--scale 2]` | preview image |
| `aiviz tidy <file>` | reroute edges that pass through nodes, change nothing else |
| `aiviz import <file.mmd\|doc.md> [-o out.drawio.svg]` | convert a Mermaid diagram |
| `aiviz publish <file...> [--to dir] [--pull]` | copy diagrams into Google Drive for the Docs add-on |
| `aiviz icons <aws\|gcp\|k8s\|azure> [filter]` | list icon names |
| `aiviz git-setup` | `git diff` shows diagram changes as spec changes |
| `aiviz skill [install <dir>]` | print or install the agent skill |
| `aiviz mcp [--root dir]` | MCP server over stdio |
| `aiviz kinds [type]` | node kinds per diagram type |
| `aiviz schema` | JSON Schema of the spec |

## Status

All four phases of [PLAN.md](PLAN.md) are built. Two paths haven't been tried yet, because they need a real account or app: the Google Docs add-on round trip, and saving from the VS Code Draw.io Integration extension. Both use the same file format and protocol that the tests cover with draw.io's own editor.

## Development

```bash
npm install
npm test             # unit, round-trip, MCP and end-to-end tests (needs Chromium)
npm run build        # compile to dist/
npm run dev -- build examples/checkout.yaml -o out/checkout.drawio.svg --png out/checkout.png
```

`assets/drawio` holds the parts of the draw.io web app that aiviz runs: the renderer it uses headless, and the editor behind `aiviz edit`. draw.io is Apache-2.0; see [NOTICE](NOTICE). To update it, check out a jgraph/drawio tag in `vendor/drawio` and run `npm run assets`.
