/**
 * Event payload types for automation engine.
 *
 * @module modules/automations/events/types
 */

export type AutomationEventName =
  | "deposit.created"
  | "deposit.completed"
  | "user.login"
  | "service.created"
  | "service.expiring"
  | "service.grace_start"
  | "incident.created"
  | "tier.achieved";

export interface BaseEventPayload {
  userId: number;
  timestamp: Date;
}

export interface DepositCreatedPayload extends BaseEventPayload {
  event: "deposit.created";
  topUpId: number;
  amount: number;
  targetUserId: number;
}

export interface DepositCompletedPayload extends BaseEventPayload {
  event: "deposit.completed";
  topUpId: number;
  amount: number;
  targetUserId: number;
}

export interface UserLoginPayload extends BaseEventPayload {
  event: "user.login";
  telegramId: number;
}

export interface ServiceCreatedPayload extends BaseEventPayload {
  event: "service.created";
  serviceType: "vds" | "dedicated" | "domain";
  serviceId: number;
  userId: number;
}

export interface ServiceExpiringPayload extends BaseEventPayload {
  event: "service.expiring" | "service.grace_start";
  serviceType: "vds" | "dedicated" | "domain";
  serviceId: number;
  userId: number;
  payDayAt?: Date;
  graceDay?: number;
}

export interface IncidentCreatedPayload extends BaseEventPayload {
  event: "incident.created";
  serviceType: string;
  serviceId: number;
  severity: string;
}

export interface TierAchievedPayload extends BaseEventPayload {
  event: "tier.achieved";
  tier: string;
  previousTier: string;
  cumulativeDeposit: number;
}

export type AutomationEventPayload =
  | DepositCreatedPayload
  | DepositCompletedPayload
  | UserLoginPayload
  | ServiceCreatedPayload
  | ServiceExpiringPayload
  | IncidentCreatedPayload
  | TierAchievedPayload;
