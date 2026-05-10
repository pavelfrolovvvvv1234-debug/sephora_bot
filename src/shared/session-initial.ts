/**
 * Initial session data factories for Grammy multi-session.
 * Keeps session type inference aligned with SessionData from session.ts.
 *
 * @module shared/session-initial
 */

import type { SessionData } from "./types/session.js";
import { Role, UserStatus } from "../entities/User.js";

export function createInitialMainSession(): SessionData["main"] {
  return {
    locale: "ru",
    user: {
      id: 0,
      balance: 0,
      referralBalance: 0,
      role: Role.User,
      status: UserStatus.User,
      isBanned: false,
    },
    lastSumDepositsEntered: 0,
    topupMethod: null,
  };
}

export function createInitialOtherSession(): SessionData["other"] {
  return {
    broadcast: { step: "idle" },
    controlUsersPage: { orderBy: "id", sortBy: "ASC", page: 0 },
    vdsRate: {
      bulletproof: true,
      selectedRateId: -1,
      selectedOs: -1,
      shopTier: null,
      shopListPage: 0,
    },
    dedicatedType: {
      bulletproof: false,
      selectedDedicatedId: -1,
      shopTier: null,
      shopListPage: 0,
    },
    manageVds: {
      lastPickedId: -1,
      page: 0,
      expandedId: null,
      showPassword: false,
      pendingRenameVdsId: null,
      pendingManualPasswordVdsId: null,
      pendingRenewMonths: null,
    },
    adminVds: {
      page: 0,
      searchQuery: "",
      selectedVdsId: null,
      awaitingSearch: false,
      awaitingTransferUserId: false,
    },
    manageDedicated: { expandedId: null, showPassword: false },
    domains: {
      lastPickDomain: "",
      page: 0,
      pendingZone: undefined,
      shopCategory: undefined,
      shopAllPage: undefined,
      shopConfirmZone: undefined,
    },
    dedicatedOrder: { step: "idle", requirements: undefined },
    cdn: { step: "idle" },
    adminCdn: { page: 0, searchQuery: "", selectedProxyId: null, awaitingSearch: false },
    ticketsView: { list: null, currentTicketId: null, pendingAction: null, pendingTicketId: null, pendingData: {} },
    deposit: { awaitingAmount: false, prefilledAmount: false, selectedAmount: 50 },
    promocode: { awaitingInput: false },
    promoAdmin: { page: 0, editingPromoId: null, createStep: null, createDraft: {}, editStep: null },
  };
}
