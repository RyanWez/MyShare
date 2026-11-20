/** Shared with client components — must stay free of server-only imports. */

/** MyShare limits based on volume. */
export const DAILY_VOLUME_LIMIT = 25000;
export const MONTHLY_VOLUME_LIMIT = 50000;

/** Minimum SIM balance (5,000 Ks transfer + 5% fee) required for a full default transfer. */
export const TRANSFER_READY_MIN_BALANCE = 5250;

/** Server-enforced cooldown between successful balance refreshes on the same SIM. */
export const SIM_REFRESH_COOLDOWN_SEC = 5 * 60;

/**
 * A SIM under this can no longer fund a transfer worth sending, so the tray has
 * a "Drained" view that gathers them for one Select → Remove pass.
 *
 * A threshold, not an automatic sweep: `balance` is a cached figure, only as
 * fresh as the last read, and removing a SIM discards its tokens for good.
 */
export const LOW_BALANCE_THRESHOLD = 4000;
