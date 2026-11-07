# Launch posts

Attach `linework-launch.mp4` to the first post on X and LinkedIn. Use `poster.png` as the thumbnail where a platform asks for one.

## X thread

**1/**

I built Linework, a diagram tool for coding agents.

Ask Claude Code, Codex or Cursor for an architecture diagram and you get a clean `.drawio.svg` in your docs. It renders on GitHub like any SVG and opens in draw.io when you want to fix something by hand.

[video]

**2/**

Agents are bad at drawing. Mermaid gets you boxes in a pile, and hand-written SVG is worse.

So the agent doesn't draw. It writes about ten lines of YAML, and Linework does the layout (ELK), the styling and the rendering (draw.io's own renderer).

**3/**

The part I care about most is that edits survive. Drag a box in draw.io and save. The next time the agent changes the diagram, it merges into your layout instead of redrawing it.

**4/**

It does architecture, flows, sequences, state machines and ER, with AWS, GCP, Kubernetes and Azure icons. Six styles, one line to switch. It also lints its own output for overlaps, edges through boxes and labels that don't fit, and fixes what it can.

**5/**

One command installs it for whichever agents you have:

`npx skills add itsthecsguy/linework`

Open source, MIT. github.com/itsthecsguy/linework

## LinkedIn

I built a diagram tool for coding agents, and it's out today.

Ask your agent for an architecture diagram and you usually get Mermaid boxes in a pile, or an SVG it wrote by hand that you can never touch again. I wanted the diagram a careful designer would draw, in a file I could still edit myself.

Linework splits the job. The agent writes a short YAML spec of what connects to what. Linework does the layout, styling and rendering, then checks its own output for overlaps, edges running through boxes and labels that don't fit. You get a `.drawio.svg`. It's a normal SVG on GitHub and in your docs, and it's also a full draw.io file. Move a box by hand, and the agent's next change keeps your layout.

It covers architecture, flows, sequences, state machines and ER diagrams, plus AWS, GCP, Kubernetes and Azure icons, in six styles. It works with Claude Code, Codex, Cursor, Antigravity, Copilot and any agent with a shell:

npx skills add itsthecsguy/linework

It's open source under MIT: github.com/itsthecsguy/linework

## Show HN

**Title:** Show HN: Linework, diagrams your coding agent draws and you can edit in draw.io

**URL:** https://github.com/itsthecsguy/linework

**Text:**

Linework is a CLI, an MCP server and an agent skill. It turns a short YAML spec into a `.drawio.svg`, a plain SVG that GitHub renders, with the whole draw.io model embedded so the same file opens in draw.io.

I built it because I kept asking agents for architecture diagrams and getting Mermaid I didn't want to ship, or SVG nobody could edit. Models are fine at describing a system and bad at placing boxes, so Linework asks for the description and does the rest:

- ELK for layout, then draw.io's own renderer, running headless in Chromium, for text measurement and drawing.
- Boxes sized from the measured width of each label in the font they render with. Each SVG embeds a font subset of about 10 to 15KB, so the text fits the same way everywhere.
- A lint pass over the geometry draw.io produced (overlaps, edges through nodes, label collisions). Build moves labels and reroutes edges with libavoid until the check is clean.
- Round trips. `linework show` reads a file back into a spec, hand edits included, and a rebuild merges into the existing layout instead of laying it out again.

Six styles (clean, soft, dark, sketch, blueprint, C4). Architecture, flow, sequence, state and ER diagrams, AWS, GCP, Kubernetes and Azure icons, and a Mermaid importer.

Install the skill with `npx skills add itsthecsguy/linework`, or try the CLI with no agent:

    printf 'type: flow\nnodes: { a: Hello, b: World }\nedges:\n  - a -> b\n' | npx -y @itsthecsguy/linework build - -o hello.drawio.svg

Known gaps. It needs a Chromium-based browser, and some agent sandboxes (Codex's) block Chrome, so there's a `linework install-browser` command for that. I haven't tested the Google Docs add-on round trip with a real account yet.

I'd like to hear where the layouts go wrong for you.
