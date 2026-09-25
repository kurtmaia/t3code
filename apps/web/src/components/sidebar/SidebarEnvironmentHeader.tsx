import { CloudIcon, ContainerIcon, MonitorIcon } from "lucide-react";

// Section header both sidebars render above each environment's rows once
// projects span 2+ environments. The icon tells this machine, a desktop-local
// sandbox (WSL) and a real remote apart at a glance.
export function SidebarEnvironmentHeader(props: {
  label: string;
  kind: "primary" | "desktop-local" | "remote";
}) {
  const Icon =
    props.kind === "primary"
      ? MonitorIcon
      : props.kind === "desktop-local"
        ? ContainerIcon
        : CloudIcon;
  return (
    <div
      data-testid="sidebar-environment-header"
      className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-xs font-medium text-sidebar-muted-foreground/80"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{props.label}</span>
      <span aria-hidden className="h-px flex-1 bg-sidebar-border/60" />
    </div>
  );
}
