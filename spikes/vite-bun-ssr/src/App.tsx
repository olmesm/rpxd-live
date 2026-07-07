/** Minimal component rendered on the server to prove SSR works under Vite-on-Bun. */
export function App({ now }: { now: string }) {
  return (
    <main>
      <h1 data-testid="ssr-marker">rpxd vite-on-bun smoke</h1>
      <p>rendered at {now}</p>
    </main>
  );
}
