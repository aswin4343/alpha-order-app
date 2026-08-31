// ============================================================================
// FEATURE FLAGS — simple on/off switches for features that are built and
// tested but temporarily paused (e.g. a team needs time to adjust their
// workflow before a gate goes live). Flip back to `true` to re-enable; no
// other code changes needed — the underlying feature, database columns, and
// Admin screen are untouched and ready to go the moment this flips back.
// ============================================================================

/**
 * Admin approval gate for special/custom pricing (spec: any price deviation
 * from MRP/RP/WP requires sign-off before that line can be billed).
 * Paused 2026 to give the sales/billing team time to adjust their workflow
 * before the gate becomes mandatory. When false:
 *   - New orders never get an item flagged 'pending' — special prices bill
 *     normally, same as before this feature existed.
 *   - Any items already flagged 'pending'/'rejected' from earlier testing
 *     bill normally too (Billing no longer excludes/gates on approval_status).
 *   - The Admin "Price Approvals" section is hidden from navigation.
 * Nothing is deleted — re-enable by flipping this back to true.
 */
export const PRICE_APPROVAL_ENABLED = false
