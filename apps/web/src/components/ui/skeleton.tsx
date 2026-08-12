import { cn } from "@/lib/utils";

// Loading placeholder: a muted block that pulses where content will land.
// Sharp corners like every other surface; size it with width/height classes.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-sm bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
