export const hostelLicenseStatuses = [
  "unused",
  "activated",
  "expired",
  "revoked"
] as const;

export type HostelLicenseStatus = (typeof hostelLicenseStatuses)[number];
export type HostelLicenseStatusFilter = "all" | HostelLicenseStatus;

export interface HostelLicenseOverviewDTO {
  total: number;
  unused: number;
  activated: number;
  expired: number;
  revoked: number;
  generatedAt: string;
}

export interface HostelLicenseListItemDTO {
  id: string;
  status: HostelLicenseStatus;
  plan: "commercial";
  maxActivations: number;
  activeActivationCount: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostelActivationDTO {
  id: string;
  deviceName: string;
  activatedAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  isBound: boolean;
  isUsable: boolean;
}

export interface HostelLicenseDetailDTO extends HostelLicenseListItemDTO {
  usableActivationCount: number;
  activations: HostelActivationDTO[];
}

export interface HostelLicensePageDTO {
  items: HostelLicenseListItemDTO[];
  pageSize: number;
  nextCursor: string | null;
}

export interface HostelActivationListDTO {
  items: HostelActivationDTO[];
}

export interface HostelLicenseRow {
  id: string;
  status: string;
  plan: string;
  max_activations: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HostelActivationRow {
  id: string;
  license_id: string;
  device_name: string;
  activated_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

export interface HostelLicenseCursor {
  createdAt: string;
  id: string;
}
