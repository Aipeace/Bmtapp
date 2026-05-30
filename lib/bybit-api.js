/**
 * lib/bybit-api.js
 * Bybit P2P REST API — corrected against official docs
 * https://bybit-exchange.github.io/docs/p2p/guide
 *
 * IMPORTANT: Bybit P2P endpoints return snake_case fields:
 *   ret_code  (not retCode)
 *   ret_msg   (not retMsg)
 *
 * All callers must check res.ret_code === 0, res.ret_msg
 */

'use strict';

const crypto = require('crypto');

class BybitP2PApi {
  constructor(apiKey, apiSecret, testnet = false) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.baseUrl    = testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
    this.recvWindow = '5000';
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  _buildHeaders(payload) {
    const ts   = Date.now().toString();
    const pre  = `${ts}${this.apiKey}${this.recvWindow}${payload}`;
    const sign = crypto.createHmac('sha256', this.apiSecret).update(pre).digest('hex');
    return {
      'Content-Type':       'application/json',
      'X-BAPI-API-KEY':     this.apiKey,
      'X-BAPI-TIMESTAMP':   ts,
      'X-BAPI-SIGN':        sign,
      'X-BAPI-RECV-WINDOW': this.recvWindow,
    };
  }

  async _get(path, params = {}) {
    const qs  = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
    ).toString();
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, { headers: this._buildHeaders(qs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on GET ${path}`);
    return res.json();
  }

  async _post(path, body = {}) {
    const bodyStr = JSON.stringify(body);
    const url     = `${this.baseUrl}${path}`;
    const res     = await fetch(url, {
      method:  'POST',
      headers: this._buildHeaders(bodyStr),
      body:    bodyStr,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on POST ${path}`);
    return res.json();
  }

  // ── Account ───────────────────────────────────────────────────────────────

  /** Fund wallet balance — uses standard V5 API (retCode/retMsg camelCase) */
  getAccountBalance() {
    return this._get('/v5/account/wallet-balance', { accountType: 'FUND' });
  }

  /**
   * P2P merchant profile.
   * Endpoint: POST /v5/p2p/user/personal/info
   * Response: ret_code / ret_msg (snake_case)
   */
  getP2PProfile() {
    return this._post('/v5/p2p/user/personal/info', {});
  }

  /**
   * User's saved payment methods.
   * Endpoint: POST /v5/p2p/user/payment/list
   */
  getPaymentMethods() {
    return this._post('/v5/p2p/user/payment/list', {});
  }

  // ── Ads ───────────────────────────────────────────────────────────────────

  /**
   * List your own ads.
   * Endpoint: POST /v5/p2p/item/personal/list   ← CORRECTED (was /v5/p2p/item/list)
   * Docs: https://bybit-exchange.github.io/docs/p2p/ad/ad-list
   */
  getMyAds(params = {}) {
    return this._post('/v5/p2p/item/personal/list', {
      page: String(params.page  || 1),
      size: String(params.size  || 20),
      ...(params.tokenId   ? { tokenId:    params.tokenId   } : {}),
      ...(params.side      ? { side:       String(params.side) } : {}),
      ...(params.status    ? { status:     String(params.status) } : {}),
      ...(params.currencyId? { currencyId: params.currencyId } : {}),
    });
  }

  /**
   * Single ad detail.
   * Endpoint: POST /v5/p2p/item/info
   * Docs: https://bybit-exchange.github.io/docs/p2p/ad/ad-detail
   */
  async getAdDetail(itemId) {
    const resp = await this._post('/v5/p2p/item/info', { itemId });
    // Bybit wraps single-item responses in result.result (nested)
    if (resp.result?.result) resp.result = resp.result.result;
    return resp;
  }

  /**
   * Create a new ad.
   * Endpoint: POST /v5/p2p/item/create
   * Docs: https://bybit-exchange.github.io/docs/p2p/ad/post-new-ad
   */
  createAd(params) {
    const required = ['side', 'tokenId', 'currencyId', 'priceType', 'quantity', 'minAmount', 'maxAmount'];
    for (const f of required) {
      if (params[f] === undefined || params[f] === '')
        throw new Error(`createAd: missing required field "${f}"`);
    }
    return this._post('/v5/p2p/item/create', params);
  }

  /**
   * Update an existing ad.
   * Endpoint: POST /v5/p2p/item/update
   */
  updateAd(itemId, params) {
    return this._post('/v5/p2p/item/update', { itemId, ...params });
  }

  /**
   * Toggle ad online/offline.
   * Endpoint: POST /v5/p2p/item/update
   * status: '10' = online, '20' = offline
   * Docs: https://bybit-exchange.github.io/docs/p2p/ad/update-list-ad
   */
  toggleAdStatus(itemId, status) {
    return this._post('/v5/p2p/item/update', { itemId, status: String(status) });
  }

  /**
   * Delete/cancel an ad.
   * Endpoint: POST /v5/p2p/item/cancel
   * Docs: https://bybit-exchange.github.io/docs/p2p/ad/remove-ad
   */
  deleteAd(itemId) {
    return this._post('/v5/p2p/item/cancel', { itemId });
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /**
   * List orders.
   * Endpoint: POST /v5/p2p/order/simplifyList   ← CORRECTED (was /v5/p2p/order/list)
   * Docs: https://bybit-exchange.github.io/docs/p2p/order/order-list
   *
   * Status codes:
   *   10 = waiting for buyer to pay
   *   20 = waiting for seller to release
   *   30 = appealing
   *   40 = cancelled
   *   50 = finished
   */
  getOrders(params = {}) {
    const body = {
      page: params.page || 1,
      size: Math.min(params.size || 20, 30), // API max is 30
    };
    if (params.status)    body.status    = Number(params.status);
    if (params.beginTime) body.beginTime = String(params.beginTime);
    if (params.endTime)   body.endTime   = String(params.endTime);
    if (params.tokenId)   body.tokenId   = params.tokenId;
    if (params.side !== undefined) body.side = Number(params.side);
    return this._post('/v5/p2p/order/simplifyList', body);
  }

  /**
   * Full order detail.
   * Endpoint: POST /v5/p2p/order/info
   * Docs: https://bybit-exchange.github.io/docs/p2p/order/order-detail
   */
  getOrderDetail(orderId) {
    return this._post('/v5/p2p/order/info', { orderId });
  }

  /**
   * Mark order as paid (buyer confirms payment sent).
   * Endpoint: POST /v5/p2p/order/pay
   * Docs: https://bybit-exchange.github.io/docs/p2p/order/mark-order-as-paid
   */
  confirmPayment(orderId) {
    return this._post('/v5/p2p/order/pay', { orderId });
  }

  /**
   * Release crypto (seller confirms payment received).
   * Endpoint: POST /v5/p2p/order/release-digital-asset
   * Docs: https://bybit-exchange.github.io/docs/p2p/order/release-digital-asset
   */
  releaseAsset(orderId) {
    return this._post('/v5/p2p/order/release-digital-asset', { orderId });
  }

  /**
   * Cancel an order.
   * Endpoint: POST /v5/p2p/order/cancel
   */
  cancelOrder(orderId, cancelType = '1') {
    return this._post('/v5/p2p/order/cancel', { orderId, cancelType: String(cancelType) });
  }

  /**
   * Open an appeal.
   * Endpoint: POST /v5/p2p/order/appeal
   */
  appealOrder(orderId, appealType, appealNote = '') {
    return this._post('/v5/p2p/order/appeal', {
      orderId,
      appealType:  String(appealType),
      appealNote,
    });
  }

  /**
   * Order history for analytics (last N days).
   * Uses the same simplifyList endpoint with date range.
   */
  getOrderHistory(days = 30) {
    const endTime   = Date.now();
    const startTime = endTime - days * 86400000;
    return this.getOrders({
      page:      1,
      size:      30,
      beginTime: String(startTime),
      endTime:   String(endTime),
    });
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  /**
   * Fetch chat messages for an order.
   * Endpoint: POST /v5/p2p/order/message/listPage
   * Docs: https://bybit-exchange.github.io/docs/p2p/order/chat-msg
   */
  getChatMessages(orderId, size = 50) {
    return this._post('/v5/p2p/order/message/listPage', {
      orderId,
      size: Number(size),
    });
  }

  /**
   * Send a chat message.
   * Endpoint: POST /v5/p2p/order/message/send
   * Docs: https://bybit-exchange.github.io/docs/p2p/order/send-chat-msg
   */
  sendChatMessage(orderId, message, msgType = 'str') {
    return this._post('/v5/p2p/order/message/send', { orderId, message, msgType });
  }

  // ── Market / Public ──────────────────────────────────────────────────────

  /**
   * Browse live P2P market ads.
   * Endpoint: POST /v5/p2p/item/online   ← CORRECTED (was /v5/p2p/item/online-ads)
   * Docs: https://bybit-exchange.github.io/docs/p2p/ad/online-ad-list
   */
  getMarketAds(params = {}) {
    return this._post('/v5/p2p/item/online', {
      tokenId:    params.tokenId    || 'USDT',
      currencyId: params.currencyId || 'NGN',
      side:       String(params.side || '0'),
      page:       String(params.page || 1),
      size:       String(params.size || 10),
    });
  }

  /**
   * All tokens supported for P2P trading.
   * Endpoint: GET /v5/p2p/config/token/list
   */
  getSupportedTokens() {
    return this._get('/v5/p2p/config/token/list', {});
  }

  /**
   * All fiat currencies supported for P2P trading.
   * Endpoint: GET /v5/p2p/config/currency/list
   */
  getSupportedCurrencies() {
    return this._get('/v5/p2p/config/currency/list', {});
  }
}

module.exports = BybitP2PApi;
