import type {
  CreateVMSuccesffulyResponse,
  GetOsListResponse,
  GetVMResponse,
  ListItem,
} from "../../api/vmmanager.js";

export interface VmProvider {
  getOsList(): Promise<GetOsListResponse | undefined>;
  createVM(
    name: string,
    password: string,
    cpuNumber: number,
    ramSize: number,
    osId: number,
    comment: string,
    diskSize: number,
    ipv4Count: number,
    networkIn: number,
    networkOut: number
  ): Promise<CreateVMSuccesffulyResponse | false>;
  getInfoVM(id: number): Promise<ListItem | undefined>;
  getIpv4AddrVM(id: number): Promise<{ list: Array<{ ip_addr: string }> } | undefined>;
  addIpv4ToHost(id: number): Promise<boolean>;
  startVM(id: number): Promise<unknown>;
  stopVM(id: number): Promise<unknown>;
  deleteVM(id: number): Promise<unknown>;
  /** Proxmox: optional line set on guest description so staff can find VM (search «SephoraHost» / vmid). */
  reinstallOS(id: number, osId: number, password?: string, managementDescription?: string): Promise<unknown>;
  changePasswordVM(id: number): Promise<string>;
  changePasswordVMCustom(id: number, password: string): Promise<boolean>;
  /** Proxmox: last failure detail after createVM returned false (optional). */
  getLastCreateVmFailureDetail?(): string;
  destroy?(): void;
}

export type { GetOsListResponse, GetVMResponse, ListItem };
