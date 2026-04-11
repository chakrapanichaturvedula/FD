/* pd-firebase.js — Price Discovery Game · Firebase Firestore backend
   Replaces all JSONP / Apps Script polling with real-time onSnapshot listeners.
   Matching engine runs in Cloud Functions; this file handles:
     - Real-time state subscription
     - placeOrder / cancelOrder HTTP calls to Cloud Functions
     - Instructor controls (createGame, openRound, closeRound, nextRound, endGame)
*/

'use strict';

const PD = (() => {
  let _db = null;
  let _functions = null;
  let _unsubGame = null;
  let _unsubOrders = null;
  let _unsubTrades = null;
  let _currentGameId = null;
  let _onState = null;   // callback(stateObj)

  const FUNC_BASE = 'https://us-central1-fia401-price-discovery.cloudfunctions.net';

  function db() {
    if (!_db) _db = firebase.firestore();
    return _db;
  }

  /* ── INIT ────────────────────────────────────── */
  function init(onStateCb) {
    _onState = onStateCb;
    // Listen to the most recent active game
    db().collection('games')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .onSnapshot(snap => {
        if (snap.empty) { _onState({ status: 'no_game' }); return; }
        const doc = snap.docs[0];
        _currentGameId = doc.id;
        _subscribeToGame(doc.id, doc.data());
      }, err => console.warn('PD games listener:', err));
  }

  function _subscribeToGame(gameId, gameData) {
    // Unsubscribe previous listeners
    if (_unsubOrders) _unsubOrders();
    if (_unsubTrades) _unsubTrades();

    let _orders = [];
    let _trades = [];
    let _game = gameData;

    function _emit() {
      if (!_game) return;
      const r = _game.currentRound || 1;
      const roundOrders = _orders.filter(o => o.round === r);
      const roundTrades = _trades.filter(t => t.round === r);

      // Build open order book
      const openBids = [], openAsks = [];
      roundOrders.forEach(o => {
        if (o.status !== 'open' && o.status !== 'partial') return;
        const rem = (o.qty || 0) - (o.filledQty || 0);
        if (rem <= 0) return;
        const entry = { orderId: o.id, price: o.price, qty: rem,
          instrument: o.instrument, strike: o.strike || 0,
          expiry: o.expiry || '', timestamp: o.timestamp };
        if (o.side === 'buy') openBids.push(entry);
        else openAsks.push(entry);
      });
      openBids.sort((a,b) => b.price !== a.price ? b.price - a.price : a.timestamp - b.timestamp);
      openAsks.sort((a,b) => a.price !== b.price ? a.price - b.price : a.timestamp - b.timestamp);

      // Trades newest first
      const sortedTrades = [...roundTrades].sort((a,b) => b.timestamp - a.timestamp);

      _onState({
        gameId: gameId,
        assetName: _game.assetName || 'Asset',
        assetSymbol: _game.assetSymbol || '',
        spotPrice: _game.spotPrice || 0,
        numRounds: _game.numRounds || 3,
        currentRound: r,
        roundCue: _game.roundCue || '',
        status: _game.status || 'waiting',
        lotSize: _game.lotSize || 1,
        discoveryPrices: _game.discoveryPrices || [],
        orderBook: {
          bids: openBids.slice(0, 10),
          asks: openAsks.slice(0, 10)
        },
        trades: sortedTrades.slice(0, 30).map(t => ({
          price: t.price, qty: t.qty,
          instrument: t.instrument, strike: t.strike || 0,
          expiry: t.expiry || '', timestamp: t.timestamp
        })),
        allOrders: roundOrders
      });
    }

    // Live game doc
    db().collection('games').doc(gameId).onSnapshot(snap => {
      if (!snap.exists) return;
      _game = snap.data();
      _emit();
    });

    // Live orders for this game
    _unsubOrders = db().collection('orders')
      .where('gameId', '==', gameId)
      .onSnapshot(snap => {
        _orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _emit();
      }, err => console.warn('PD orders listener:', err));

    // Live trades for this game
    _unsubTrades = db().collection('trades')
      .where('gameId', '==', gameId)
      .onSnapshot(snap => {
        _trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _emit();
      }, err => console.warn('PD trades listener:', err));
  }

  /* ── STUDENT ACTIONS ─────────────────────────── */
  async function placeOrder(params) {
    const res = await fetch(FUNC_BASE + '/placeOrder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    return res.json();
  }

  async function cancelOrder(orderId, studentId) {
    const res = await fetch(FUNC_BASE + '/cancelOrder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, studentId })
    });
    return res.json();
  }

  /* ── INSTRUCTOR ACTIONS ──────────────────────── */
  async function _instCall(action, params = {}) {
    const res = await fetch(FUNC_BASE + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, secret: 'IMTFD26_INSTRUCTOR' })
    });
    return res.json();
  }

  const createGame  = (p) => _instCall('createGame', p);
  const openRound   = (p) => _instCall('openRound',  { gameId: _currentGameId, ...p });
  const closeRound  = ()  => _instCall('closeRound', { gameId: _currentGameId });
  const nextRound   = (p) => _instCall('nextRound',  { gameId: _currentGameId, ...p });
  const endGame     = ()  => _instCall('endGame',    { gameId: _currentGameId });

  function getGameId() { return _currentGameId; }

  return { init, placeOrder, cancelOrder, createGame, openRound, closeRound, nextRound, endGame, getGameId };
})();
