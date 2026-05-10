import { getAppDataSource } from "@/database";
import VirtualDedicatedServer, {
  generatePassword,
} from "@/entities/VirtualDedicatedServer";
import ms from "@/lib/multims";
import axios from "axios";

export type CreatePublicTokenResponse = {
  id: number;
  token: string;
  expires_at: string;
  confirmed: boolean;
};

export type CreateVMSuccesffulyResponse = {
  id: number;
  task: number;
  recipe_task_list: number[];
  recipe_task: number;
  spice_task: number;
};

/** Alias for CreateVMSuccesffulyResponse (API typo). */
export type CreateVMSuccessfullyResponse = CreateVMSuccesffulyResponse;

export type GetOsListResponse = {
  last_notify: number;
  list: Os[];
};

export interface Os {
  adminonly: boolean;
  clusters: {
    id: number;
    name: string;
  };
  comment: null | string;
  cpu_mode: null | string;
  efi_boot: boolean;
  hdd_mib_required: number;
  id: number;
  is_lxd_image: boolean;
  kms_ip: null;
  kms_port: null | string;
  kms_supported: boolean;
  min_ram_mib: number;
  name: string;
  nodes: {
    id: number;
    ip_addr: string;
    name: string;
    ssh_port: number;
  };
  os_group: string;
  product_key: null;
  repository: "ISPsystem" | "IPSsystem EOL" | "ISPsystem LXD" | "local";
  repository_id: number;
  state: string;
  tags: string[];
  updated_at: string;
}

export interface IpInfo {
  ip: string;
  interface: string;
}

export interface InterfaceInfo {
  host_interface: string;
  mac: string;
  node_interface: number;
  dhcp: boolean;
}

export interface NodeInfo {
  id: number;
  name: string;
  ip_addr: string;
  live_migration_allowed: boolean;
  maintenance_mode: boolean;
  hot_plug_memory: boolean;
}

export interface ClusterInfo {
  id: number;
}

export interface AccountInfo {
  id: number;
  email: string;
}

export interface DiskInfo {
  id: number;
  disk_mib: number;
  disk_mib_new: number;
}

export interface AntiSpoofingSettings {
  vlan: boolean;
}

export interface FirewallRule {
  action: string;
  direction: string;
  protocols: string[];
  portstart: number;
  portend: number;
}

export interface Vm5Restrictions {
  net_iface_count: boolean;
  nat_or_extra: boolean;
  ipv6: boolean;
  unsupported_storage: boolean;
  iso: boolean;
  snapshot: boolean;
}

export interface VxlanInfo {
  id: number;
  name: string;
  tag: number;
}

export interface LinkedCloneImage {
  id: number;
  name: string;
}

export interface ListItem {
  expand_part: string;
  id: number;
  name: string;
  ip4: IpInfo[];
  ip6: IpInfo[];
  interfaces: InterfaceInfo[];
  node: NodeInfo;
  cluster: ClusterInfo;
  state: "creating" | "stopped" | "active";
  domain: string;
  account: AccountInfo;
  comment: string;
  disk: DiskInfo;
  disk_count: number;
  cpu_number: number;
  cpu_number_new: number;
  efi_boot: boolean;
  ram_mib: number;
  ram_mib_new: number;
  hot_plug: boolean;
  live_resize: boolean;
  hot_plug_cell_counter: number;
  net_bandwidth_mbitps: number;
  net_bandwidth_mbitps_changed: boolean;
  ip_automation: string;
  ip_summary: string;
  net_is_synced: boolean;
  tags: string[];
  os_name: string;
  os_group: string;
  uptime: number;
  rescue_mode: boolean;
  iso_mounted: boolean;
  iso_reboot: boolean;
  iso_status: string;
  cpu_mode: string;
  nesting: boolean;
  cpu_custom_model: string;
  cpu_weight: number;
  io_weight: number;
  io_read_mbitps: number;
  io_write_mbitps: number;
  io_read_iops: number;
  io_write_iops: number;
  net_in_mbitps: number;
  net_out_mbitps: number;
  net_weight: number;
  anti_spoofing: boolean;
  anti_spoofing_settings: AntiSpoofingSettings;
  disabled: boolean;
  tcp_connections_in: number;
  tcp_connections_out: number;
  process_number: number;
  vxlan: VxlanInfo;
  firewall_rules: FirewallRule[];
  has_noname_iface: boolean;
  is_protected: boolean;
  extended_protection: boolean;
  vm5_restrictions: Vm5Restrictions;
  spice_enabled: boolean;
  spice_additional_enabled: boolean;
  snapshot_count: number;
  snapshot_limit: number;
  snapshot_ram: boolean;
  snapshot_curr: number;
  snapshots_allowed: boolean;
  balancer_mode: string;
  linked_clone_image: LinkedCloneImage;
  mon_install_date: string;
  create_date: string;
}

export interface GetVMResponse {
  last_notify: number;
  list: ListItem[];
}

interface HostInfo {
  id: number;
  name: string;
  interface: number;
  interface_name: string;
}

interface Ipv4Addr {
  id: number;
  ip_addr: string;
  domain: string;
  gateway: string;
  mask: string;
  state: string;
  family: number;
  ippool: number;
  network: number;
  host: HostInfo;
  cluster_interface: number;
  vxlan: VxlanInfo;
}

interface HostIpv4Response {
  last_notify: number;
  list: Ipv4Addr[];
  size: number;
}

export class VMManager {
  // x-xsrf-token
  private token?: string;

  constructor(private email: string, private password: string) {
    this.login();
    console.info("[Sephora Host Bot]: Created VMManager API instance");

    setInterval(() => {
      this.login();
    }, ms("5m"));
  }

  async login(): Promise<void> {
    try {
      console.info("[Sephora Host Bot]: Trying authorization");
      const { status, data } = await axios.post<CreatePublicTokenResponse>(
        `${process.env.VMM_ENDPOINT_URL}auth/v4/public/token`,
        {
          email: this.email,
          password: this.password,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );

      if (status === 201) {
        this.token = data.token;
      }
    } catch (error) {
      if (axios.isAxiosError<{ error: { code: number; msg: string } }>(error)) {
        console.error("Error Authenticate in VMManager:", error.response?.data);
      }
    }
  }

  async getOsList() {
    try {
      const { status, data } = await axios.get<GetOsListResponse>(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/os`,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error Get OS List in VMManager:", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async startVM(id: number) {
    try {
      const { status, data } = await axios.post(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}/start`,
        undefined,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error vm: ", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async deleteVM(id: number) {
    try {
      const { status, data } = await axios.delete<{
        id: number;
        task: number;
      }>(`${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}`, {
        params: {
          force: false,
        },
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-xsrf-token": this.token,
        },
      });

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error Create VM in VMManager:", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async reinstallOS(id: number, osId: number) {
    try {
      const vdsRepo = (await getAppDataSource()).getRepository(
        VirtualDedicatedServer
      );

      const vds = await vdsRepo.findOneBy({
        vdsId: id,
      });

      const password = vds?.password;

      const { status, data } = await axios.post<{
        id: number;
        task: number;
        recipe_task_list: number[];
        recipe_task: number;
        spice_task: number;
      }>(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}/reinstall`,
        {
          os: osId,
          password,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error vm: ", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async stopVM(id: number) {
    try {
      const { status, data } = await axios.post(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}/stop`,
        {
          force: false,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error vm: ", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async getInfoVM(id: number) {
    try {
      const { status, data } = await axios.get<GetVMResponse["list"][0]>(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}`,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error get Info about vm: ", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  // Return new password
  async changePasswordVM(id: number) {
    const newPassword = generatePassword(12);

    try {
      const { status } = await axios.post(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}/password`,
        {
          password: newPassword,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return newPassword;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error change password vm: ", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async getIpv4AddrVM(id: number) {
    try {
      const { status, data } = await axios.get<HostIpv4Response>(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host/${id}/ipv4`,
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error get Info about ipv4 vm: ", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        }
      }
    }
  }

  async createVM(
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
  ) {
    try {
      const { status, data } = await axios.post<CreateVMSuccesffulyResponse>(
        `${process.env.VMM_ENDPOINT_URL}vm/v3/host`,
        {
          name: name,
          password: password,
          cpu_number: cpuNumber,
          // In Gigabytes
          ram_mib: ramSize * 1024,
          net_in_mbitps: networkIn,
          net_out_mbitps: networkOut,
          os: osId,
          comment: comment,
          // In Gigabytes
          hdd_mib: diskSize * 1024,
          ipv4_number: ipv4Count,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-xsrf-token": this.token,
          },
        }
      );

      if (status === 200) {
        return data;
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error("Error Create VM in VMManager:", error.response?.data);

        if (error.response?.data.error.code == 1000) {
          await this.login();
        } else {
          return false as const;
        }
      }
    }
  }
}
