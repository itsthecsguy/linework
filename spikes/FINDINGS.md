# Phase 0 spike findings

Short version: the design holds up. draw.io keeps our metadata through real edits, its own renderer works headless, and with the right ELK settings the output looks better than Mermaid on three of the four diagram types. The other one is a tie. Two plan changes came out of it, around fonts and edge routing after manual moves. Two questions still need a human: Google Docs and the VS Code extension.

## What I built

| File | Purpose |
|---|---|
| `lib/build.mjs` | YAML spec → elkjs → mxGraph XML with `<object>` metadata |
| `lib/sequence.mjs` | custom sequence layouter on draw.io's native lifeline and frame shapes |
| `lib/theme.mjs` | candidate "clean" theme |
| `lib/drawio.mjs` | headless draw.io from the vendored webapp, used to render `.drawio.svg` and PNG |
| `roundtrip.mjs` | loads a diagram into the real editor via the embed protocol, edits it, saves, checks metadata |
| `reroute.mjs` | moves a node in the editor, reroutes its edges with libavoid |
| `specs/`, `mermaid/` | the same four diagrams as aiviz specs and as Mermaid |

Run with `node run.mjs`, `node roundtrip.mjs` and `node reroute.mjs`. Output goes to `out/`. The draw.io source is a sparse clone in `../vendor/drawio`.

## Results

### 1. Metadata survives a real editor save: pass

`roundtrip.mjs` drives draw.io through the JSON embed protocol, the same one the VS Code extension uses. It moves a node, rewrites a label, restyles a node, and adds a shape and an edge by hand. Then it exports `xmlsvg`, which is what gets written to a `.drawio.svg`. Every check passed:

- `aiviz_kind`, `aiviz_tech` and the group and edge ids survive on every cell
- `aiviz_auto`, the position the layout engine assigned, survives. The moved node's real geometry now differs from it, so pin detection works exactly as planned
- a relabeled node keeps its metadata
- the hand-added shape comes back as a plain `mxCell` with no metadata, as expected

Gotchas:
- On save, draw.io **compresses** the model, deflate plus base64. `show` has to inflate it, and readable `git diff` needs the textconv driver from the plan.
- Editing a label in the editor replaces our two-line HTML label, so the `tech` subtitle disappears from the label text. The `aiviz_tech` attribute is still there. The fix for MVP is to render labels from attributes with draw.io's `placeholders=1`, or to rebuild the label on the next `build`.
- A hand-added shape gets draw.io's default black-on-white style. `build` should restyle shapes it doesn't recognize by inferring their kind.

### 2. Rendering with draw.io's own engine: pass, and it's the decision

`lib/drawio.mjs` serves the vendored webapp, loads `app.min.js` into headless Chromium, and calls `Graph.getSvg`. Output is a proper `.drawio.svg` with the model in its `content` attribute. Because the editor uses the same engine, a diagram looks the same before and after a human saves it. I checked this by rendering the editor-saved file through a plain `<img>`, the way GitHub shows it.

**Decision: use draw.io's renderer and don't write our own SVG.** The cost is a Chromium dependency, which is fine if we download it lazily.

### 3. Layout and theme quality against Mermaid: pass, after one fix

Side-by-side sheets are in `out/_cmp-*.png`.

| Diagram | Verdict |
|---|---|
| Architecture | aiviz is clearly better. Kind colors, a tech subtitle, quieter edges and group boxes that read as boundaries. Mermaid runs the `charge` edge down the full height of the page. |
| Flow | Mermaid won at first. ELK's default `NETWORK_SIMPLEX` placement leaned the whole chart right. **`BRANDES_KOEPF` with `BALANCED` alignment** fixed it, and aiviz is now more compact and balanced than Mermaid. That's the new default. |
| State | aiviz is better on looks and layout. Three edges converging on the 24px end dot pile up, so we need port spreading or a larger end node. |
| Sequence | A tie. Mermaid's sequence renderer is already decent. The win here is editability, not looks. |

Other layout lessons:
- **Direction has to be chosen automatically.** Left-to-right put the architecture diagram at 6:1, useless in a doc. `direction: auto` lays out both ways and picks the aspect ratio nearer 1.6. It chose top-to-bottom for both architecture and state.
- **Edge labels need ELK's position.** draw.io centers labels on the path by default, and long edges end up with labels far from where ELK reserved space. Projecting ELK's label center onto the route and writing it as draw.io's relative label position fixed it.
- Inter-layer spacing is still too generous when edges carry labels. That's tuning work for MVP.

### 4. Edges after a manual move: the plan needed this change

Moving a node in the editor leaves its ELK bend points stale, and edges loop back through the moved node (`out/checkout.edited.img.png`). I tried two fixes:

- **Dropping ELK bend points and letting draw.io's orthogonal router handle everything is worse.** Edges cross through nodes before anyone has moved anything (`out/_wp-compare.png`).
- **draw.io's bundled libavoid router fixes it.** Running it on only the moved node's edges gives clean routes and leaves every other ELK route alone (`out/checkout.rerouted.img.png`).

**Decision:** ELK places nodes and routes edges for the first build. On merge, `build` runs libavoid on edges whose endpoints are pinned or moved. In the editor, people can run Arrange › Layout › Orthogonal routing. Newer draw.io builds can also attach libavoid to a container as a live `childLayout`, so edges reroute while you drag. That's worth turning on if the VS Code extension's bundled draw.io supports it. It may not, since the extension ships 29.6.10.

### 5. Fonts: the plan needed this change

When the editor saves, draw.io embeds the web font from `fontSource` as base64. With Google Fonts' Inter that pulls in every unicode subset, and one diagram grew from 52 KB to **918 KB**. Our own headless render doesn't embed the font, so in an `<img>` on a machine without Inter it would fall back to the browser default, probably a serif.

**Decision for MVP:** serve our own latin-only Inter CSS, around 25 KB per weight, as the `fontSource`, so editor saves embed a small file. `aiviz render` should embed the same subset. The fallback is a system font stack with no embedding, which looks slightly different on each OS.

### 6. What already exists (research agent, web sources)

- **jgraph/drawio-mcp** is official, Apache-2.0, with about 5.8k stars. It ships an MCP server and a Claude Code skill. The LLM writes raw mxGraph XML with rough coordinates, then the draw.io CLI runs `--layout` (ELK presets or libavoid) and exports `.drawio.svg`. It has **no semantic spec, no theme system, and its layout runs over the whole diagram**, so manual moves are lost when the AI edits again. That gap is exactly what aiviz is for. Its `xml-essentials.md` style reference is worth borrowing.
- next-ai-draw-io has about 36.7k stars and Agents365-ai/drawio-skill about 10.6k. Both have the LLM write XML, with no layout or with Graphviz placement.
- I found no npm library that converts elkjs output to mxGraph. Ours is about 200 lines, so that's fine.
- Structurizr stores manual positions outside its DSL and matches them back by id. Eraser resets your drags after a significant code edit. Nobody does "AI edits, human drags, AI edits again" well.
- jgraph/draw-image-export2 was archived in September 2026, so don't depend on it. Driving the webapp directly the way `lib/drawio.mjs` does is the better route anyway.

## Still open, and needs you

1. **Google Docs add-on.** The draw.io docs say the add-on can insert `.drawio.svg` files from Drive and update them after edits. Verifying that takes a Google account. To test: upload `out/checkout.drawio.svg` to Drive, insert it in a Doc with Extensions › draw.io › Insert, edit the file in draw.io, then run Update in Docs.
2. **VS Code extension.** It uses the same embed protocol I tested, so I expect it to pass. But it bundles an older draw.io, 29.6.10, and I haven't installed it on your machine. To test: install `hediet.vscode-drawio`, open `out/checkout.drawio.svg`, move a node, save, and run `node roundtrip.mjs`-style checks on the result. I can script that check if you install the extension.

## Changes to PLAN.md

- Renderer: draw.io's engine in headless Chromium, settled.
- ELK defaults: `BRANDES_KOEPF` balanced placement, `direction: auto`, labels positioned from ELK.
- Merge: libavoid reroutes edges touching pinned nodes.
- Fonts: a self-hosted latin subset as `fontSource`.
- Labels: build them from attributes so editor label edits don't strand metadata.
- Positioning: aiviz is the semantic and round-trip layer on top of draw.io. It doesn't compete with jgraph's MCP. If their MCP stays maintained, an aiviz MCP could hand finished files to it for in-chat editing.
