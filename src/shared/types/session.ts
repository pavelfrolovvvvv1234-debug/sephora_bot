/**
 * Session data types for Grammy sessions.
 *
 * @module shared/types/session
 */

import { Role, UserStatus } from "../../entities/User.js";

/**
 * Main session data (persisted).
 */
export interface MainSessionData {
  locale: string;
  user: {
    id: number;
    balance: number;
    referralBalance: number;
    role: Role;
    status: UserStatus;
    isBanned: boolean;
  };
  lastSumDepositsEntered: number;
  topupMethod: "crystalpay" | "cryptobot" | "heleket" | "manual" | null;
}

/**
 * Other session data (in-memory).
 */
export interface OtherSessionData {
  broadcast: {
    step: "idle" | "awaiting_text" | "awaiting_confirm";
    text?: string;
  };
  controlUsersPage: {
    orderBy: "balance" | "id";
    sortBy: "ASC" | "DESC";
    page: number;
    pickedUserData?: {
      id: number;
    };
    /** Staff: next private text message is interpreted as user lookup (DB id, Telegram id, or @username). */
    awaitingUserLookup?: boolean;
  };
  vdsRate: {
    bulletproof: boolean;
    selectedRateId: number;
    selectedOs: number;
    /** VPS shop: tier (null on type step). */
    shopTier?: "start" | "standard" | "performance" | "enterprise" | null;
    /** VPS shop: plan list pagination. */
    shopListPage?: number;
  };
  dedicatedType: {
    bulletproof: boolean;
    selectedDedicatedId: number;
    /** Purchase shop: performance tier (null on type step). */
    shopTier?: "start" | "standard" | "performance" | "enterprise" | null;
    /** Purchase shop: server list pagination. */
    shopListPage?: number;
  };
  manageVds: {
    page: number;
    lastPickedId: number;
    expandedId: number | null;
    showPassword: boolean;
    pendingRenameVdsId?: number | null;
    pendingManualPasswordVdsId?: number | null;
    /** Pending renewal period until user confirms (callback). */
    pendingRenewMonths?: 1 | null;
  };
  /** Admin: VDS list / search / actions */
  adminVds: {
    page: number;
    searchQuery: string;
    selectedVdsId: number | null;
    awaitingSearch: boolean;
    awaitingTransferUserId: boolean;
  };
  manageDedicated: {
    expandedId: number | null;
    showPassword: boolean;
  };
  domains: {
    lastPickDomain: string;
    page: number;
    pendingZone?: string;
    /** Domain purchase shop: category list or "all" for paginated catalog. */
    shopCategory?: "popular" | "business" | "tech" | "geo" | "all";
    /** Zero-based page for "All TLDs" category only. */
    shopAllPage?: number;
    /** Selected zone on confirm screen; used when returning from "My domains". */
    shopConfirmZone?: string;
  };
  dedicatedOrder: {
    step: "idle" | "requirements" | "comment";
    requirements?: string;
    /** Selected location key for support message (e.g. "de-frankfurt"). */
    selectedLocationKey?: string;
    /** Selected OS key for support message (e.g. "ubuntu-2204"). */
    selectedOsKey?: string;
  };
  promoAdmin: {
    page: number;
    editingPromoId?: number | null;
    createStep?: "code" | "amount" | "max" | null;
    createDraft?: {
      code?: string;
      amount?: number;
    };
    editStep?: "code" | null;
  };
  promocode: {
    awaitingInput: boolean;
  };
  ticketsView: {
    list: "new" | "in_progress" | null;
    currentTicketId?: number | null;
    pendingAction?:
      | "ask_user"
      | "provide_result"
      | "reject"
      | "provide_dedicated_ip"
      | "provide_dedicated_login"
      | "provide_dedicated_password"
      | "provide_dedicated_panel"
      | "provide_dedicated_notes"
      | "provisioning_note"
      | "provisioning_complete_message"
      | null;
    pendingTicketId?: number | null;
    pendingData?: {
      ip?: string;
      login?: string;
      password?: string;
      panel?: string | null;
      notes?: string | null;
    };
  };
  deposit: {
    awaitingAmount: boolean;
    prefilledAmount: boolean;
    selectedAmount: number;
  };
  /** Admin balance edit: awaiting amount for add/deduct */
  balanceEdit?: {
    userId: number;
    action: "add" | "deduct";
  };
  /** Admin message to user: awaiting text to send */
  messageToUser?: {
    userId: number;
    telegramId: number;
  };
  /** Admin subscription grant: awaiting number of days */
  subscriptionEdit?: {
    userId: number;
  };
  /** Admin referral percent edit: awaiting percentage 0-100. key = which service column to set. */
  referralPercentEdit?: {
    userId: number;
    key?:
      | "default"
      | "domains"
      | "dedicated_standard"
      | "dedicated_bulletproof"
      | "vds_standard"
      | "vds_bulletproof"
      | "cdn";
  };
  /** Admin domain NS edit: awaiting ns1 ns2 for domainId */
  adminDomainNs?: {
    domainId: number;
  };
  /** Admin set Amper domain ID for stub domain: awaiting providerDomainId string */
  adminDomainSetAmperId?: {
    domainId: number;
  };
  /** Admin register domain for user (no payment): awaiting domain name string */
  adminRegisterDomain?: {
    userId: number;
  };
  /** Withdraw: button was pressed, waiting for user to send amount */
  withdrawStart?: {
    awaitingAmount: true;
    maxBalance: number;
  };
  /** Withdraw: amount passed from message handler into conversation */
  withdrawInitialAmount?: number;
  /** Bundle purchase context */
  bundle?: {
    type: string; // BundleType
    period: string; // BundlePeriod
    step?: "awaiting_domain" | "awaiting_confirm";
    domainName?: string;
    vpsOsId?: number;
  };
  /** CDN proxy: conversation state */
  cdn?: {
    step?: "idle" | "plan" | "domain" | "target" | "confirm";
    /** Product tier (add-proxy flow). */
    planId?: "standard" | "bulletproof" | "bundle";
    domainName?: string;
    targetUrl?: string;
    /** USD charged for this purchase (from plan). */
    price?: number;
    /** Telegram user id for CDN API */
    telegramId?: number;
    /** true when opened from "Управление услугами" (back goes to manage menu) */
    fromManage?: boolean;
  };
  adminCdn?: {
    page: number;
    searchQuery: string;
    selectedProxyId: string | null;
    awaitingSearch: boolean;
  };
}

/**
 * Complete session data structure.
 */
export interface SessionData {
  main: MainSessionData;
  other: OtherSessionData;
}
