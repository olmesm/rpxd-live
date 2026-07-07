import { live } from "@rpxd/core";

/** Exists to exercise the __error page: mount always rejects (§10). */
export default live("/boom")
  .mount(async (): Promise<{ never: true }> => {
    throw new Error("mount exploded");
  })
  .render(() => <main>never rendered</main>);
