// Reference: https://domainr.com/
// Documentaion here: https://domainr.com/docs/api
import axios, { type AxiosInstance, AxiosError } from "axios";
import prices from "@helpers/prices";
import { parse } from "tldts";

type DomainStatus = "Available" | "Unavailable";

interface DomainStatusAPI {
  domain: string;
  zone: string;
  status: string;
  // deprecated in v2 (Do Not Use)
  summary: string;
}

export const AvailableDomainsZones = async () => {
  const _ = await prices();
  return Object.keys(_.domains);
};

// https://domainr.com/docs/api/v2/status
type DomainStatusResponseAPI =
  | "unknown"
  | "undelegated"
  | "inactive"
  | "pending"
  | "disallowed"
  | "claimed"
  | "reserved"
  | "dpml"
  | "invalid"
  | "active"
  | "parked"
  | "marketed"
  | "expiring"
  | "deleting"
  | "priced"
  | "transferable"
  | "premium"
  | "suffix"
  | "zone"
  | "tld";

export default class DomainChecker {
  private api: AxiosInstance;

  constructor() {
    this.api = axios.create({
      // DomainR API через RapidAPI
      baseURL: "https://domainr.p.rapidapi.com/v2",
      headers: {
        "X-RapidAPI-Key": process.env.DOMAINR_TOKEN,
        "X-RapidAPI-Host": "domainr.p.rapidapi.com",
      },
      httpAgent: "node-fetch",
    });
  }

  async getStatus(domain: string): Promise<DomainStatus> {
    try {
      const response = await this.api.get<{ status: DomainStatusAPI[] }>(
        "/status",
        {
          params: {
            domain,
          },
        }
      );

      const status = response.data.status[0].status.split(
        " "
      ) as DomainStatusResponseAPI[];

      if (status.includes("inactive")) {
        return "Available";
      }

      return "Unavailable";
    } catch (err) {
      if (err instanceof AxiosError) {
        console.log(err.response?.data);
      }
    }

    return "Unavailable";
  }

  domainIsValid(domain: string): boolean {
    const parsed = parse(domain);
    // If domain have more dots than one it fail cuz we register two-level domains
    if (domain.split("").filter((v) => v == ".").length > 1) return false;
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) && !!parsed.isIcann;
  }

  async domainIsAvailable(domain: string) {
    return (await AvailableDomainsZones()).some((zone) =>
      domain.endsWith(zone)
    );
  }
}
