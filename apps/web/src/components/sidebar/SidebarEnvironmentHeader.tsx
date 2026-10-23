import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, CloudIcon, ContainerIcon, MonitorIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";

const COLLAPSED_ENVIRONMENTS_KEY = "t3code:sidebar:collapsed-environments";

// Environments whose sidebar section the user collapsed, shared by both
// sidebars so the choice survives switching layouts.
export function useCollapsedEnvironments(): {
  collapsedEnvironmentIds: ReadonlySet<string>;
  toggleEnvironmentCollapsed: (environmentId: string) => void;
} {
  const [collapsedIds, setCollapsedIds] = useLocalStorage(
    COLLAPSED_ENVIRONMENTS_KEY,
    [] as readonly string[],
    Schema.Array(Schema.String),
  );
  const collapsedEnvironmentIds = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const toggleEnvironmentCollapsed = useCallback(
    (environmentId: string) =>
      setCollapsedIds((ids) =>
        ids.includes(environmentId)
          ? ids.filter((id) => id !== environmentId)
          : [...ids, environmentId],
      ),
    [setCollapsedIds],
  );
  return { collapsedEnvironmentIds, toggleEnvironmentCollapsed };
}

// Section header both sidebars render above each environment's rows once
// projects span 2+ environments. The icon tells this machine, a desktop-local
// sandbox (WSL) and a real remote apart at a glance. Clicking collapses the
// section; the count keeps a collapsed environment's size visible and a dot
// says something inside needs a human.
export function SidebarEnvironmentHeader(props: {
  label: string;
  kind: "primary" | "desktop-local" | "remote";
  collapsed: boolean;
  count: number;
  /** A hidden row needs a human; shown as a dot while collapsed. */
  attention?: boolean;
  onToggle: () => void;
}) {
  const Icon =
    props.kind === "primary"
      ? MonitorIcon
      : props.kind === "desktop-local"
        ? ContainerIcon
        : CloudIcon;
  return (
    <button
      type="button"
      data-testid="sidebar-environment-header"
      aria-expanded={!props.collapsed}
      onClick={props.onToggle}
      className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs font-medium text-sidebar-muted-foreground/80 hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        {props.collapsed ? `${props.label} (${props.count})` : props.label}
      </span>
      {props.collapsed && props.attention ? (
        <>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="sr-only">Needs attention</span>
        </>
      ) : null}
      <span aria-hidden className="h-px flex-1 bg-sidebar-border/60" />
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform", !props.collapsed && "rotate-90")}
      />
    </button>
  );
}
