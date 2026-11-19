import type { RolePermissions } from "./permissions";

/** Client-side shapes returned by the API routes. */

export interface RexGroup {
  id: number;
  name: string;
  created_at: number;
  sim_count?: number;
  active_sim_count?: number;
  user_count?: number;
}

export interface RoleItem {
  id: number;
  name: string;
  is_system: boolean;
  permissions: RolePermissions;
  created_at: number;
  updated_at: number;
  user_count?: number;
}

export interface UserItem {
  id: number;
  username: string;
  role_id: number;
  role_name: string;
  rex_id: number | null;
  rex_name: string | null;
  is_active: boolean;
  token_version: number;
  is_env_admin: boolean;
  created_at: number;
  updated_at: number;
}

export interface SessionUser {
  id: number;
  username: string;
  roleId: number;
  roleName: string;
  rexId: number | null;
  rexName: string | null;
  isEnvAdmin: boolean;
  permissions: RolePermissions;
}

export interface Sim {
  id: number;
  phone: string;
  rex_id: number | null;
  rex_name?: string | null;
  added_by_user_id?: number | null;
  balance: number | null;
  balance_checked_at: number | null;
  token_expires_at: number | null;
  refresh_expires_at: number | null;
  subscription_id: string | null;
  bill_expire_at?: string | null;
  block_one_way?: string | null;
  block_two_way?: string | null;
  sim_status_text?: string | null;
  status: string;
  note: string | null;
  volume_today: number;
  volume_this_month: number;
  created_at: number;
  updated_at: number;
}

export interface SimsPageResponse {
  sims: Sim[];
  total: number;
  counts: {
    all: number;
    active: number;
    inactive: number;
    drained: number;
    expiring: number;
    expired: number;
  };
}

export interface Transfer {
  id: number;
  sender_phone: string;
  receiver_phone: string;
  rex_id?: number | null;
  rex_name?: string | null;
  created_by_user_id?: number | null;
  created_by_username?: string | null;
  amount: number;
  fee: number;
  status: string;
  error_code: number | null;
  message: string | null;
  created_at: number;
}

export interface ReceiverGroup {
  phone: string;
  totalAmount: number;
  totalFee: number;
  successCount: number;
  lastAt: number;
  transfers?: Transfer[];
}

export interface ReceiversResponse {
  groups: ReceiverGroup[];
  senders: string[];
  transferCount: number;
}

export interface Stats {
  simCount: number;
  loggedIn: number;
  totalBalance: number | null;
  recent: Transfer[];
}

export interface SeriesBucket {
  ts: number;
  sent: number;
  failed: number;
  volume: number;
}

export interface StatsResponse {
  ok: boolean;
  stats: Stats;
  series: {
    from: number;
    to: number;
    granularity: "hour" | "day";
    buckets: SeriesBucket[];
  };
  totals: { sent: number; failed: number; volume: number };
  topErrors: { reason: string; count: number }[];
}
