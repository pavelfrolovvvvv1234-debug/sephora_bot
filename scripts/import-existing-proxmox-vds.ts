import "dotenv/config";
import axios from "axios";
import { getAppDataSource, closeDataSource } from "../src/infrastructure/db/datasource.js";
import User, { Role, UserStatus } from "../src/entities/User.js";
import VirtualDedicatedServer, { generatePassword } from "../src/entities/VirtualDedicatedServer.js";
import { createVmProvider } from "../src/infrastructure/vmmanager/factory.js";

type ImportRow = {
  vmid: number;
  username: string;
  rateName: string;
  expireAt: string; // DD.MM.YY
  ipv4Addr?: string;
  /** Если указан — не дергаем Telegram API по username (удобно, когда есть числовой id от поддержки). */
  telegramId?: number;
};

type VdsPlan = {
  name: string;
  cpu: number;
  ram: number;
  ssd: number;
  network: number;
  price: {
    bulletproof: number;
    default: number;
  };
};

const INPUT_ROWS: ImportRow[] = [
  {
    vmid: 202,
    username: "herwincamargo",
    rateName: "Lite 1",
    expireAt: "21.05.26",
    ipv4Addr: "45.74.7.22",
    telegramId: 174931767,
  },
  {
    vmid: 204,
    username: "strategicity",
    rateName: "Lite 1",
    expireAt: "22.05.26",
    ipv4Addr: "45.74.7.26",
    telegramId: 8275274794,
  },
  {
    vmid: 205,
    username: "nemolodey",
    rateName: "Elite 1",
    expireAt: "21.05.26",
    ipv4Addr: "45.74.7.24",
    telegramId: 8312712170,
  },
  { vmid: 206, username: "lapd_k", rateName: "Elite 1", expireAt: "28.05.26", ipv4Addr: "45.74.7.27" },
  {
    vmid: 207,
    username: "YOUNEVERKNOW540",
    rateName: "Lite 1",
    expireAt: "22.05.26",
    telegramId: 1433641210,
  },
  {
    vmid: 209,
    username: "kexiques",
    rateName: "Elite 2",
    expireAt: "24.05.26",
    ipv4Addr: "45.74.7.30",
    telegramId: 5133187370,
  },
  {
    vmid: 211,
    username: "lockbitxzxnvhvbashdngnaihgnjiamk",
    rateName: "Lite 2",
    expireAt: "24.05.26",
    ipv4Addr: "45.74.7.32",
    telegramId: 7775138536,
  },
  {
    vmid: 107,
    username: "killall2s",
    rateName: "Lite 1",
    expireAt: "24.05.26",
    ipv4Addr: "45.74.7.31",
    telegramId: 945503167,
  },
  {
    vmid: 215,
    username: "amaistrov",
    rateName: "Lite 3",
    expireAt: "27.05.26",
    ipv4Addr: "45.74.7.34",
    telegramId: 1379702166,
  },
  {
    vmid: 216,
    username: "TrenbolonEnantatovich12",
    rateName: "Lite 2",
    expireAt: "28.05.26",
    ipv4Addr: "45.74.7.35",
    telegramId: 7820027592,
  },
  {
    vmid: 219,
    username: "TrenbolonEnantatovich12",
    rateName: "Lite 2",
    expireAt: "28.05.26",
    ipv4Addr: "45.74.7.38",
    telegramId: 7820027592,
  },
  {
    vmid: 221,
    username: "jugg43",
    rateName: "Lite 1",
    expireAt: "29.05.26",
    ipv4Addr: "45.74.7.39",
    telegramId: 7624082930,
  },
  { vmid: 224, username: "lapd_k", rateName: "Lite 1", expireAt: "30.05.26", ipv4Addr: "45.74.7.42" },
];

function parseDate(input: string): Date {
  const [dd, mm, yy] = input.split(".");
  const day = Number(dd);
  const month = Number(mm);
  const year = 2000 + Number(yy);
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59));
}

function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").trim();
}

/** Убирает невидимые символы и всё кроме цифр из «скопированного» id в чате. */
function parseNumericTelegramId(value: number | string | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveTelegramIdByUsername(username: string, botToken: string): Promise<number | null> {
  const normalized = normalizeUsername(username);
  const url = `https://api.telegram.org/bot${botToken}/getChat`;
  try {
    const { data } = await axios.get(url, {
      params: { chat_id: `@${normalized}` },
      timeout: 15000,
    });
    if (data?.ok && typeof data?.result?.id === "number") {
      return Number(data.result.id);
    }
  } catch {
    // Ignore and return null below.
  }
  return null;
}

function getPlanMap(): Map<string, VdsPlan> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prices = require("../src/prices.json") as { virtual_vds: VdsPlan[] };
  return new Map(prices.virtual_vds.map((p) => [p.name.toLowerCase(), p]));
}

async function main(): Promise<void> {
  const isApply = process.argv.includes("--apply");
  const isDryRun = !isApply;
  const botToken = (process.env.BOT_TOKEN ?? "").trim();
  const needsBotTokenForResolve = INPUT_ROWS.some((r) => parseNumericTelegramId(r.telegramId) == null);

  if (needsBotTokenForResolve && !botToken) {
    throw new Error(
      "BOT_TOKEN is required in .env to resolve usernames for rows without telegramId."
    );
  }

  const ds = await getAppDataSource();
  const userRepo = ds.getRepository(User);
  const vdsRepo = ds.getRepository(VirtualDedicatedServer);
  const vmProvider = createVmProvider();
  const planMap = getPlanMap();

  const report: Array<Record<string, string | number | boolean | null>> = [];
  const missingUsers: string[] = [];
  const missingPlans: string[] = [];

  for (const row of INPUT_ROWS) {
    const plan = planMap.get(row.rateName.toLowerCase());
    if (!plan) {
      missingPlans.push(row.rateName);
      report.push({ vmid: row.vmid, username: row.username, status: "missing_plan" });
      continue;
    }

    let telegramId = parseNumericTelegramId(row.telegramId);
    if (!telegramId) {
      telegramId = await resolveTelegramIdByUsername(row.username, botToken);
    }
    if (!telegramId) {
      missingUsers.push(row.username);
      report.push({ vmid: row.vmid, username: row.username, status: "username_not_resolved" });
      continue;
    }

    let user = await userRepo.findOneBy({ telegramId });
    if (!user && isApply) {
      user = userRepo.create({
        telegramId,
        role: Role.User,
        status: UserStatus.User,
        lang: "ru",
        isBanned: false,
        balance: 0,
        referralBalance: 0,
      });
      await userRepo.save(user);
    }

    if (!user) {
      report.push({ vmid: row.vmid, username: row.username, telegramId, status: "user_not_found_in_db" });
      continue;
    }

    const generatedPassword = generatePassword(12);
    let resolvedIp = row.ipv4Addr ?? null;
    if (!resolvedIp) {
      try {
        const ipData = await vmProvider.getIpv4AddrVM(row.vmid);
        const candidate = ipData?.list?.[0]?.ip_addr;
        if (candidate && candidate !== "0.0.0.0") {
          resolvedIp = candidate;
        }
      } catch {
        // Keep null fallback.
      }
    }
    const existing = await vdsRepo.findOneBy({ vdsId: row.vmid });
    const entity = existing ?? vdsRepo.create();

    entity.vdsId = row.vmid;
    entity.login = "root";
    entity.password = generatedPassword;
    entity.ipv4Addr = resolvedIp ?? "0.0.0.0";
    entity.cpuCount = plan.cpu;
    entity.networkSpeed = plan.network;
    entity.isBulletproof = true;
    entity.payDayAt = null;
    entity.ramSize = plan.ram;
    entity.diskSize = plan.ssd;
    entity.lastOsId = 900; // ubuntu2404
    entity.rateName = row.rateName;
    entity.expireAt = parseDate(row.expireAt);
    entity.targetUserId = user.id;
    entity.renewalPrice = plan.price.bulletproof;
    entity.displayName = `@${normalizeUsername(row.username)}`;
    entity.bundleType = null;
    entity.autoRenewEnabled = true;
    entity.adminBlocked = false;
    entity.managementLocked = false;
    entity.extraIpv4Count = 0;

    let proxmoxPasswordApplied = false;
    if (isApply) {
      try {
        const changed = await vmProvider.changePasswordVMCustom(row.vmid, generatedPassword);
        proxmoxPasswordApplied = Boolean(changed);
      } catch {
        proxmoxPasswordApplied = false;
      }
      await vdsRepo.save(entity);
    }

    report.push({
      vmid: row.vmid,
      username: normalizeUsername(row.username),
      telegramId,
      dbUserId: user.id,
      rate: row.rateName,
      expireAt: row.expireAt,
      ip: resolvedIp ?? null,
      createdOrUpdated: existing ? "updated" : "created",
      proxmoxPasswordApplied,
      password: generatedPassword,
      status: isApply ? "applied" : "dry_run_ok",
    });
  }

  console.log(`Mode: ${isApply ? "APPLY" : "DRY-RUN"}`);
  console.table(report);
  if (missingUsers.length > 0) {
    console.log(`Usernames not resolved (${missingUsers.length}): ${missingUsers.join(", ")}`);
  }
  if (missingPlans.length > 0) {
    console.log(`Missing plans (${missingPlans.length}): ${missingPlans.join(", ")}`);
  }

  if (typeof vmProvider.destroy === "function") {
    vmProvider.destroy();
  }
  await closeDataSource();
  if (isDryRun) {
    console.log("Dry-run complete. Run with --apply to write changes.");
  }
}

main().catch(async (error) => {
  console.error("Failed to import existing Proxmox VDS:", error);
  await closeDataSource().catch(() => {});
  process.exit(1);
});
