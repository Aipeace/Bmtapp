/**
 * lib/bybit-api.js
 * Bybit P2P REST API v5 — complete client for P2P merchants
 */

'use strict';

const crypto = require('crypto');

class BybitP2PApi {
  /**
   * @param {string} apiKey
   * @param {string} apiSecret
   * @param {boolean} testnet
   */
  constructor(apiKey, apiSecret, testnet = false) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.baseUrl    = testnet
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com';
    this.recvWindow = '5000';
  }

  // ── Auth helpers ─────────────────────────────────────────────────────────────

  _buildHeaders(payload) {
    const ts   = Date.now().toString();
    const pre  = `${ts}${this.apiKey}${this.recvWindow}${payload}`;
    const sign = crypto
      .createHmac('sha256', this.apiSecret)
      .update(pre)
      .digest('hex');
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

  // ── Account ──────────────────────────────────────────────────────────────────

  /** Wallet balance for FUND account (shows USDT, BTC, etc.) */
  getAccountBalance() {
    return this._get('/v5/account/wallet-balance', { accountType: 'FUND' });
  }

  /** P2P merchant profile: rating, order count, completion rate */
  getP2PProfile() {
    return this._post('/v5/p2p/user/personal/info', {});
  }

  /** User's saved payment methods (bank, e-wallet, etc.) */
  getPaymentMethods() {
    return this._post('/v5/p2p/user/payment/list', {});
  }

  // ── Ads ──────────────────────────────────────────────────────────────────────

  /**
   * List your own ads
   * @param {{ page?:number, size?:number, tokenId?:string, side?:string }} params
   */
  getMyAds(params = {}) {
    return this._post('/v5/p2p/item/list', {
      page: params.page  || 1,
      size: params.size  || 20,
      ...(params.tokenId ? { tokenId: params.tokenId } : {}),
      ...(params.side    ? { side:    params.side    } : {}),
    });
  }

  /** Single ad detail by ID */
  getAdDetail(itemId) {
    return this._post('/v5/p2p/item/info', { itemId });
  }

  /**
   * Create a new ad
   * Required fields: side, tokenId, currencyId, priceType,
   *                  price (fixed) or premium (float), quantity,
   *                  minAmount, maxAmount, paymentIds[]
   */
  createAd(params) {
    const required = ['side','tokenId','currencyId','priceType','quantity','minAmount','maxAmount'];
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

  /** Update an existing ad (price, quantity, min/max, remark) */
  updateAd(itemId, params) {
    return this._post('/v5/p2p/item/update', { itemId, ...params });
  }

  /**
   * Toggle ad online/offline
   * @param {string} itemId
   * @param {'1'|'2'} status  1=online 2=offline
   */
  toggleAdStatus(itemId, status) {
    return this._post('/v5/p2p/item/update-status', { itemId, status: String(status) });
  }

  /** Delete / cancel an ad */
  deleteAd(itemId) {
    return this._post('/v5/p2p/item/cancel', { itemId });
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  /**
   * List orders with optional status filter
   * status: '' all | '5' in-progress | '10' waiting-payment |
   *         '20' paid | '30' completed | '40' cancelled | '50' appeal
   */
  getOrders(params = {}) {
    return this._post('/v5/p2p/order/list', {
      page:   params.page   || 1,
      size:   params.size   || 20,
      status: params.status || '',
      ...(params.beginTime ? { beginTime: params.beginTime } : {}),
      ...(params.endTime   ? { endTime:   params.endTime   } : {}),
    });
  }

  /** Full order detail (includes counterparty info, payment proof, etc.) */
  getOrderDetail(orderId) {
    return this._post('/v5/p2p/order/info', { orderId });
  }

  /** Buyer confirms they have paid */
  confirmPayment(orderId) {
    return this._post('/v5/p2p/order/pay', { orderId });
  }

  /** Seller releases crypto after verifying payment */
  releaseAsset(orderId) {
    return this._post('/v5/p2p/order/release-digital-asset', { orderId });
  }

  /**
   * Cancel an order
   * @param {'1'|'2'|'3'} cancelType  1=normal 2=expired 3=buyer-no-pay
   */
  cancelOrder(orderId, cancelType = '1') {
    return this._post('/v5/p2p/order/cancel', { orderId, cancelType: String(cancelType) });
  }

  /**
   * Open an appeal
   * @param {'1'|'2'} appealType  1=buyer appeal 2=seller appeal
   */
  appealOrder(orderId, appealType, appealNote = '') {
    return this._post('/v5/p2p/order/appeal', { orderId, appealType: String(appealType), appealNote });
  }

  /**
   * Order history for analytics
   * @param {number} days  lookback window in days
   */
  getOrderHistory(days = 30) {
    const endTime   = Date.now();
    const startTime = endTime - days * 86400000;
    return this.getOrders({
      page:      1,
      size:      100,
      beginTime: String(startTime),
      endTime:   String(endTime),
    });
  }

  // ── Chat ─────────────────────────────────────────────────────────────────────

  /** Fetch chat messages for an order (newest last) */
  getChatMessages(orderId, size = 50) {
    return this._post('/v5/p2p/order/message/list', {
      orderId,
      size: Number(size),
    });
  }

  /**
   * Send a chat message
   * @param {'str'|'pic'} msgType
   */
  sendChatMessage(orderId, message, msgType = 'str') {
    return this._post('/v5/p2p/order/message/send', { orderId, message, msgType });
  }

  // ── Market / Public ──────────────────────────────────────────────────────────

  /**
   * Browse live P2P market ads (public, no auth needed but signed anyway)
   * FIX: was building `qs` but passing raw `params` object to _get instead of the params object
   * @param {{ tokenId, currencyId, side, size, page, amount, paymentType }} params
   */
  getMarketAds(params = {}) {
    const queryParams = {
      tokenId:    params.tokenId    || 'USDT',
      currencyId: params.currencyId || 'NGN',
      side:       params.side       || '0',
      size:       params.size       || 10,
      page:       params.page       || 1,
      ...(params.amount      ? { amount:      params.amount      } : {}),
      ...(params.paymentType ? { paymentType: params.paymentType } : {}),
    };
    return this._get('/v5/p2p/item/online-ads', queryParams);
  }

  /** All tokens supported for P2P trading */
  getSupportedTokens() {
    return this._get('/v5/p2p/public/coin/list', {});
  }

  /** All fiat currencies supported for P2P trading */
  getSupportedCurrencies() {
    return this._get('/v5/p2p/public/currency/list', {});
  }
}

module.exports = BybitP2PApi;
