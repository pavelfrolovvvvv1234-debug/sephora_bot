/**
 * Bundle service for purchasing infrastructure bundles.
 *
 * @module domain/bundles/BundleService
 */

import type { DataSource } from "typeorm";
import User from "../../entities/User.js";
import VirtualDedicatedServer, { generatePassword, generateRandomName } from "../../entities/VirtualDedicatedServer.js";
import Domain from "../../entities/Domain.js";
import { BundleType, BundlePeriod, BundlePurchaseContext } from "./types.js";
import { getBundleConfig, calculateBundlePrice } from "./config.js";
import { Logger } from "../../app/logger.js";
import prices from "../../helpers/prices.js";
import ms from "../../lib/multims.js";
import type { VmProvider } from "../../infrastructure/vmmanager/provider.js";
import { getVdsPurchaseDenyReason } from "../vds/vds-stock-limits.js";

/**
 * Bundle purchase result.
 */
export interface BundlePurchaseResult {
  success: boolean;
  vds?: VirtualDedicatedServer;
  domain?: Domain;
  error?: string;
}

/**
 * Bundle service for managing bundle purchases.
 */
export class BundleService {
  constructor(
    private dataSource: DataSource,
    private vmmanager: VmProvider | null
  ) {}

  /**
   * Register domain function (e.g. via Amper API). If not provided, domain is saved as draft.
   */
  private async registerDomainOption(
    registerDomainFn: (fullDomain: string, ns1: string, ns2: string) => Promise<{ success: boolean; domainId?: string; error?: string }>,
    fullDomain: string,
    ns1: string,
    ns2: string
  ): Promise<{ success: boolean; domainId?: string; error?: string }> {
    return registerDomainFn(fullDomain, ns1, ns2);
  }

  /**
   * Purchase a bundle (register domain via Amper if registrar provided, create VPS, deduct balance).
   *
   * @param userId - User ID
   * @param context - Bundle purchase context
   * @param domainName - Domain name (without TLD)
   * @param vpsOsId - VPS OS ID
   * @param registerDomainFn - Optional: register domain via provider (e.g. Amper). If omitted, domain is saved as draft.
   */
  async purchaseBundle(
    userId: number,
    context: BundlePurchaseContext,
    domainName: string,
    vpsOsId: number,
    registerDomainFn?: (fullDomain: string, ns1: string, ns2: string) => Promise<{ success: boolean; domainId?: string; error?: string }>
  ): Promise<BundlePurchaseResult> {
    const userRepo = this.dataSource.getRepository(User);
    const vdsRepo = this.dataSource.getRepository(VirtualDedicatedServer);
    const domainRepo = this.dataSource.getRepository(Domain);

    const user = await userRepo.findOneBy({ id: userId });
    if (!user) {
      return { success: false, error: "User not found" };
    }

    const config = await getBundleConfig(context.bundleType, context.period);
    if (!config) {
      return { success: false, error: "Bundle configuration not found" };
    }

    const hasPrime = Boolean(user.primeActiveUntil && new Date(user.primeActiveUntil) > new Date());
    const pricing = await calculateBundlePrice(config, hasPrime);

    if (user.balance < pricing.finalPrice) {
      return {
        success: false,
        error: `Insufficient balance. Required: ${pricing.finalPrice}, Available: ${user.balance}`,
      };
    }

    if (config.vpsRateId != null && this.vmmanager) {
      const denyBundle = await getVdsPurchaseDenyReason(this.dataSource, userId);
      if (denyBundle === "global_full") {
        return { success: false, error: "global_full" };
      }
      if (denyBundle === "user_limit") {
        return { success: false, error: "user_limit" };
      }
    }

    const pricesList = await prices();
    const defaultNs1 = process.env.DEFAULT_NS1 || "ns1.example.com";
    const defaultNs2 = process.env.DEFAULT_NS2 || "ns2.example.com";

    try {
      // 1. Domain: register via Amper if registrar provided, else create as draft
      let domain: Domain | null = null;
      if (config.domainTld) {
        const fullDomain = `${domainName}${config.domainTld}`;
        const domainPrice = pricesList.domains[config.domainTld as keyof typeof pricesList.domains]?.price ?? 0;

        if (registerDomainFn) {
          const reg = await this.registerDomainOption(registerDomainFn, fullDomain, defaultNs1, defaultNs2);
          if (!reg.success) {
            return { success: false, error: reg.error || "Domain registration failed" };
          }
          domain = new Domain();
          domain.userId = userId;
          domain.domain = fullDomain;
          domain.tld = config.domainTld.replace(".", "");
          domain.period = 1;
          domain.price = domainPrice;
          domain.status = reg.domainId ? ("registered" as any) : ("registering" as any);
          domain.provider = "amper";
          domain.providerDomainId = reg.domainId || null;
          domain.ns1 = defaultNs1;
          domain.ns2 = defaultNs2;
          domain.bundleType = context.bundleType;
          await domainRepo.save(domain);
        } else {
          domain = new Domain();
          domain.userId = userId;
          domain.domain = fullDomain;
          domain.tld = config.domainTld.replace(".", "");
          domain.period = 1;
          domain.price = domainPrice;
          domain.status = "draft" as any;
          domain.provider = "amper";
          domain.providerDomainId = null;
          domain.bundleType = context.bundleType;
          await domainRepo.save(domain);
        }
      }

      // 2. Create VPS (skip if VMManager not connected)
      let vds: VirtualDedicatedServer | null = null;
      if (config.vpsRateId != null && this.vmmanager) {
        const vpsRate = pricesList.virtual_vds[config.vpsRateId];
        if (!vpsRate) {
          return { success: false, error: "VPS rate not found" };
        }

        const generatedPassword = generatePassword(12);
        const vmName = generateRandomName(13);

        let vmResult;
        while (vmResult == undefined) {
          vmResult = await this.vmmanager.createVM(
            vmName,
            generatedPassword,
            vpsRate.cpu,
            vpsRate.ram,
            vpsOsId,
            `UserID:${userId},Bundle:${context.bundleType},${vpsRate.name}`,
            vpsRate.ssd,
            1,
            vpsRate.network,
            vpsRate.network
          );
        }

        if (vmResult == false) {
          return { success: false, error: "Failed to create VPS" };
        }

        let vmInfo;
        while (vmInfo == undefined) {
          vmInfo = await this.vmmanager.getInfoVM(vmResult.id);
        }

        let ipv4Addrs;
        while (ipv4Addrs == undefined) {
          ipv4Addrs = await this.vmmanager.getIpv4AddrVM(vmResult.id);
        }

        vds = new VirtualDedicatedServer();
        vds.vdsId = vmResult.id;
        vds.cpuCount = vpsRate.cpu;
        vds.diskSize = vpsRate.ssd;
        vds.rateName = vpsRate.name;
        vds.expireAt = new Date(Date.now() + ms(`${config.periodMonths * 30}d`));
        vds.ramSize = vpsRate.ram;
        vds.lastOsId = vpsOsId;
        vds.password = generatedPassword;
        vds.networkSpeed = vpsRate.network;
        vds.targetUserId = userId;
        vds.isBulletproof = config.vpsBulletproof;
        vds.ipv4Addr = ipv4Addrs.list[0].ip_addr;
        vds.renewalPrice = pricing.finalPrice / config.periodMonths;
        vds.bundleType = context.bundleType;
        vds.autoRenewEnabled = true;
        vds.adminBlocked = false;
        vds.managementLocked = false;
        vds.extraIpv4Count = 0;

        await vdsRepo.save(vds);
      }

      // 3. Deduct balance
      user.balance -= pricing.finalPrice;
      await userRepo.save(user);

      // 4. TODO: Apply bundle features (DNS setup, nginx config, firewall, etc.)
      // This would typically involve:
      // - DNS configuration via API
      // - SSH into VPS and configure nginx
      // - Setup firewall rules
      // - SSL certificate generation
      // - Deploy template (LAMP/Docker/FastPanel)

      Logger.info(`Bundle purchased: ${context.bundleType} for user ${userId}, price: ${pricing.finalPrice}`);

      return {
        success: true,
        vds: vds ?? undefined,
        domain: domain ?? undefined,
      };
    } catch (error) {
      Logger.error("Failed to purchase bundle:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Purchase only the domain part of a bundle (when VMManager is not available).
   * Registers domain via Amper and deducts only domain price.
   */
  async purchaseBundleDomainOnly(
    userId: number,
    context: BundlePurchaseContext,
    domainName: string,
    registerDomainFn: (fullDomain: string, ns1: string, ns2: string) => Promise<{ success: boolean; domainId?: string; error?: string }>
  ): Promise<BundlePurchaseResult> {
    const userRepo = this.dataSource.getRepository(User);
    const domainRepo = this.dataSource.getRepository(Domain);

    const user = await userRepo.findOneBy({ id: userId });
    if (!user) {
      return { success: false, error: "User not found" };
    }

    const config = await getBundleConfig(context.bundleType, context.period);
    if (!config || !config.domainTld) {
      return { success: false, error: "Bundle or domain not configured" };
    }

    const pricesList = await prices();
    const domainPrice = pricesList.domains[config.domainTld as keyof typeof pricesList.domains]?.price ?? 0;
    if (domainPrice <= 0) {
      return { success: false, error: "Domain price not found" };
    }
    if (user.balance < domainPrice) {
      return {
        success: false,
        error: `Insufficient balance. Required: ${domainPrice}, Available: ${user.balance}`,
      };
    }

    const defaultNs1 = process.env.DEFAULT_NS1 || "ns1.example.com";
    const defaultNs2 = process.env.DEFAULT_NS2 || "ns2.example.com";
    const fullDomain = `${domainName}${config.domainTld}`;

    try {
      const reg = await this.registerDomainOption(registerDomainFn, fullDomain, defaultNs1, defaultNs2);
      if (!reg.success) {
        return { success: false, error: reg.error || "Domain registration failed" };
      }

      const domain = new Domain();
      domain.userId = userId;
      domain.domain = fullDomain;
      domain.tld = config.domainTld.replace(".", "");
      domain.period = 1;
      domain.price = domainPrice;
      domain.status = reg.domainId ? ("registered" as any) : ("registering" as any);
      domain.provider = "amper";
      domain.providerDomainId = reg.domainId || null;
      domain.ns1 = defaultNs1;
      domain.ns2 = defaultNs2;
      domain.bundleType = context.bundleType;
      await domainRepo.save(domain);

      user.balance -= domainPrice;
      await userRepo.save(user);

      Logger.info(`Bundle domain-only purchased: ${fullDomain} for user ${userId}, price: ${domainPrice}`);
      return { success: true, domain };
    } catch (error) {
      Logger.error("Failed to purchase bundle (domain only):", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
