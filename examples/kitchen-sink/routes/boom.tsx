import { live } from "@rpxd/core";

/** Exists to exercise the __error page: setup always throws (§10). */
export default live("/boom")
  .setup((): { never: true } => {
    throw new Error("setup exploded");
  })
  .render(() => <main>never rendered</main>);
