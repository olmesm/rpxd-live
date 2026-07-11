# Documentation style guide

How to write rpxd's user-facing markdown: the root README, `packages/*/README.md`,
and every page under `docs-site/src/content/docs/`. Internal documents
(`spec.md`, `CLAUDE.md`, `docs/adr/`, `docs/reviews/`) are exempt — they may use
spec references and internal shorthand freely.

The goal: simple and brief, like a good open-source project. Keep the honest,
technically precise character; simplify the register, don't add marketing fluff.

## Voice

- **Open with the reader's goal.** The first sentence of every page says, in
  plain English, what the thing is or what the reader will accomplish. Not a
  definition, not an aphorism, not an architecture claim.
- **Short sentences, one idea each.** If a sentence needs two em-dashes or a
  nested parenthetical, split it. Restructure rather than delete — keep every
  technical fact.
- **No contributor voice in user docs.** Design justifications aimed at
  framework developers ("don't gold-plate it") belong in ADRs or spec.md.
  Explaining *why* a feature is absent is fine when it preempts a real user
  question.
- Honest caveats are a house strength. Keep them, with the remedy next to the
  risk.

## Vocabulary

- **Gloss insider terms at first use per page**, or use plain language instead:
  ack (the server's acknowledgment of an rpc), envelope (a message on the
  wire), cold wake (an instance rebuilt from its snapshot), warm instance,
  seam, userland (your app code).
- **Never use "tier 2" / "tier 3"** in user docs. Say "same-route navigation
  (the connection is reused)" or "a route change (new connection)".
- Expand acronyms once per file: RSC → React Server Components, Flight →
  React's Flight format (the RSC serialization).

## References

- **No `§N` spec references** in user-facing files. Link to the relevant docs
  page, or to `spec.md`, or drop the reference. `spec.md` keeps its own
  §-numbering; `wire-protocol.md` (the normative mirror) may cross-reference
  the spec by link.
- **No issue numbers or source paths** (`#73`, `packages/client/src/store.ts`)
  in docs-site pages. Claims stand on their own.
- "Snapshots are continuity, not cache" is explained once, on the
  [persistence page](../docs-site/src/content/docs/concepts/persistence.md) —
  link it, don't re-explain it.

## Package READMEs

Every `packages/*/README.md` follows this shape:

1. `# @rpxd/<name>`, then one plain sentence of what it does for the user.
2. An install line — `bun add @rpxd/<name>` — with the one-line caveat while
   unpublished: "Not yet on npm — work from a clone of the repo for now."
3. An audience-routing sentence for internal packages: who normally gets this
   wired automatically, and when you'd import it directly (e.g. "`rpxd dev`
   uses this internally; import it directly to embed rpxd in your own Bun
   server").
4. The content: what lives here, a small runnable example, honest caveats.
5. A closing link to the docs site: <https://olmesm.github.io/rpxd-live/>.

## Patterns worth copying

- **pubsub's "The three calls"** — name each primitive, one line each, then a
  complete example.
- **ssr's "Guarantees"** — bold user-facing promises with one-line explanations.
- **deploying's checklist** — each item states default → risk → fix.
- **pagination's headings** — the recommendation embedded in the heading
  ("Cursor-based (recommended for feeds)").
- **cli-generators' "Write one by hand first"** — respectful, anti-magic.
- Recommendations over surveys: when there's a right default, say so.

## What not to do

- Don't grow pages. Aim for equal or shorter after any edit.
- Don't change code examples while editing prose — code semantics are locked
  by the test suite, not the docs.
- Don't blandify. "`BORING=me rpxd dev`" is the register to aim for: plain,
  human, a little fun.
