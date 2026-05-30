/**
 * lib/bybit-api.js
 * Bybit P2P REST API v5 — complete client for P2P merchants
 * Updated endpoints to match official Bybit P2P API repo (May 2026)
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

  /** Wallet balance — correct endpoint: /v5/asset/transfer/query-account-coins-balance */
  getAccountBalance() {
    return this._get('/v5/asset/transfer/query-account-coins-balance', {
      accountType: 'FUND',
    });
  }

  /** P2P merchant profile */
  getP2PProfile() {
    return this._post('/v5/p2p/user/personal/info', {});
  }

  /** User's saved payment methods */
  getPaymentMethods() {
    return this._post('/v5/p2p/user/payment/list', {});
  }

  // ── Ads ──────────────────────────────────────────────────────────────────────

  /** List your own ads — fixed: /v5/p2p/item/personal/list */
  getMyAds(params = {}) {
    return this._post('/v5/p2p/item/personal/list', {
      page: params.page || 1,
      size: params.size || 20,
      ...(params.tokenId ? { tokenId: params.tokenId } : {}),
      ...(params.side    ? { side:    params.side    } : {}),
    });
  }

  /** Single ad detail — endpoint unchanged */
  async getAdDetail(itemId) {
    const resp = await this._post('/v5/p2p/item/info', { itemId });
    if (resp.result?.result) resp.result = resp.result.result;
    return resp;
  }

  /** Create a new ad */
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

  /** Update an existing ad */
  updateAd(itemId, params) {
    return this._post('/v5/p2p/item/update', { itemId, ...params });
  }

  /**
   * Toggle ad online/offline
   * NOTE: Bybit no longer has a dedicated toggle-status endpoint.
   * Use updateAd with status field instead.
   */
  toggleAdStatus(itemId, status) {
    return this._post('/v5/p2p/item/update', { itemId, status: String(status) });
  }

  /** Delete / cancel an ad */
  deleteAd(itemId) {
    return this._post('/v5/p2p/item/cancel', { itemId });
  }

  // ── Orders ───────────────────────────────────────────────────────────────────

  /** List orders — fixed: /v5/p2p/order/simplifyList */
  getOrders(params = {}) {
    return this._post('/v5/p2p/order/simplifyList', {
      page:   params.page   || 1,
      size:   params.size   || 20,
      ...(params.status    ? { status:    params.status    } : {}),
      ...(params.beginTime ? { beginTime: params.beginTime } : {}),
      ...(params.endTime   ? { endTime:   params.endTime   } : {}),
    });
  }

  /** Full order detail */
  getOrderDetail(orderId) {
    return this._post('/v5/p2p/order/info', { orderId });
  }

  /** Buyer confirms they have paid */
  confirmPayment(orderId) {
    return this._post('/v5/p2p/order/pay', { orderId });
  }

  /** Seller releases crypto — fixed: /v5/p2p/order/finish */
  releaseAsset(orderId) {
    return this._post('/v5/p2p/order/finish', { orderId });
  }

  /** Cancel an order */
  cancelOrder(orderId, cancelType = '1') {
    return this._post('/v5/p2p/order/cancel', { orderId, cancelType: String(cancelType) });
  }

  /** Open an appeal */
  appealOrder(orderId, appealType, appealNote = '') {
    return this._post('/v5/p2p/order/appeal', { orderId, appealType: String(appealType), appealNote });
  }

  /** Order history — reuses fixed getOrders */
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

  /** Fetch chat messages — fixed: /v5/p2p/order/message/listpage */
  getChatMessages(orderId, size = 50) {
    return this._post('/v5/p2p/order/message/listpage', {
      orderId,
      size: Number(size),
    });
  }

  /** Send a chat message */
  sendChatMessage(orderId, message, msgType = 'str') {
    return this._post('/v5/p2p/order/message/send', { orderId, message, msgType });
  }

  // ── Market / Public ──────────────────────────────────────────────────────────

  /** Browse live P2P market ads — fixed: POST /v5/p2p/item/online */
  getMarketAds(params = {}) {
    return this._post('/v5/p2p/item/online', {
      tokenId:    params.tokenId    || 'USDT',
      currencyId: params.currencyId || 'NGN',
      side:       params.side       || '0',
      size:       String(params.size  || 10),
      page:       String(params.page  || 1),
      ...(params.amount      ? { amount:      params.amount      } : {}),
      ...(params.paymentType ? { paymentType: params.paymentType } : {}),
    });
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
