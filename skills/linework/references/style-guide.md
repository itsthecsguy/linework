# What makes a good design-doc diagram

Linework handles the layout and the look. These rules are about content, which is the part only you can get right.

## Scope

- **One diagram makes one point.** "How a checkout request flows" is a diagram. "Everything in the payments org" is a wiki page. When you need both the overview and the detail, draw two diagrams.
- **Aim for 12 nodes or fewer.** Past about 15, readers stop following edges. `build` warns at 20.
- **Pick a level of zoom and stay there.** Don't put "Kubernetes cluster" next to "parseOrder()" in the same diagram.
- **Leave out what the reader doesn't need.** Logging, metrics and auth sidecars can usually go unless the doc is about them.

## Naming

- Label nodes with the same words the doc text uses. If the prose says "Checkout API", don't label the node "checkout-svc".
- Use `tech` for the technology (`Postgres`, `Kafka`, `Go`), not for a description.
- Keep labels to about 3 words. A label that wraps to a third line means the node is doing too much.

## Edges

- **Label edges in architecture diagrams with the protocol or the verb**: `HTTPS`, `gRPC`, `SQL`, `publishes OrderPlaced`, `reads session`. An unlabeled arrow makes the reader guess.
- **Use `-.->` for async**: events, queues, webhooks, fire-and-forget. Readers rely on the solid/dashed distinction to see where latency and failure modes change.
- **Point the arrow the way the request goes**, not the way data comes back. Only show a return edge when the reply is interesting.
- **Label every edge out of a decision** in a flow (`yes`/`no`, or the condition). Keep those labels to a word or two: each one sits right beside its diamond, where the branch leaves it.
- In state diagrams, label transitions with the event that triggers them (`payment_succeeded`), not the resulting state.

## Groups

- **Draw groups along a real boundary**: a network (VPC), a trust boundary, a deployment unit or an owning team. Say which in the label, e.g. "Production VPC" or "Payments team".
- **Don't group just to tidy up.** Every box reads as a claim about how the system is structured.
- Keep external systems (`kind: external`) outside your groups.

## Color and emphasis

- **Start neutral.** The default style draws every node the same, so whatever you color stands out. Add color only when it tells the reader something.
- **Highlight one thing.** Put `highlight: true` on the component the section is about and `==>` on the 2 or 3 edges that make up its path. A reader's eye goes there first. If everything is highlighted, nothing is.
- **Color marks a category, and the doc says which.** Red for failure paths, green for what this proposal adds, gray for what's being removed. Write one sentence under the diagram that explains it, e.g. "New components are green."
- **Match a brand with `accent:`, not with color on every node.** `accent: "#E11D48"` at the top of the spec changes what highlights are drawn in and nothing else.
- **Use at most 2 or 3 colors** besides the highlight. More turns color back into noise.
- **Keep error and success kinds for real errors and successes.** They're red and green in every style.
- **Pick the style for the medium**: `clean` for docs and READMEs, `dark` for dark-mode pages, `soft` for slides, `sketch` for early drafts, `blueprint` for technical deep dives. Use one style across all the diagrams in a doc.

## Order

Layout reads the spec top to bottom, so the order you write things in shows up in the picture.

- **List nodes and edges in reading order**: the entry point first, then each step as the request or flow reaches it. A flow's main path then runs straight down, and an edge back to an earlier node (a retry, a resume) is drawn as the loop it is.
- **Write a reply after its call** (`api -> stripe`, then `stripe -.-> api`). The pair is drawn side by side.
- **In ER, name foreign keys after the table they point at**: `customer_id` for `customers`, `shipping_address_id` for `addresses`. The relationship line then attaches to that row and to the other table's primary key. A key named anything else attaches to the table as a whole.

## Direction

- Leave out `direction` on the first build. `auto` tries both and keeps the one that fits a doc page, which is about 800px wide. ER diagrams always run left to right, since relationships attach to the sides of the key rows.
- Set it only after looking at the result, and only if it reads wrong. A short linear pipeline of 5 or fewer steps can read better as LR.
- Don't force LR on a diagram with more than about 6 nodes in a row. It comes out 1,500px or more wide, and embedded in a doc its text shrinks to unreadable. `check` warns about this as `too-wide`.

## Checking your result

Look at the PNG and ask:
1. Could someone who hasn't read the doc say what this diagram shows in one sentence?
2. Does every node appear in the doc text, or matter to the point?
3. Does every edge say what goes across it?
4. Is anything here only because "it exists", not because it matters to the point?
