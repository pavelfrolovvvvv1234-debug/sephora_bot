/** One-line marker for Proxmox guest description — search «SephoraHost» or vmid# in UI. */

export type VdsForProxmoxMarker = {
  id: number;
  targetUserId: number;
  vdsId: number;
  displayName?: string | null;
};

export function buildVdsProxmoxDescriptionLine(v: VdsForProxmoxMarker): string {
  const label = v.displayName?.trim();
  const namePart = label ? ` label=${label}` : "";
  return `SephoraHost | VDS#${v.id} user#${v.targetUserId} vmid#${v.vdsId}${namePart}`;
}
