// Common icons come from react-icons (Lucide set) — tree-shaken at build
// time, so no runtime network and the bundle stays self-contained. Only the
// Fino brand mark is hand-drawn. Everything draws in currentColor at 1em, so
// icons inherit the color and font-size of wherever they're placed.
import {
  LuCheck,
  LuChevronRight,
  LuDatabase,
  LuDot,
  LuLoaderCircle,
  LuSearch,
  LuTable,
  LuChartColumn,
  LuX,
} from "react-icons/lu";

type IconProps = { className?: string };

/** Indeterminate spinner (CSS-animated via .spin). */
export function Spinner({ className }: IconProps) {
  return <LuLoaderCircle className={`spin ${className ?? ""}`} aria-hidden />;
}

export function Check({ className }: IconProps) {
  return <LuCheck className={className} aria-hidden />;
}

export function Cross({ className }: IconProps) {
  return <LuX className={className} aria-hidden />;
}

export function Chevron({ open, className }: IconProps & { open?: boolean }) {
  return (
    <LuChevronRight
      className={className}
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
      aria-hidden
    />
  );
}

/** Map an MCP/local tool name to its glyph, so the trace scans by shape. */
export function ToolIcon({ tool, className }: IconProps & { tool: string }) {
  const t = tool.toLowerCase();
  if (t.includes("create_chart")) return <LuChartColumn className={className} aria-hidden />;
  if (t.includes("list_tables") || t.includes("describe_table"))
    return <LuTable className={className} aria-hidden />;
  if (t.includes("sql")) return <LuDatabase className={className} aria-hidden />;
  if (t.includes("search") || t.includes("match"))
    return <LuSearch className={className} aria-hidden />;
  return <LuDot className={className} aria-hidden />;
}
