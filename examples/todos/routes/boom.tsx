import type { RenderProps } from "@rpxd/client";
import { live } from "@rpxd/core";

/** Exists to exercise the __error page: mount always rejects (§10). */
export default live("/boom")({
  mount: async () => {
    throw new Error("mount exploded");
  },
})((_props: RenderProps<Record<string, never>>) => <main>never rendered</main>);
