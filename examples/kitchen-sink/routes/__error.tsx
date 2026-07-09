/** Mount rejection / handler crash page (§10, §14). Static. */
export default function ErrorPage({ path, message }: { path: string; message: string }) {
  return (
    <main data-testid="error-page">
      <h1>Something broke at {path}</h1>
      <pre>{message}</pre>
    </main>
  );
}
