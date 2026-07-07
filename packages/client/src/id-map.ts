/**
 * Optimistic id linking by position matching (§4).
 *
 * The runtime records where each tempId lands inside the optimistic patches
 * (patch path + sub-path within the patch value — any field name, nested ok),
 * finds the corresponding `add`/`replace` op in the ack patches, and reads
 * the same sub-path to learn the real id. Entirely client-side; the
 * `ctx.resolveId()` server escape hatch covers unmatched shapes.
 */
import type { Patch } from "@rpxd/core";

/** Where a tempId landed inside the optimistic patches (§4). */
export interface TempIdLocation {
  tempId: string;
  /** Path of the optimistic patch the tempId landed in. */
  path: (string | number)[];
  /** Sub-path inside the patch value where the tempId sits. */
  subPath: (string | number)[];
}

/**
 * Find every location where a registered tempId appears inside patch values.
 *
 * @example
 * ```ts
 * findTempIdLocations([{ op: "add", path: ["todos", 0], value: { id: "tmp-1" } }], new Set(["tmp-1"]));
 * // [{ tempId: "tmp-1", path: ["todos", 0], subPath: ["id"] }]
 * ```
 */
export function findTempIdLocations(patches: Patch[], tempIds: Set<string>): TempIdLocation[] {
  const locations: TempIdLocation[] = [];
  for (const patch of patches) {
    if (patch.op === "remove" || patch.value === undefined) continue;
    scan(patch.value, [], (tempId, subPath) => {
      locations.push({ tempId, path: patch.path, subPath });
    });
  }
  return locations;

  function scan(
    value: unknown,
    subPath: (string | number)[],
    hit: (tempId: string, subPath: (string | number)[]) => void,
  ): void {
    if (typeof value === "string") {
      if (tempIds.has(value)) hit(value, subPath);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        scan(v, [...subPath, i], hit);
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) scan(v, [...subPath, k], hit);
    }
  }
}

/**
 * Match optimistic tempId locations against ack patches → `tempId → realId`.
 * An ack patch corresponds when it has the same container path (array indices
 * may differ) and yields a primitive at the recorded sub-path.
 *
 * @example
 * ```ts
 * matchIdMap(optimisticPatches, ackEnvelope.patches ?? [], op.tempIds);
 * // { "tmp-1": "srv-42" }
 * ```
 */
export function matchIdMap(
  optimisticPatches: Patch[],
  ackPatches: Patch[],
  tempIds: Set<string>,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (tempIds.size === 0) return map;
  const locations = findTempIdLocations(optimisticPatches, tempIds);
  const claimed = new Set<Patch>();

  for (const loc of locations) {
    if (map[loc.tempId]) continue; // first landing wins
    const candidate = ackPatches.find(
      (p) =>
        (p.op === "add" || p.op === "replace") &&
        !claimed.has(p) &&
        samePathShape(p.path, loc.path),
    );
    if (!candidate) continue;
    claimed.add(candidate);
    const real = readPath(candidate.value, loc.subPath);
    if (typeof real === "string" || typeof real === "number") {
      map[loc.tempId] = String(real);
    }
  }
  return map;
}

/** Equal paths, except the trailing array index may differ. */
function samePathShape(a: (string | number)[], b: (string | number)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i] !== b[i]) return false;
  }
  const [lastA, lastB] = [a[a.length - 1], b[b.length - 1]];
  if (lastA === lastB) return true;
  return typeof lastA === "number" && typeof lastB === "number";
}

function readPath(value: unknown, subPath: (string | number)[]): unknown {
  let current = value;
  for (const key of subPath) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
