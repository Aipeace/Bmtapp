/**
 * lib/bybit-api.js
 * Bybit P2P REST API v5 — corrected against official Bybit P2P API repo
 *
 * Fixes applied:
 *  1. getAccountBalance → /v5/asset/transfer/query-account-coins-balance (was wallet-balance)
 *  2. getMarketAds     → POST /v5/p2p/item/online (was GET /v5/p2p/item/online-ads)
 *  3. getOrders        → /v5/p2p/order/simplifyList (was /v5/p2p/order/list)
 *  4. getMyAds         → /v5/p2p/item/personal/list (was /v5/p2p/item/list)
 *  5. releaseAsset     → /v5/p2p/order/finish (was /v5/p2p/order/release-digital-asset)
 *  6. getChatMessages  → /v5/p2p/order/message/listpage (was /v5/p2p/order/message/list)
 *  7. getSupportedTokens/Currencies → correct P2P config endpoints
 *  8. getOrderHistory  → now returns ALL pages via pagination, not just first 30
 *  9. Bybit P2P returns ret_code/ret_msg (snake_case); V5 asset API returns
 *     retCode/retMsg (camelCase). _get()/_post() now check BOTH so errors are
 *     always surfaced regardless of which sub-API the endpoint belongs to.
 * 10. fetch() is available in Node ≥18. Added an explicit guard with a clear
 *     error message if running on an older Node version.
 */

'use strict';

const crypto = require('crypto');

// Guard: fetch is built-in from Node 18+. Fail fast with a clear message.
if (typeof fetch === 'undefined') {
  throw new Error(
    'globalThis.fetch is not available. Please upgrade to Node.js ≥ 18, ' +
    'or run: npm install node-fetch and update lib/bybit-api.js to require it.'
  );
}

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

  // FIX #9: Check both snake_case (P2P endpoints) and camelCase (V5 asset endpoints)
  _checkApiError(json) {
    if (json.ret_code !== undefined && json.ret_code !== 0) {
      throw new Error(`Bybit error ${json.ret_code}: ${json.ret_msg}`);
    }
    if (json.retCode !== undefined && json.retCode !== 0) {
      throw new Error(`Bybit error ${json.retCode}: ${json.retMsg}`);
    }
  }

  async _get(path, params = {}) {
    const qs  = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
    ).toString();
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const res = await fetch(url, { headers: this._buildHeaders(qs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} on GET ${path}`);
    const json = await res.json();
    this._checkApiError(json);
    return json;
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
    const json = await res.json();
    this._checkApiError(json);
    return json;
  }

  // ── Account ───────────────────────────────────────────────────────────────

  /**
   * FIX #1: Correct endpoint for coin balance.
   * NOTE: This V5 asset endpoint returns retCode/retMsg (camelCase), not
   * ret_code/ret_msg. _checkApiError() handles both so errors are always caught.
   */
  getAccountBalance(coin = 'USDT') {
    return this._get('/v5/asset/transfer/query-account-coins-balance', {
      accountType: 'FUND',
      coin,
    });
  }

  /** POST /v5/p2p/user/personal/info */
  getP2PProfile() {
    return this._post('/v5/p2p/user/personal/info', {});
  }

  /** POST /v5/p2p/user/payment/list */
  getPaymentMethods() {
    return this._post('/v5/p2p/user/payment/list', {});
  }

  // ── Ads ───────────────────────────────────────────────────────────────────

  /**
   * FIX #4: List your own ads.
   * Was: POST /v5/p2p/item/list
   * Now: POST /v5/p2p/item/personal/list
   */
  getMyAds(params = {}) {
    return this._post('/v5/p2p/item/personal/list', {
      page: String(params.page  || 1),
      size: String(params.size  || 20),
      ...(params.tokenId    ? { tokenId:    params.tokenId              } : {}),
      ...(params.side       ? { side:       String(params.side)         } : {}),
      ...(params.status     ? { status:     String(params.status)       } : {}),
      ...(params.currencyId ? { currencyId: params.currencyId           } : {}),
    });
  }

  /** POST /v5/p2p/item/info */
  async getAdDetail(itemId) {
    const resp = await this._post('/v5/p2p/item/info', { itemId });
    // Bybit wraps single-item responses in result.result
    if (resp.result?.result) resp.result = resp.result.result;
    return resp;
  }

  /** POST /v5/p2p/item/create */
  createAd(params) {
    const required = ['side', 'tokenId', 'currencyId', 'priceType', 'quantity', 'minAmount', 'maxAmount'];
    for (const f of required) {
      if (params[f] === undefined || params[f] === '')
        throw new Error(`createAd: missing required field "${f}"`);
    }
    if (params.priceType === '1' && !params.price)
      throw new Error('createAd: fixed price requires "price" field');
    if (params.priceType === '2' && !params.premium)
      throw new Error('createAd: float price requires "premium" field');
    return this._post('/v5/p2p/item/create', params);
  }

  /** POST /v5/p2p/item/update */
  updateAd(itemId, params) {
    return this._post('/v5/p2p/item/update', { itemId, ...params });
  }

  /**
   * Toggle ad online/offline via update.
   * status: '10' = online, '20' = offline
   */
  toggleAdStatus(itemId, status) {
    return this._post('/v5/p2p/item/update', { itemId, status: String(status) });
  }

  /** POST /v5/p2p/item/cancel */
  deleteAd(itemId) {
    return this._post('/v5/p2p/item/cancel', { itemId });
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /**
   * FIX #3: List orders.
   * Was: POST /v5/p2p/order/list
   * Now: POST /v5/p2p/order/simplifyList
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
    if (params.status    !== undefined && params.status !== '') body.status    = Number(params.status);
    if (params.beginTime) body.beginTime = String(params.beginTime);
    if (params.endTime)   body.endTime   = String(params.endTime);
    if (params.tokenId)   body.tokenId   = params.tokenId;
    if (params.side !== undefined) body.side = Number(params.side);
    return this._post('/v5/p2p/order/simplifyList', body);
  }

  /** POST /v5/p2p/order/info */
  getOrderDetail(orderId) {
    return this._post('/v5/p2p/order/info', { orderId });
  }

  /** POST /v5/p2p/order/pay */
  confirmPayment(orderId) {
    return this._post('/v5/p2p/order/pay', { orderId });
  }

  /**
   * FIX #5: Release crypto.
   * Was: POST /v5/p2p/order/release-digital-asset
   * Now: POST /v5/p2p/order/finish
   */
  releaseAsset(orderId) {
    return this._post('/v5/p2p/order/finish', { orderId });
  }

  /** POST /v5/p2p/order/cancel */
  cancelOrder(orderId, cancelType = '1') {
    return this._post('/v5/p2p/order/cancel', { orderId, cancelType: String(cancelType) });
  }

  /** POST /v5/p2p/order/appeal */
  appealOrder(orderId, appealType, appealNote = '') {
    return this._post('/v5/p2p/order/appeal', {
      orderId,
      appealType:  String(appealType),
      appealNote,
    });
  }

  /**
   * FIX #8: Order history now paginates to collect all records in range,
   * not just the first page of 30. Returns merged result matching normal shape.
   */
  async getOrderHistory(days = 30) {
    const endTime   = Date.now();
    const startTime = endTime - days * 86400000;
    let page = 1;
    let allItems = [];
    while (true) {
      const res = await this.getOrders({
        page,
        size:      30,
        beginTime: String(startTime),
        endTime:   String(endTime),
      });
      const items = res.result?.items || [];
      allItems = allItems.concat(items);
      // Stop when we get fewer than a full page
      if (items.length < 30) break;
      page++;
      // Safety cap: never fetch more than 10 pages (300 orders)
      if (page > 10) break;
    }
    return { ret_code: 0, ret_msg: 'OK', result: { items: allItems } };
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  /**
   * FIX #6: Fetch chat messages.
   * Was: POST /v5/p2p/order/message/list
   * Now: POST /v5/p2p/order/message/listpage
   */
  getChatMessages(orderId, size = 50) {
    return this._post('/v5/p2p/order/message/listpage', {
      orderId,
      size: Number(size),
    });
  }

  /** POST /v5/p2p/order/message/send */
  sendChatMessage(orderId, message, msgType = 'str') {
    return this._post('/v5/p2p/order/message/send', { orderId, message, msgType });
  }

  // ── Market / Public ──────────────────────────────────────────────────────

  /**
   * FIX #2: Browse live P2P market ads.
   * Was: GET /v5/p2p/item/online-ads
   * Now: POST /v5/p2p/item/online
   */
  getMarketAds(params = {}) {
    return this._post('/v5/p2p/item/online', {
      tokenId:    params.tokenId    || 'USDT',
      currencyId: params.currencyId || 'NGN',
      side:       String(params.side || '0'),
      page:       String(params.page || 1),
      size:       String(Math.min(params.size || 10, 20)),
      ...(params.amount      ? { amount:      String(params.amount)      } : {}),
      ...(params.paymentType ? { paymentType: String(params.paymentType) } : {}),
    });
  }

  /**
   * FIX #7: Correct P2P config endpoints.
   * Was: GET /v5/p2p/public/coin/list
   * Now: GET /v5/p2p/config/token/list
   */
  getSupportedTokens() {
    return this._get('/v5/p2p/config/token/list', {});
  }

  /**
   * FIX #7: Correct P2P config endpoints.
   * Was: GET /v5/p2p/public/currency/list
   * Now: GET /v5/p2p/config/currency/list
   */
  getSupportedCurrencies() {
    return this._get('/v5/p2p/config/currency/list', {});
  }
}

module.exports = BybitP2PApi;
