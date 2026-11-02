/** Tabs whose server modules do not exist yet render an honest placeholder instead of client-side fake data. */
export function PlaceholderScreen({ title, children }: { title: string; children: string }) {
  return (
    <section className="screen" aria-labelledby="placeholder-title">
      <h1 id="placeholder-title" className="screen__title">{title}</h1>
      <p className="muted">{children}</p>
    </section>
  );
}
