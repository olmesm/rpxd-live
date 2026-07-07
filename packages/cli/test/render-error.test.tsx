import { describe, expect, it, vi } from "vitest";
import { makeShellRenderers, renderDevErrorPage } from "../src/render.ts";

function ErrorPage({ path, message }: { path: string; message: string }) {
  return (
    <main data-testid="error-page">
      {path}: {message}
    </main>
  );
}

describe("prod error hardening (§10)", () => {
  it("never leaks the error message; logs it server-side with a ref id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { renderError } = makeShellRenderers({ ErrorPage }, { mode: "prod" });
    const res = renderError?.({ path: "/boom", error: new Error("db password is hunter2") });
    expect(res?.status).toBe(500);
    const html = await res?.text();
    expect(html).not.toContain("hunter2");
    expect(html).toMatch(/ref: [0-9a-f]{8}/);
    // the real error went to the server log, tagged with the same ref
    const logged = log.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("hunter2");
    const ref = /ref: ([0-9a-f]{8})/.exec(html ?? "")?.[1] as string;
    expect(logged).toContain(ref);
    log.mockRestore();
  });

  it("keeps the real message in dev mode", async () => {
    const { renderError } = makeShellRenderers({ ErrorPage }, { mode: "dev" });
    const res = renderError?.({ path: "/boom", error: new Error("mount exploded") });
    const html = await res?.text();
    expect(html).toContain("mount exploded");
  });
});

describe("dev error overlay page (§14)", () => {
  it("renders message + stack, HTML-escaped", async () => {
    const error = new Error("broke <script>alert(1)</script>");
    const res = renderDevErrorPage("/x", error);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("rpxd-dev-error");
    expect(html).toContain("broke &lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("render-error.test"); // a stack frame from this file
  });

  it("stringifies non-Error throws", async () => {
    const html = await renderDevErrorPage("/x", "plain string throw").text();
    expect(html).toContain("plain string throw");
  });
});
