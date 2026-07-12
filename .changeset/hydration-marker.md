---
"@rpxd/cli": minor
---

The client entry stamps `<html data-rpxd-hydrated>` after `hydrateRoot`
commits. Interacting before hydration loses clicks or falls through to
native form submits; tests (and apps) can now gate interaction on the
marker instead of guessing with timeouts.
