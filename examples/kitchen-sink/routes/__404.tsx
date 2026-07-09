/** Unmatched URL page (§14). Static — receives the missed path. */
export default function NotFound({ path }: { path: string }) {
  return (
    <main data-testid="not-found">
      <h1>Nothing at {path}</h1>
      <a href="/">Back to todos</a>
    </main>
  );
}
