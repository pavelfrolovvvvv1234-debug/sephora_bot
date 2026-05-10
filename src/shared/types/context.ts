/**
 * Grammy context extension types.
 *
 * @module shared/types/context
 */

import { Context, LazySessionFlavor } from "grammy";
import { FluentContextFlavor } from "@grammyjs/fluent";
import { MenuFlavor } from "@grammyjs/menu";
import { ConversationFlavor, Conversation } from "@grammyjs/conversations";
import { DataSource } from "typeorm";
import type { GetOsListResponse, VmProvider } from "../../infrastructure/vmmanager/provider.js";
import { SessionData } from "./session.js";
import type User from "../../entities/User.js";

/**
 * Extended Grammy context with all required flavors and custom properties.
 */
export type AppContext = ConversationFlavor<
  Context &
    FluentContextFlavor &
    LazySessionFlavor<SessionData> &
    MenuFlavor & {
      availableLanguages: string[];
      appDataSource: DataSource;
      vmmanager: VmProvider;
      osList: GetOsListResponse | null;
      /** User loaded in session middleware; use to avoid duplicate DB fetch (e.g. locale). */
      loadedUser?: User | null;
    }
>;

/**
 * Conversation type for Grammy conversations.
 */
export type AppConversation = Conversation<AppContext>;
