/**
 * Granular Role-Based Access Control (RBAC) permissions model.
 * Shared across server route guards and client UI components (no server-only imports).
 */

export interface OverviewPermissions {
  view: boolean;
  totalBalance: boolean;
  successMetric: boolean;
  volumeMetric: boolean;
  netVolumeMetric: boolean;
  transfersChart: boolean;
  volumeChart: boolean;
  topErrorsChart: boolean;
  recentList: boolean;
}

export interface RolePermissions {
  overview: OverviewPermissions;
  transfer: {
    view: boolean;
    execute: boolean;
  };
  sims: {
    view: boolean;
    addLogin: boolean;
    refresh: boolean;
    refreshUnlimited: boolean;
    delete: boolean;
    moveRex: boolean;
  };
  receivers: {
    view: boolean;
  };
  history: {
    view: boolean;
    export: boolean;
    delete: boolean;
  };
  rex: {
    viewAll: boolean;
  };
  users: {
    manage: boolean;
  };
  roles: {
    manage: boolean;
  };
}

export const DEFAULT_ADMIN_PERMISSIONS: RolePermissions = {
  overview: {
    view: true,
    totalBalance: true,
    successMetric: true,
    volumeMetric: true,
    netVolumeMetric: true,
    transfersChart: true,
    volumeChart: true,
    topErrorsChart: true,
    recentList: true,
  },
  transfer: {
    view: true,
    execute: true,
  },
  sims: {
    view: true,
    addLogin: true,
    refresh: true,
    refreshUnlimited: true,
    delete: true,
    moveRex: true,
  },
  receivers: {
    view: true,
  },
  history: {
    view: true,
    export: true,
    delete: true,
  },
  rex: {
    viewAll: true,
  },
  users: {
    manage: true,
  },
  roles: {
    manage: true,
  },
};

export const DEFAULT_STAFF_PERMISSIONS: RolePermissions = {
  overview: {
    view: true,
    totalBalance: true,
    successMetric: true,
    volumeMetric: true,
    netVolumeMetric: false,
    transfersChart: true,
    volumeChart: true,
    topErrorsChart: true,
    recentList: true,
  },
  transfer: {
    view: true,
    execute: true,
  },
  sims: {
    view: true,
    addLogin: true,
    refresh: true,
    refreshUnlimited: false,
    delete: false,
    moveRex: false,
  },
  receivers: {
    view: true,
  },
  history: {
    view: true,
    export: true,
    delete: false,
  },
  rex: {
    viewAll: false,
  },
  users: {
    manage: false,
  },
  roles: {
    manage: false,
  },
};

function bool(val: unknown, fallback: boolean): boolean {
  return typeof val === "boolean" ? val : fallback;
}

/**
 * Coerce any JSON object stored in `roles.permissions` or sent by the client
 * into a complete, well-typed `RolePermissions` object with safe defaults.
 */
export function normalizePermissions(
  raw: unknown,
  fallback: RolePermissions = DEFAULT_STAFF_PERMISSIONS
): RolePermissions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const ov = (r.overview && typeof r.overview === "object" ? r.overview : {}) as Record<string, any>;
  const tr = (r.transfer && typeof r.transfer === "object" ? r.transfer : {}) as Record<string, any>;
  const sm = (r.sims && typeof r.sims === "object" ? r.sims : {}) as Record<string, any>;
  const rc = (r.receivers && typeof r.receivers === "object" ? r.receivers : {}) as Record<string, any>;
  const hs = (r.history && typeof r.history === "object" ? r.history : {}) as Record<string, any>;
  const rx = (r.rex && typeof r.rex === "object" ? r.rex : {}) as Record<string, any>;
  const us = (r.users && typeof r.users === "object" ? r.users : {}) as Record<string, any>;
  const rl = (r.roles && typeof r.roles === "object" ? r.roles : {}) as Record<string, any>;

  const overviewView = bool(ov.view, fallback.overview.view);
  const transferView = bool(tr.view, fallback.transfer.view);
  const simsView = bool(sm.view, fallback.sims.view);
  const simsRefresh = simsView && bool(sm.refresh, fallback.sims.refresh);
  const historyView = bool(hs.view, fallback.history.view);

  return {
    overview: {
      view: overviewView,
      totalBalance: overviewView && bool(ov.totalBalance, fallback.overview.totalBalance),
      successMetric: overviewView && bool(ov.successMetric, fallback.overview.successMetric),
      volumeMetric: overviewView && bool(ov.volumeMetric, fallback.overview.volumeMetric),
      netVolumeMetric: overviewView && bool(ov.netVolumeMetric, fallback.overview.netVolumeMetric),
      transfersChart: overviewView && bool(ov.transfersChart, fallback.overview.transfersChart),
      volumeChart: overviewView && bool(ov.volumeChart, fallback.overview.volumeChart),
      topErrorsChart: overviewView && bool(ov.topErrorsChart, fallback.overview.topErrorsChart),
      recentList: overviewView && bool(ov.recentList, fallback.overview.recentList),
    },
    transfer: {
      view: transferView,
      execute: transferView && bool(tr.execute, fallback.transfer.execute),
    },
    sims: {
      view: simsView,
      addLogin: simsView && bool(sm.addLogin, fallback.sims.addLogin),
      refresh: simsRefresh,
      refreshUnlimited: simsRefresh && bool(sm.refreshUnlimited, fallback.sims.refreshUnlimited),
      delete: simsView && bool(sm.delete, fallback.sims.delete),
      moveRex: simsView && bool(sm.moveRex, fallback.sims.moveRex),
    },
    receivers: {
      view: bool(rc.view, fallback.receivers.view),
    },
    history: {
      view: historyView,
      export: historyView && bool(hs.export, fallback.history.export),
      delete: historyView && bool(hs.delete, fallback.history.delete),
    },
    rex: {
      viewAll: bool(rx.viewAll, fallback.rex.viewAll),
    },
    users: {
      manage: bool(us.manage, fallback.users.manage),
    },
    roles: {
      manage: bool(rl.manage, fallback.roles.manage),
    },
  };
}

/** Whether an operator is exempt from SIM refresh cooldown & burst rate limits. */
export function hasUnlimitedRefresh(
  roleName: string | undefined,
  permissions: RolePermissions,
  isEnvAdmin?: boolean
): boolean {
  return Boolean(isEnvAdmin) || roleName?.toLowerCase() === "admin" || permissions.sims.refreshUnlimited;
}

/** First accessible route for a user (used when Overview is disabled for a role). */
export function firstAllowedRoute(p: RolePermissions): string {
  if (p.overview.view) return "/";
  if (p.transfer.view) return "/transfer";
  if (p.sims.view) return "/sims";
  if (p.receivers.view) return "/receivers";
  if (p.history.view) return "/history";
  if (p.users.manage) return "/users";
  if (p.roles.manage) return "/roles";
  return "/login";
}
