import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

type StatRoute = "/sales" | "/settlement" | "/retailers" | "/products" | "/stock-issue" | "/salesmen";
export function Stat({ label, value, tone, to }: { label: string; value: string; tone?: "good" | "bad" | "accent"; to?: StatRoute }) {
  const content = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 break-words font-display text-lg font-bold sm:text-2xl", tone === "good" && "text-success", tone === "bad" && "text-destructive")}>{value}</div>
      {to && <div className="mt-2 text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">Open details ↗</div>}
    </>
  );
  const classes = cn("min-w-0 rounded-lg border bg-card p-3 text-left sm:p-4", tone === "accent" && "border-accent bg-accent/15", to && "group block w-full cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring");
  return to ? <Link to={to} aria-label={`${label}: ${value}`} className={classes}>{content}</Link> : <div className={classes}>{content}</div>;
}

export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-4 min-w-0 break-words font-display text-xl font-bold sm:text-2xl">{children}</h1>;
}
