/**
 * Readable labels for VMmanager / API OS template slugs (e.g. ubuntu2204).
 */

export function humanizeVmmOsName(raw: string): string {
  const s = raw.trim();
  if (!s) {
    return raw;
  }
  const lower = s.toLowerCase();

  const ubuntu = lower.match(/^ubuntu(\d{2})(\d{2})$/);
  if (ubuntu) {
    const ver = `${ubuntu[1]}.${ubuntu[2]}`;
    const lts = new Set(["20.04", "22.04", "24.04"]);
    return `Ubuntu ${ver}${lts.has(ver) ? " LTS" : ""}`;
  }

  const debian = lower.match(/^debian(\d+)$/);
  if (debian) {
    return `Debian ${debian[1]}`;
  }

  const rocky = lower.match(/^rockylinux(\d+)$/);
  if (rocky) {
    return `Rocky Linux ${rocky[1]}`;
  }

  const alma = lower.match(/^almalinux(\d+)$/);
  if (alma) {
    return `AlmaLinux ${alma[1]}`;
  }

  const oracle = lower.match(/^oraclelinux(\d+)$/);
  if (oracle) {
    return `Oracle Linux ${oracle[1]}`;
  }

  const centos = lower.match(/^centos(\d+)$/);
  if (centos) {
    return `CentOS ${centos[1]}`;
  }

  const alpine = lower.match(/^alpine(\d)(\d{2})$/);
  if (alpine) {
    return `Alpine Linux ${alpine[1]}.${alpine[2]}`;
  }

  const fedora = lower.match(/^fedora(\d+)$/);
  if (fedora) {
    return `Fedora ${fedora[1]}`;
  }

  const cloudos = lower.match(/^opencloudos(\d+)$/);
  if (cloudos) {
    return `OpenCloudOS ${cloudos[1]}`;
  }

  const opensuseLeap = lower.match(/^opensuse[_-]?leap[_-]?(\d+(?:\.\d+)?)$/);
  if (opensuseLeap) {
    return `openSUSE Leap ${opensuseLeap[1]}`;
  }

  const tumble = lower.match(/^opensuse[_-]?tumbleweed$/);
  if (tumble) {
    return "openSUSE Tumbleweed";
  }

  const generic = lower.match(/^([a-z]+)(\d+(?:\.\d+)?)$/);
  if (generic) {
    const word = generic[1];
    const prettyWord = word.charAt(0).toUpperCase() + word.slice(1);
    return `${prettyWord} ${generic[2]}`;
  }

  return s
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .trim();
}
