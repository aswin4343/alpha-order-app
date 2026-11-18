import assert from 'node:assert/strict'
import * as A from './priceApproval.mjs'
const results = []
const t = (name, fn) => { try { fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name + ' — ' + e.message]) } }

// Product A at revision 2 (id 900), wholesale ₹30 / retail ₹32
const prodA = { id: 'pA', name: 'TEST PRODUCT A', retail: 32, wholesale: 30, mrp: 35, price_version: 2, current_price_revision_id: 900, price_changed_at: '2026-11-18T05:00:00Z' }
const prodA_rev3 = { ...prodA, retail: 37, wholesale: 35, price_version: 3, current_price_revision_id: 901, price_changed_at: '2026-11-19T05:00:00Z' }
// Shop A's approvals as returned by loadShopPriceApprovals (one customer only)
const shopA = A.buildShopApprovalIndex([
  { product_id: 'pA', price_revision_id: 900, revision_number: 2, approved_price: '28.00', status: 'approved' },
  { product_id: 'pA', price_revision_id: 800, revision_number: 1, approved_price: '22.00', status: 'approved' },
  { product_id: 'pA', price_revision_id: 900, revision_number: 2, approved_price: '26.00', status: 'revoked' }
])
const shopB = A.buildShopApprovalIndex([])

t('paise conversion avoids float error (0.1+0.2 vs 0.3)', () => assert.ok(A.samePrice(0.1 + 0.2, 0.3)))
t('₹28 == ₹28.00 == "28"', () => { assert.ok(A.samePrice(28, '28.00')); assert.ok(A.samePrice('28', 28.0)) })
t('₹28 != ₹28.01 / ₹27 / ₹29', () => { assert.ok(!A.samePrice(28, 28.01)); assert.ok(!A.samePrice(28, 27)); assert.ok(!A.samePrice(28, 29)) })
t('Scenario C: Shop A ₹28 approved at current revision', () => assert.ok(A.isShopApproved(shopA, prodA, 28)))
t('Scenario C: approved chip list = [28] (old-revision ₹22 and revoked ₹26 excluded)', () => assert.deepEqual(A.approvedPricesFor(shopA, prodA), [28]))
t('Shop A ₹27 / ₹29 not approved', () => { assert.ok(!A.isShopApproved(shopA, prodA, 27)); assert.ok(!A.isShopApproved(shopA, prodA, 29)) })
t('Scenario D: Shop B ₹28 not approved', () => assert.ok(!A.isShopApproved(shopB, prodA, 28)))
t('Scenario E: after revision 3, Shop A ₹28 not approved', () => { assert.ok(!A.isShopApproved(shopA, prodA_rev3, 28)); assert.deepEqual(A.approvedPricesFor(shopA, prodA_rev3), []) })
t('Cached catalogue without revision id falls back to revision number', () => {
  const cached = { ...prodA, current_price_revision_id: undefined }
  assert.ok(A.isShopApproved(shopA, cached, 28))
})

// Last Price
const lp = {
  'TEST PRODUCT A||Piece': { price: 25, priceVersion: 1, unit: 'Piece', verifiedAt: '2026-11-17T10:00:00Z' },
  'TEST PRODUCT A': { price: 25, priceVersion: 1, unit: 'Piece', verifiedAt: '2026-11-17T10:00:00Z' }
}
t('Scenario A: ₹25 Last Price from revision 1 is removed at revision 2', () => assert.equal(A.currentLastPriceEntry(lp, prodA, 'Piece'), null))
t('Last Price at the current revision is offered', () => {
  const lp2 = { 'TEST PRODUCT A||Piece': { price: 28, priceVersion: 2, verifiedAt: '2026-11-18T10:00:00Z' } }
  assert.equal(A.currentLastPriceEntry(lp2, prodA, 'Piece')?.price, 28)
})
t('Legacy Last Price (no revision) BEFORE the price change → hidden', () => {
  const lp3 = { 'TEST PRODUCT A||Piece': { price: 25, priceVersion: null, verifiedAt: '2026-11-17T10:00:00Z' } }
  assert.equal(A.currentLastPriceEntry(lp3, prodA, 'Piece'), null)
})
t('Legacy Last Price (no revision) AFTER the last price change → offered', () => {
  const lp4 = { 'TEST PRODUCT A||Piece': { price: 31, priceVersion: null, verifiedAt: '2026-11-18T09:00:00Z' } }
  assert.equal(A.currentLastPriceEntry(lp4, prodA, 'Piece')?.price, 31)
})
t('Legacy Last Price with no date at all → hidden (insufficient information)', () => {
  assert.equal(A.currentLastPriceEntry({ 'TEST PRODUCT A': 25 }, prodA, 'Piece'), null)
})

// Default price & approval rule (mirrors the database trigger)
t('Retail customer default = current Retail ₹32', () => assert.equal(A.customerFloor(prodA, 'RETAIL'), 32))
t('Wholesale customer default = current Wholesale ₹30', () => assert.equal(A.customerFloor(prodA, 'WHOLESALE'), 30))
t('Retail customer at Wholesale price → approval', () => assert.ok(A.needsApprovalBelowFloor({ product: prodA, price: 30, defaultPriceType: 'RETAIL' })))
t('Retail customer custom below Retail → approval', () => assert.ok(A.needsApprovalBelowFloor({ product: prodA, price: 31.5, defaultPriceType: 'RETAIL' })))
t('Wholesale customer custom below Wholesale → approval', () => assert.ok(A.needsApprovalBelowFloor({ product: prodA, price: 28, defaultPriceType: 'WHOLESALE' })))
t('Wholesale customer at Wholesale → no approval', () => assert.ok(!A.needsApprovalBelowFloor({ product: prodA, price: 30, defaultPriceType: 'WHOLESALE' })))
t('Box at wholesale (existing exemption) → no approval', () => assert.ok(!A.needsApprovalBelowFloor({ product: prodA, price: 30, defaultPriceType: 'RETAIL', isBoxUnit: true })))

for (const [r, n] of results) console.log(r, n)
const failed = results.filter(r => r[0] === 'FAIL').length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
