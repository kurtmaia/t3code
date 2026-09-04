import { expect, it } from "@effect/vitest";

import {
  importedExternalIds,
  mapTowerPriority,
  mapTowerStatus,
  parseTowerTaskFile,
  towerDraftDiffers,
  towerOrderKey,
} from "./TowerTaskImport.ts";

// Mirrors the shape of a real tower task file: a quoted title with an em
// dash, the fields t3 drops, and a `tools` entry that is prose rather than a
// list. Contents are invented — a fixture is not the place for real work.
const REAL_FILE = `---
id: sample-project/001
title: 'Add a coverage badge: README — CI pipeline'
status: done
priority: P2
order: 0
assignee: null
machine: 00000000-0000-4000-8000-000000000000
labels: []
scope:
- docs/readme/
depends_on: []
verify: []
isolation: null
base_ref: null
created_at: '2026-01-15T15:17:14+00:00'
updated_at: '2026-01-15T15:39:58+00:00'
model: null
tools:
- 'Bash — required and the work fails without it.'
---
## Goal
A single self-contained deck.

## Context
Follow-on from the review.
`;

it("maps a real tower task file onto a t3 task", () => {
  const draft = parseTowerTaskFile({
    externalId: "001-add-coverage-badge",
    contents: REAL_FILE,
  });
  expect(draft).not.toBeNull();
  expect(draft?.title).toBe("Add a coverage badge: README — CI pipeline");
  expect(draft?.status).toBe("done");
  expect(draft?.priority).toBe("P2");
  expect(draft?.orderKey).toBe("000000");
  expect(draft?.labels).toEqual([]);
  expect(draft?.body.startsWith("## Goal")).toBe(true);
  expect(draft?.body).toContain("Follow-on from the review.");
  // The identity is the filename, not the frontmatter id, matching tower's
  // own rule that a mistyped id must not let two files claim one task.
  expect(draft?.externalId).toBe("001-add-coverage-badge");
});

it("keeps a task whose frontmatter is malformed rather than dropping it", () => {
  const draft = parseTowerTaskFile({
    externalId: "007-broken",
    contents: "---\n: : not yaml : :\n---\n## Goal\nStill readable.\n",
  });
  expect(draft?.status).toBe("pending");
  expect(draft?.priority).toBe("P2");
  expect(draft?.body).toContain("Still readable.");
  // With no usable title, the filename carries the meaning.
  expect(draft?.title).toBe("broken");
});

it("handles a file with no frontmatter at all", () => {
  const draft = parseTowerTaskFile({
    externalId: "012-add-coverage-badge",
    contents: "## Goal\nAdd a badge.\n",
  });
  expect(draft?.title).toBe("add coverage badge");
  expect(draft?.body).toBe("## Goal\nAdd a badge.");
  expect(draft?.orderKey).toBeNull();
});

it("lands tower's capacity status in blocked", () => {
  // needs-app-slot is tower's own concurrency limiter; t3 has no such concept,
  // and to a reader it means waiting on something outside the task.
  expect(mapTowerStatus("needs-app-slot")).toBe("blocked");
  expect(mapTowerStatus("review")).toBe("review");
  expect(mapTowerStatus("REVIEW")).toBe("review");
  expect(mapTowerStatus("nonsense")).toBe("pending");
  expect(mapTowerStatus(undefined)).toBe("pending");
});

it("falls back to the default priority for anything unrecognised", () => {
  expect(mapTowerPriority("p0")).toBe("P0");
  expect(mapTowerPriority("P3")).toBe("P3");
  expect(mapTowerPriority("urgent")).toBe("P2");
  expect(mapTowerPriority(undefined)).toBe("P2");
});

it("pads order keys so 2 sorts ahead of 10", () => {
  const keys = [towerOrderKey(10), towerOrderKey(2)].filter((key): key is string => key !== null);
  expect(keys.toSorted()).toEqual([towerOrderKey(2), towerOrderKey(10)]);
  expect(towerOrderKey(undefined)).toBeNull();
  expect(towerOrderKey("3")).toBe("000003");
  expect(towerOrderKey(-5)).toBe("000000");
});

it("reports which external ids a project already imported", () => {
  const base = {
    title: "t",
    status: "pending",
    priority: "P2",
    body: "",
    labels: [],
    orderKey: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  } as const;
  const seen = importedExternalIds(
    [
      { ...base, id: "a", projectId: "p1", source: "tower", externalId: "001-x" },
      // Deleted tasks still count: re-importing one a human removed would be
      // the import undoing their decision.
      { ...base, id: "b", projectId: "p1", source: "tower", externalId: "002-y" },
      { ...base, id: "c", projectId: "p2", source: "tower", externalId: "003-z" },
      { ...base, id: "d", projectId: "p1", source: null, externalId: null },
    ] as never,
    "p1",
  );
  expect(seen.has("001-x")).toBe(true);
  expect(seen.has("002-y")).toBe(true);
  expect(seen.has("003-z")).toBe(false);
  expect(seen.size).toBe(2);
});

it("returns only changed mirrored fields and ignores label order", () => {
  const draft = parseTowerTaskFile({
    externalId: "001-task",
    contents:
      "---\ntitle: Updated\nstatus: review\npriority: P1\norder: 2\nlabels: [b, a]\n---\nNew body",
  });
  expect(draft).not.toBeNull();
  const task = {
    title: "Old",
    status: "pending",
    priority: "P2",
    body: "Old body",
    labels: ["a", "b"],
    orderKey: "000001",
  } as never;
  expect(towerDraftDiffers(draft!, task)).toEqual({
    title: "Updated",
    status: "review",
    priority: "P1",
    body: "New body",
    orderKey: "000002",
  });
});

it("returns null for an unchanged draft", () => {
  const draft = parseTowerTaskFile({
    externalId: "001-task",
    contents: "---\ntitle: Same\nstatus: pending\npriority: P2\nlabels: [a, b]\n---\nBody",
  });
  expect(
    towerDraftDiffers(draft!, {
      title: "Same",
      status: "pending",
      priority: "P2",
      body: "Body",
      labels: ["b", "a"],
      orderKey: null,
    } as never),
  ).toBeNull();
});
