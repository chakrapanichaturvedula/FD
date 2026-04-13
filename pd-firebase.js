/* pd-firebase.js — Price Discovery Game · Firebase Engine v4
   Matching engine runs CLIENT-SIDE in the instructor's browser.
   No Cloud Functions required. Works on Firebase Spark (free) plan.
*/
'use strict';

const PD = (() => {
  let _db = null;
  let _unsub = null;
  let _matchUnsub = null;   // matching engine listener (instructor only)
  let _gameId = null;
  let _onState = null;
  let _matching = false;    // is matching engine active?

  function db() {
    if (!_db) _db = firebase.firestore();
    return _db;
  }

  /* ── INIT: subscribe to most recent game ── */
  function init(onStateCb) {
    _onState = onStateCb;
    if (_unsub) { _unsub(); _unsub = null; }

    db().collection('games')
      .orderBy('createdAt', 'desc').limit(1)
      .onSnapshot(snap => {
        if (snap.empty) { _onState({ status: 'no_game' }); return; }
        const doc = snap.docs[0];
        _gameId = doc.id;
        _subscribeGame(_gameId);
      }, err => {
        console.error('PD.init:', err);
        _onState({ status: 'no_game' });
      });
  }

  function _subscribeGame(gameId) {
    if (_unsub) { _unsub(); _unsub = null; }

    const gameRef   = db().doc(`games/${gameId}`);
    const ordersRef = db().collection(`games/${gameId}/orders`)
                         .where('status', 'in', ['open','partial']);
    const tradesRef = db().collection(`games/${gameId}/trades`)
                         .orderBy('executedAt','desc').limit(100);
    const studRef   = db().collection(`games/${gameId}/students`);
    const annsRef   = db().collection(`games/${gameId}/announcements`)
                         .orderBy('createdAt','desc').limit(5);
    const mktRef    = db().doc(`games/${gameId}/marketData/current`);

    let state = {};
    function emit() { if (_onState) _onState({ ...state, gameId }); }

    const u1 = gameRef.onSnapshot(doc => {
      if (!doc.exists) { _onState({ status: 'no_game' }); return; }
      const { fundamentalValue, ...safe } = doc.data();
      state = { ...state, ...safe };
      emit();
    });
    const u2 = ordersRef.onSnapshot(snap => {
      const bids = [], asks = [];
      snap.forEach(d => {
        const o = { id: d.id, ...d.data() };
        (o.side === 'buy' ? bids : asks).push(o);
      });
      state.orderBook = { bids, asks };
      emit();
    });
    const u3 = tradesRef.onSnapshot(snap => {
      state.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    });
    const u4 = studRef.onSnapshot(snap => {
      state.students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    });
    const u5 = annsRef.onSnapshot(snap => {
      state.announcements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    });
    const u6 = mktRef.onSnapshot(doc => {
      state.marketData = doc.exists ? doc.data() : {};
      emit();
    });

    _unsub = () => [u1,u2,u3,u4,u5,u6].forEach(u => u && u());
  }

  /* ════════════════════════════════════════════════════════
     CLIENT-SIDE MATCHING ENGINE
     Call startMatching() from the instructor page after
     opening a round. Call stopMatching() when round closes.
     ════════════════════════════════════════════════════════ */

  function startMatching() {
    if (_matching || !_gameId) return;
    _matching = true;
    console.log('[PD Matching] Engine started for game', _gameId);

    // Watch ALL orders (including newly placed ones)
    const allOrdersRef = db().collection(`games/${_gameId}/orders`)
      .where('status', 'in', ['open', 'partial']);

    if (_matchUnsub) _matchUnsub();
    _matchUnsub = allOrdersRef.onSnapshot(async snap => {
      if (!_matching) return;
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      await _runMatchingCycle(orders);
    });
  }

  function stopMatching() {
    _matching = false;
    if (_matchUnsub) { _matchUnsub(); _matchUnsub = null; }
    console.log('[PD Matching] Engine stopped');
  }

  async function _runMatchingCycle(orders) {
    // Get bids sorted best first (highest price, then earliest time)
    const bids = orders
      .filter(o => o.side === 'buy')
      .sort((a, b) => {
        const aPx = a.type === 'market' ? Infinity : (a.price || 0);
        const bPx = b.type === 'market' ? Infinity : (b.price || 0);
        if (bPx !== aPx) return bPx - aPx;
        return _ts(a.placedAt) - _ts(b.placedAt);
      });

    // Get asks sorted best first (lowest price, then earliest time)
    const asks = orders
      .filter(o => o.side === 'sell')
      .sort((a, b) => {
        const aPx = a.type === 'market' ? -Infinity : (a.price || Infinity);
        const bPx = b.type === 'market' ? -Infinity : (b.price || Infinity);
        if (aPx !== bPx) return aPx - bPx;
        return _ts(a.placedAt) - _ts(b.placedAt);
      });

    if (!bids.length || !asks.length) return;

    const bestBid = bids[0];
    const bestAsk = asks[0];

    const bidPx = bestBid.type === 'market' ? Infinity  : (bestBid.price || 0);
    const askPx = bestAsk.type === 'market' ? -Infinity : (bestAsk.price || Infinity);

    // No match possible
    if (bidPx < askPx) return;

    // Trade price = resting order's price
    // If both are market orders, use last traded price or reference price
    let tradePrice;
    if (bestBid.type === 'market' && bestAsk.type === 'market') {
      const mktSnap = await db().doc(`games/${_gameId}/marketData/current`).get();
      const mkt = mktSnap.exists ? mktSnap.data() : {};
      const gameSnap = await db().doc(`games/${_gameId}`).get();
      tradePrice = mkt.ltp || gameSnap.data().spotPrice || 0;
    } else if (bestBid.type === 'market') {
      tradePrice = bestAsk.price; // buy market takes ask price
    } else if (bestAsk.type === 'market') {
      tradePrice = bestBid.price; // sell market takes bid price
    } else {
      // Both limit: resting order (whichever was placed first) sets price
      tradePrice = _ts(bestBid.placedAt) < _ts(bestAsk.placedAt)
        ? bestBid.price   // bid was resting, ask came in
        : bestAsk.price;  // ask was resting, bid came in
    }

    const matchQty = Math.min(
      bestBid.remainingQty || bestBid.originalQty || 0,
      bestAsk.remainingQty || bestAsk.originalQty || 0
    );
    if (matchQty <= 0) return;

    await _executeTrade(bestBid, bestAsk, tradePrice, matchQty);
  }

  async function _executeTrade(bid, ask, price, qty) {
    console.log(`[PD Matching] Trade: ${qty} @ ₹${price} | Buyer: ${bid.traderId} Seller: ${ask.traderId}`);

    const batch = db().batch();
    const ts = firebase.firestore.FieldValue.serverTimestamp();

    // 1. Update bid order
    const newBidRem = (bid.remainingQty || bid.originalQty || 0) - qty;
    batch.update(db().doc(`games/${_gameId}/orders/${bid.id}`), {
      remainingQty: newBidRem,
      status: newBidRem <= 0 ? 'filled' : 'partial',
      updatedAt: ts
    });

    // 2. Update ask order
    const newAskRem = (ask.remainingQty || ask.originalQty || 0) - qty;
    batch.update(db().doc(`games/${_gameId}/orders/${ask.id}`), {
      remainingQty: newAskRem,
      status: newAskRem <= 0 ? 'filled' : 'partial',
      updatedAt: ts
    });

    // 3. Create trade record
    const tradeRef = db().collection(`games/${_gameId}/trades`).doc();
    batch.set(tradeRef, {
      buyOrderId:  bid.id,
      sellOrderId: ask.id,
      buyTraderId:  bid.traderId,
      sellTraderId: ask.traderId,
      price,
      qty,
      instrument: bid.instrument || 'spot',
      executedAt: ts
    });

    await batch.commit();

    // 4. Update market data and positions (after batch)
    await Promise.all([
      _updateMarketData(price, qty),
      _updatePosition(bid.traderId,  'buy',  qty, price),
      _updatePosition(ask.traderId, 'sell', qty, price)
    ]);
  }

  async function _updateMarketData(price, qty) {
    const mktRef = db().doc(`games/${_gameId}/marketData/current`);
    const snap = await mktRef.get();
    const mkt = snap.exists ? snap.data() : {};
    const newVol = (mkt.volume || 0) + qty;
    const newAtp = ((mkt.atp || price) * (mkt.volume || 0) + price * qty) / newVol;
    await mktRef.set({
      ltp: price,
      open: mkt.open || price,
      high: Math.max(mkt.high || 0, price),
      low:  mkt.low ? Math.min(mkt.low, price) : price,
      atp:  Math.round(newAtp),
      volume: newVol,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  async function _updatePosition(traderId, side, qty, price) {
    const ref = db().doc(`games/${_gameId}/students/${traderId}`);
    const snap = await ref.get();
    if (!snap.exists) return;
    const s = snap.data();

    const prevPos = s.netPosition || 0;
    const delta   = side === 'buy' ? qty : -qty;
    const newPos  = prevPos + delta;

    // Average price calc
    let avgPrice = s.averagePrice || 0;
    if (side === 'buy') {
      if (prevPos >= 0) {
        // Adding to long or opening long
        avgPrice = prevPos === 0 ? price
          : ((avgPrice * prevPos) + (price * qty)) / newPos;
      }
      // else closing short — realised P&L handled below
    } else {
      if (prevPos <= 0) {
        // Adding to short or opening short
        const absPrev = Math.abs(prevPos);
        avgPrice = prevPos === 0 ? price
          : ((avgPrice * absPrev) + (price * qty)) / Math.abs(newPos);
      }
    }

    // Realised P&L
    let realisedDelta = 0;
    if (side === 'buy' && prevPos < 0) {
      // Closing a short
      const closeQty = Math.min(qty, Math.abs(prevPos));
      realisedDelta = (avgPrice - price) * closeQty;
    } else if (side === 'sell' && prevPos > 0) {
      // Closing a long
      const closeQty = Math.min(qty, prevPos);
      realisedDelta = (price - avgPrice) * closeQty;
    }

    // Unrealised P&L (approximation using LTP = price of this trade)
    const mktSnap = await db().doc(`games/${_gameId}/marketData/current`).get();
    const ltp = mktSnap.exists ? (mktSnap.data().ltp || price) : price;
    const unrealised = newPos !== 0 ? (ltp - (avgPrice||price)) * newPos : 0;

    await ref.update({
      netPosition:      newPos,
      averagePrice:     Math.abs(newPos) > 0 ? avgPrice : 0,
      realisedPnl:      (s.realisedPnl || 0) + realisedDelta,
      unrealisedPnl:    unrealised,
      updatedAt:        firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  /* helper: normalise Firestore timestamp to ms */
  function _ts(t) {
    if (!t) return 0;
    if (t.seconds) return t.seconds * 1000;
    if (t instanceof Date) return t.getTime();
    return Number(t) || 0;
  }

  /* ── STUDENT: join game ── */
  async function joinGame({ gameCode, name, rollNo }) {
    try {
      const snap = await db().collection('games')
        .where('gameCode', '==', gameCode.toUpperCase()).limit(1).get();
      if (snap.empty) return { error: 'Game code not found — check the code on the projector' };
      const gameDoc = snap.docs[0];
      _gameId = gameDoc.id;
      const game = gameDoc.data();
      if (game.status === 'ended') return { error: 'This game has ended' };

      const studentId = (rollNo || name.replace(/\s+/g,'_').toLowerCase())
                        + '_' + Date.now().toString(36);
      const sRef = db().doc(`games/${_gameId}/students/${studentId}`);
      const existing = await sRef.get();
      if (!existing.exists) {
        await sRef.set({
          name, rollNo: rollNo || '',
          capitalRemaining: game.defaultCapital || 500000,
          netPosition: 0, averagePrice: 0,
          realisedPnl: 0, unrealisedPnl: 0,
          joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
          isConnected: true
        });
      } else {
        await sRef.update({ isConnected: true });
      }
      _subscribeGame(_gameId);
      return { ok: true, studentId, gameId: _gameId, game };
    } catch(e) { return { error: e.message }; }
  }

  /* ── STUDENT: place order ── */
  async function placeOrder({ studentId, side, type, price, qty, instrument }) {
    if (!_gameId) return { error: 'No active game' };
    try {
      const ref = db().collection(`games/${_gameId}/orders`).doc();
      await ref.set({
        traderId: studentId,
        side,
        type,
        price: type === 'market' ? 0 : price,
        instrument: instrument || 'spot',
        originalQty: qty,
        remainingQty: qty,
        status: 'open',
        placedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        cancelledAt: null
      });
      return { ok: true, orderId: ref.id };
    } catch(e) { return { error: e.message }; }
  }

  /* ── STUDENT: cancel order ── */
  async function cancelOrder(orderId) {
    if (!_gameId) return { error: 'No active game' };
    try {
      await db().doc(`games/${_gameId}/orders/${orderId}`).update({
        status: 'cancelled',
        remainingQty: 0,
        cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: create game ── */
  async function createGame(params) {
    try {
      const code = _genCode();
      const ref = db().collection('games').doc();
      const gameId = ref.id;

      await ref.set({
        gameCode: code,
        assetName:     params.assetName || 'Nifty Index',
        assetSymbol:   params.assetSymbol || 'NIFTY',
        spotPrice:     params.spotPrice || 0,
        lotSize:       params.lotSize || 1,
        numRounds:     params.numRounds || 3,
        currentRound:  0,
        positionLimit: params.positionLimit || 10,
        defaultCapital:params.defaultCapital || 500000,
        status:        'waiting',
        roundCue:      params.roundCue || '',
        instrument:    params.instrument || 'spot',
        futuresExpiry: params.futuresExpiry || null,
        expiryLabel:   params.expiryLabel || '',
        optStrike:     params.optStrike || null,
        optType:       params.optType || null,
        openInterest:  0,
        settlementPrice: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Initialise marketData/current
      await db().doc(`games/${gameId}/marketData/current`).set({
        ltp: params.spotPrice || 0,
        open: 0, high: 0, low: 0, atp: 0, volume: 0,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      });

      _gameId = gameId;
      _subscribeGame(_gameId);
      return { ok: true, gameId, gameCode: code };
    } catch(e) {
      console.error('createGame error:', e);
      return { error: e.message };
    }
  }

  /* ── INSTRUCTOR: open round — also starts matching engine ── */
  async function openRound() {
    if (!_gameId) return { error: 'No game' };
    try {
      const snap = await db().doc(`games/${_gameId}`).get();
      const d = snap.data();
      const nextRound = d.currentRound === 0 ? 1 : d.currentRound;

      await db().doc(`games/${_gameId}`).update({
        status: 'open',
        currentRound: nextRound,
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endsAt: new Date(Date.now() + (d.roundDuration || 420) * 1000)
      });

      // Reset market data
      await db().doc(`games/${_gameId}/marketData/current`).set({
        ltp: d.spotPrice || 0,
        open: 0, high: 0, low: 0, atp: 0, volume: 0,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      startMatching();   // ← START ENGINE
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: close round — stops matching engine ── */
  async function closeRound() {
    if (!_gameId) return { error: 'No game' };
    stopMatching();      // ← STOP ENGINE
    try {
      await db().doc(`games/${_gameId}`).update({ status: 'closed' });
      // Cancel all remaining open orders
      const openOrders = await db().collection(`games/${_gameId}/orders`)
        .where('status', 'in', ['open','partial']).get();
      if (!openOrders.empty) {
        const batch = db().batch();
        const ts = firebase.firestore.FieldValue.serverTimestamp();
        openOrders.forEach(doc => batch.update(doc.ref, {
          status: 'cancelled', remainingQty: 0,
          cancelledAt: ts, updatedAt: ts
        }));
        await batch.commit();
      }
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  async function pauseRound() {
    if (!_gameId) return { error: 'No game' };
    stopMatching();
    try { await db().doc(`games/${_gameId}`).update({ status: 'paused' }); return { ok: true }; }
    catch(e) { return { error: e.message }; }
  }

  async function nextRound(params) {
    const { roundCue } = params || {};
    if (!_gameId) return { error: 'No game' };
    stopMatching();
    try {
      const snap = await db().doc(`games/${_gameId}`).get();
      const d = snap.data();
      const next = (d.currentRound || 0) + 1;
      if (next > (d.numRounds || 3)) return { error: 'All rounds complete' };

      await db().doc(`games/${_gameId}`).update({
        status: 'open',
        currentRound: next,
        roundCue: roundCue || '',
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endsAt: new Date(Date.now() + (d.roundDuration || 420) * 1000)
      });

      await db().doc(`games/${_gameId}/marketData/current`).set({
        ltp: d.spotPrice || 0,
        open: 0, high: 0, low: 0, atp: 0, volume: 0,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      startMatching();   // ← restart engine for new round
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  async function settleRound({ settlementPrice }) {
    if (!_gameId) return { error: 'No game' };
    stopMatching();
    try {
      await db().doc(`games/${_gameId}`).update({ status: 'settled', settlementPrice });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  async function endGame() {
    if (!_gameId) return { error: 'No game' };
    stopMatching();
    try { await db().doc(`games/${_gameId}`).update({ status: 'ended' }); return { ok: true }; }
    catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: capital ── */
  async function adjustCapital(studentId, newCapital, note) {
    if (!_gameId) return { error: 'No game' };
    if (!newCapital || newCapital < 1000) return { error: 'Minimum ₹1,000' };
    try {
      const sRef = db().doc(`games/${_gameId}/students/${studentId}`);
      const snap = await sRef.get();
      if (!snap.exists) return { error: 'Student not found' };
      const prev = snap.data().capitalRemaining || 0;
      const batch = db().batch();
      batch.update(sRef, { capitalRemaining: newCapital, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      const logRef = db().collection(`games/${_gameId}/capitalLog`).doc();
      batch.set(logRef, {
        studentId, studentName: snap.data().name || studentId,
        previousCapital: prev, newCapital, delta: newCapital - prev,
        instructorNote: note || '',
        adjustedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  async function setOptions(enabled, strike, expiry) {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({ optionsEnabled: enabled, optionsStrike: strike||null, optionsExpiry: expiry||null });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  async function announce(message) {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().collection(`games/${_gameId}/announcements`).add({
        message, type: 'announcement', targetStudentId: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 8000)
      });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  function _genCode() {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const D = '23456789';
    return L[Math.floor(Math.random()*L.length)]
         + L[Math.floor(Math.random()*L.length)]
         + D[Math.floor(Math.random()*D.length)]
         + D[Math.floor(Math.random()*D.length)];
  }

  return {
    init, joinGame, placeOrder, cancelOrder,
    createGame, openRound, closeRound, pauseRound,
    nextRound, settleRound, endGame,
    adjustCapital, setOptions, announce,
    startMatching, stopMatching,
    getGameId: () => _gameId
  };
})();
