import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { CircleAlertIcon, GitBranchIcon, ServerIcon, TerminalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { formatWorkingDurationLabel } from "../Sidebar.logic";
import type { TerminalStatusIndicator } from "../ThreadStatusIndicators";
import { TooltipPopup } from "../ui/tooltip";

// Thread-row pieces shared by the default and legacy sidebars.

// Provider instances of the primary server, keyed by instance id, for the
// per-row provider glyph and the hover card's model line.
export function useProviderEntryByInstanceId(): ReadonlyMap<string, ProviderInstanceEntry> {
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  return useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(serverProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [serverProviders],
  );
}

// Self-ticking so only this span re-renders each second, not the whole row.
export function WorkingDuration(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return;
    const id = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(id);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return (
    <span className="font-mono tabular-nums">
      {formatWorkingDurationLabel(Date.now() - startedMs)}
    </span>
  );
}

export function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

export function SidebarThreadTooltip({
  thread,
  projectTitle,
  projectCwd,
  projectFaviconPath,
  environmentLabel,
  providerEntry,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  projectCwd: string | null;
  projectFaviconPath: string | null;
  environmentLabel: string | null;
  providerEntry: ProviderInstanceEntry | null;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  return (
    <TooltipPopup
      side="right"
      align="start"
      sideOffset={4}
      variant="glass"
      className="max-w-80 text-left whitespace-normal [&_[data-slot=tooltip-viewport]]:p-0"
    >
      <div className="flex min-w-0 max-w-80 flex-col gap-2 p-[var(--floating-content-inset)]">
        <div className="min-w-0 truncate text-xs leading-none font-medium text-foreground">
          {thread.title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          {projectTitle ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProjectFavicon
                environmentId={thread.environmentId}
                cwd={projectCwd ?? ""}
                faviconPath={projectFaviconPath}
                className="size-3 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 truncate text-foreground/75">{projectTitle}</div>
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{thread.branch}</div>
            </div>
          ) : null}
          {branchMismatch ? (
            <div className="flex min-w-0 items-start gap-2 text-warning">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word leading-5">
                You're currently checked out on another branch.
              </div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                driverKind={driverKind}
                displayName={
                  providerEntry?.displayName ?? thread.session?.providerName ?? modelInstanceId
                }
                accentColor={providerEntry?.accentColor}
                // Initials would swallow a size-3 glyph: accent dot, name in label.
                showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
                badgeContent="none"
                badgeClassName="h-2 min-w-2 px-0"
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">
                {showInstanceBadge && providerEntry
                  ? `${modelLabel} · ${providerEntry.displayName}`
                  : modelLabel}
              </div>
            </div>
          ) : null}
          {terminalStatus ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon
                aria-hidden
                className={cn("size-3 shrink-0", terminalStatus.colorClass)}
              />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
            </div>
          ) : null}
          {thread.session?.lastError ? (
            <div className="flex min-w-0 items-center gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
              <div className="min-w-0 truncate">Error occurred</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}
