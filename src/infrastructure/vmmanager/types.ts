/**
 * VMManager API types.
 *
 * @module infrastructure/vmmanager/types
 */

// Re-export types from old location temporarily (API has typo: CreateVMSuccesffulyResponse)
import type {
  CreatePublicTokenResponse,
  CreateVMSuccesffulyResponse,
  GetOsListResponse,
  Os,
  GetVMResponse,
  ListItem,
} from "../../api/vmmanager.js";
export type { CreatePublicTokenResponse, CreateVMSuccesffulyResponse, GetOsListResponse, Os, GetVMResponse, ListItem };
export type CreateVMSuccessfullyResponse = CreateVMSuccesffulyResponse;
