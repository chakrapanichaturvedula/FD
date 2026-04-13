/* pd-firebase.js — Price Discovery Game · Shared Firebase Engine v3
   Fixes: marketData path, createGame initialises marketData/current,
          openRound initialises marketData/current, full error messages surfaced
*/
'use strict';

const PD = (() => {
  let _db = null;
  let _unsub = null;
  let _gameId = null;
  let _onState = null;

  function db() {
    if (!_db) _db = firebase.firestore();
    return _db;
  }

  /* ── INIT: subscribe to most recent game ── */
  function init(onStateCb) {
    _onState = onStateCb;
    if (_unsub) { _unsub(); _unsub = null; }

    db().collection('games')
      .orderBy('createdAt', 'desc')
      .limit(1)
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

    // All paths verified: even segments for .doc(), odd for .collection()
    const gameRef    = db().doc(`games/${gameId}`);
    const ordersRef  = db().collection(`games/${gameId}/orders`)
                          .where('status', 'in', ['open','partial']);
    const tradesRef  = db().collection(`games/${gameId}/trades`)
                          .orderBy('executedAt','desc').limit(50);
    const studRef    = db().collection(`games/${gameId}/students`);
    const annsRef    = db().collection(`games/${gameId}/announcements`)
                          .orderBy('createdAt','desc').limit(5);
    const mktRef     = db().doc(`games/${gameId}/marketData/current`); // 4 segs ✓

    let state = {};
    function emit() { if (_onState) _onState({ ...state, gameId }); }

    const u1 = gameRef.onSnapshot(doc => {
      if (!doc.exists) { _onState({ status: 'no_game' }); return; }
      const { fundamentalValue, ...safe } = doc.data(); // strip hidden field
      state = { ...state, ...safe };
      emit();
    }, err => console.error('game listener:', err));

    const u2 = ordersRef.onSnapshot(snap => {
      const bids = [], asks = [];
      snap.forEach(d => {
        const o = { id: d.id, ...d.data() };
        (o.side === 'buy' ? bids : asks).push(o);
      });
      state.orderBook = { bids, asks };
      emit();
    }, err => console.error('orders listener:', err));

    const u3 = tradesRef.onSnapshot(snap => {
      state.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    }, err => console.error('trades listener:', err));

    const u4 = studRef.onSnapshot(snap => {
      state.students = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    }, err => console.error('students listener:', err));

    const u5 = annsRef.onSnapshot(snap => {
      state.announcements = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    }, err => console.error('announcements listener:', err));

    const u6 = mktRef.onSnapshot(doc => {
      state.marketData = doc.exists ? doc.data() : {};
      emit();
    }, err => console.error('marketData listener:', err));

    _unsub = () => [u1,u2,u3,u4,u5,u6].forEach(u => u && u());
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
          role: 'speculator', privateValue: null,
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
        status: 'cancel_requested',
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

      // Step 1: create the game document
      await ref.set({
        gameCode: code,
        assetName: params.assetName || 'Nifty Index',
        assetSymbol: params.assetSymbol || 'NIFTY',
        spotPrice: params.spotPrice || 0,
        lotSize: params.lotSize || 50,
        numRounds: params.numRounds || 3,
        currentRound: 0,
        positionLimit: params.positionLimit || 10,
        defaultCapital: params.defaultCapital || 500000,
        status: 'waiting',
        roundCue: params.roundCue || '',
        instrument: params.instrument || 'spot',          // 'spot' | 'futures'
        futuresExpiry: params.futuresExpiry || null,       // 'near' | 'next' | 'far'
        expiryLabel: params.expiryLabel || '',             // e.g. '27-Jun-2026'
        optionsEnabled: params.optionsEnabled || false,
        optionsStrike: params.optionsStrike || null,
        optionsExpiry: params.optionsExpiry || null,
        openInterest: 0,
        settlementPrice: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Step 2: initialise marketData/current subcollection document
      // Path: games/{gameId}/marketData/current — 4 segments ✓
      await db().doc(`games/${gameId}/marketData/current`).set({
        ltp: params.spotPrice || 0,
        open: 0, high: 0, low: 0, atp: 0,
        volume: 0, openInterest: 0,
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

  /* ── INSTRUCTOR: open round ── */
  async function openRound() {
    if (!_gameId) return { error: 'No game — create a game first' };
    try {
      const snap = await db().doc(`games/${_gameId}`).get();
      if (!snap.exists) return { error: 'Game not found' };
      const d = snap.data();
      const nextRound = d.currentRound === 0 ? 1 : d.currentRound;
      const duration = d.roundDuration || 420;

      await db().doc(`games/${_gameId}`).update({
        status: 'open',
        currentRound: nextRound,
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endsAt: new Date(Date.now() + duration * 1000)
      });

      // Reset market data for the new round
      await db().doc(`games/${_gameId}/marketData/current`).set({
        ltp: d.spotPrice || 0,
        open: 0, high: 0, low: 0, atp: 0,
        volume: 0, openInterest: 0,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: close round ── */
  async function closeRound() {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({ status: 'closed' });
      // Cancel all remaining open orders
      const openOrders = await db().collection(`games/${_gameId}/orders`)
        .where('status', 'in', ['open','partial']).get();
      if (!openOrders.empty) {
        const batch = db().batch();
        openOrders.forEach(doc => batch.update(doc.ref, {
          status: 'cancelled', remainingQty: 0,
          cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }));
        await batch.commit();
      }
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: pause round ── */
  async function pauseRound() {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({ status: 'paused' });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: next round ── */
  async function nextRound({ roundCue }) {
    if (!_gameId) return { error: 'No game' };
    try {
      const snap = await db().doc(`games/${_gameId}`).get();
      const d = snap.data();
      const next = (d.currentRound || 0) + 1;
      if (next > (d.numRounds || 3)) return { error: 'All rounds complete — end the game' };
      await db().doc(`games/${_gameId}`).update({
        status: 'open',
        currentRound: next,
        roundCue: roundCue || '',
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endsAt: new Date(Date.now() + (d.roundDuration || 420) * 1000)
      });
      // Reset market data for new round
      await db().doc(`games/${_gameId}/marketData/current`).set({
        ltp: d.spotPrice || 0,
        open: 0, high: 0, low: 0, atp: 0, volume: 0,
        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: settle round ── */
  async function settleRound({ settlementPrice }) {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({
        status: 'settled', settlementPrice
      });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: end game ── */
  async function endGame() {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({ status: 'ended' });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: adjust capital ── */
  async function adjustCapital(studentId, newCapital, note) {
    if (!_gameId) return { error: 'No game' };
    if (!newCapital || newCapital < 1000) return { error: 'Minimum capital is ₹1,000' };
    try {
      const sRef = db().doc(`games/${_gameId}/students/${studentId}`);
      const snap = await sRef.get();
      if (!snap.exists) return { error: 'Student not found' };
      const prev = snap.data().capitalRemaining || 0;
      const batch = db().batch();
      batch.update(sRef, {
        capitalRemaining: newCapital,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      const logRef = db().collection(`games/${_gameId}/capitalLog`).doc();
      batch.set(logRef, {
        studentId, studentName: snap.data().name || studentId,
        previousCapital: prev, newCapital, delta: newCapital - prev,
        instructorNote: note || '',
        adjustedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      if (note) {
        const annRef = db().collection(`games/${_gameId}/announcements`).doc();
        batch.set(annRef, {
          message: `Capital updated to ₹${newCapital.toLocaleString('en-IN')}. ${note}`,
          type: 'capital_update', targetStudentId: studentId,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 10000)
        });
      }
      await batch.commit();
      return { ok: true, previous: prev, newCapital };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: options toggle ── */
  async function setOptions(enabled, strike, expiry) {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({
        optionsEnabled: enabled,
        optionsStrike: strike || null,
        optionsExpiry: expiry || null
      });
      return { ok: true };
    } catch(e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: announce ── */
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

  /* ── HELPERS ── */
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
    getGameId: () => _gameId
  };
})();
