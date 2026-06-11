# UI redesign reference (v1.5)

Output of the Claude Design session (2026-06): the chosen concept is
**"dashboard home + two-panel work view"** — Concept B's dashboard as the
landing screen, Concept A's two-panel shell for the work, a single toolbar as
the only navigation chrome (brand = Home).

| File                       | Content                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `full-design.dc.html`      | Full design: tokens, row states, dashboard, work view, editor, settings, dialogs — with rationale per block |
| `interactive-demo.dc.html` | Clickable review-loop demo (keyboard-first, zero layout shift)                                              |
| `support.js`               | Runtime the `.dc.html` files need — open the HTML files in a browser from this folder                       |

The design tokens and the binding rules (status = hue + glyph + edge; only
hover/selection tint rows; gold = brand only; zero-layout-shift editor) are
recorded in SPEC.md §7.0. Rollout order lives there too.
