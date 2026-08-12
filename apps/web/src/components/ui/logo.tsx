// Infino brand mark — the interlocking-infinity glyph, served from /public.
// Same asset the docs site and infino.ai use. Pass height via className
// (width auto-scales to the ~2.8:1 mark).
export function Logo({ className }: { className?: string }) {
  return <img src="/infino-mark.png" alt="infino" className={className} />;
}
