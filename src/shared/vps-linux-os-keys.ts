/**
 * Linux-only OS slugs for Sephora VPS/VDS auto-provision and reinstall.
 * Proxmox: keys must exist in PROXMOX_TEMPLATE_MAP (template VMIDs dedicated to Sephora).
 */

export const VPS_LINUX_OS_KEYS = [
  "alma8",
  "alma9",
  "rockylinux",
  "centos9",
  "debian11",
  "debian12",
  "debian13",
  "ubuntu2204",
  "ubuntu2404",
] as const;

const KEY_SET = new Set<string>(VPS_LINUX_OS_KEYS as unknown as string[]);

export function isVpsLinuxOsKey(key: string): boolean {
  return KEY_SET.has(key.trim().toLowerCase());
}
