# Working on linework

This file is for whoever changes this repo, person or agent. The guide for *using* linework is `skills/linework/SKILL.md`.

Linework turns a YAML spec into a `.drawio.svg`. It lays the diagram out with ELK, then draws, measures and lints it with draw.io's own code running in headless Chromium, so most of what it does needs a browser.

## Check your work

```bash
npm run verify      # typecheck, build dist/, run every test. Run this before you call a change done.
npm run test:unit   # only the tests that need no browser (about 4s)
npm run doctor      # is this machine able to draw? Says what to fix if not.
npx vitest run test/cli.test.ts            # one file
npx vitest run -t "keeps each branch"      # one test by name
```

- `npm test` alone does not rebuild `dist/`. `test/daemon.test.ts` runs the compiled CLI, so it tests the old build until you run `npm run build`. `npm run verify` does both.
- The tests find a browser the way the tool does: `LINEWORK_CHROME`, Playwright's Chromium, Chrome, Edge, then any Chromium-family browser on PATH. With none, the run stops at once and says so. `npm run dev -- install-browser` downloads one.
- The suite takes about 45s. Nothing in it reaches the network.

## See what a change does

Run the CLI from source and read its output as data:

```bash
npm run dev -- build examples/checkout.yaml -o /tmp/c.drawio.svg --png /tmp/c.png --json
npm run dev -- check /tmp/c.drawio.svg --json     # exit 1 on lint errors
npm run dev -- show /tmp/c.drawio.svg             # the spec the file holds
```

`--json` puts one document on stdout: `{ "ok": true, "stats": {...}, "check": { "errors": 0, "warnings": 0, "findings": [...] } }`, or `{ "ok": false, "error": { "kind": "spec" | "usage" | "error", "message": ... } }`. Exit codes: 0 done, 1 failed or found a problem, 2 bad usage. Open the PNG to look at the picture: lint can't tell that a layout is lopsided.

`npm run dev` runs from source and starts a browser each time (about 1s). The built CLI (`node dist/cli.js`) keeps one running in a background process, which a rebuild of `dist/` replaces; `LINEWORK_NO_DAEMON=1` turns it off.

After a change to layout or rendering, rebuild the README gallery and look at the diff: `npm run build && node docs/gallery/build.mjs`.

## Where things are

| path | what |
|---|---|
| `src/cli.ts` | entry point: parses arguments, hands drawing commands to the background process |
| `src/commands.ts` | every command, written against an output sink (`IO`) so tests and the daemon can run them in-process |
| `src/api.ts` | `build`, `show`, `tidy`, `render`, `importExcalidraw`: the programmatic API the CLI and MCP server share |
| `src/spec/` | the spec: zod schema, parser, error messages (`parse.ts`), types and node kinds (`model.ts`) |
| `src/layout/` | ELK layout, plus the hand-written sequence and timeline layouts |
| `src/drawio/` | writing draw.io XML (`write.ts`, `theme.ts`), reading it back to a spec (`read.ts`, `show.ts`), merging a spec into a hand-edited file (`merge.ts`) |
| `src/render/browser.ts` | headless draw.io: measure text, render, inspect geometry, reroute edges; also finds the browser |
| `src/lint/` | `check` (layout lint, from the geometry draw.io produced) and label fixing |
| `src/excalidraw/` | export to and import from Excalidraw |
| `src/mcp/server.ts` | the MCP server: the same operations as tools |
| `src/doctor.ts` | `linework doctor` |
| `assets/drawio/` | vendored draw.io (Apache-2.0). Don't edit; update with `npm run assets` |
| `skills/linework/` | the agent skill that ships in the package. Its `examples/` mirror `examples/` |
| `test/` | vitest. `cli.test.ts` drives commands the way a script does; `e2e.test.ts` and `styles.test.ts` build every example |

## Rules of the house

- **A spec error is written for a model to act on.** Say what is wrong, where (`edges[0]`), and what to write instead. Never let a bad spec reach a stack trace.
- **Nothing a person arranged by hand moves** unless they pass `--relayout`. A change that touches `merge.ts` or `build` needs a test in `test/merge.test.ts` or `test/editing.test.ts` that proves it.
- **`build` then `show` then `build` gives the same file.** `test/e2e.test.ts` checks it for every example. A new spec field has to survive that trip, so it needs writing (`write.ts`), reading (`show.ts`) and printing (`toYaml`).
- **The CLI, the MCP server and the skill stay in step.** A new command or option goes in `USAGE` in `src/commands.ts` (a test fails if a command is missing from it), the commands table in `README.md`, and `skills/linework/SKILL.md` if an agent should use it.
- **`--json` field names are a contract.** Add fields; don't rename or remove them.
- Output is deterministic: the same spec gives the same bytes. No timestamps or random ids in files.
- Don't commit build output: `dist/` is ignored and built in CI and on publish.
