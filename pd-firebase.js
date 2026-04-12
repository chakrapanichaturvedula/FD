/* pd-firebase.js — Price Discovery Game · Shared Firebase Engine
   Version 2 — cancel orders · capital management · options toggle
   Project: fia401-price-discovery
   Used by: price-discovery.html, price-discovery-instructor.html, price-discovery-projector.html
*/
'use strict';

const PD = (() => {
  let _db = null;
  let _unsub = null;
  let _gameId = null;
  let _onState = null;

  const FUNC = 'https://us-central1-fia401-price-discovery.cloudfunctions.net';

  function db() {
    if (!_db) _db = firebase.firestore();
    return _db;
  }

  /* ── INIT ── subscribe to the most recent active game */
  function init(onStateCb) {
    _onState = onStateCb;
    if (_unsub) _unsub();

    db().collection('games')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .onSnapshot(snap => {
        if (snap.empty) { _onState({ status: 'no_game' }); return; }
        const doc = snap.docs[0];
        _gameId = doc.id;
        _subscribeGame(_gameId);
      }, err => {
        console.error('PD.init error:', err);
        _onState({ status: 'no_game' });
      });
  }

  function _subscribeGame(gameId) {
    if (_unsub) _unsub();

    // Listen to the game document
    const gameRef = db().doc(`games/${gameId}`);
    const ordersRef = db().collection(`games/${gameId}/orders`).where('status', 'in', ['open', 'partial']);
    const tradesRef = db().collection(`games/${gameId}/trades`).orderBy('executedAt', 'desc').limit(50);
    const studentsRef = db().collection(`games/${gameId}/students`);
    const annsRef = db().collection(`games/${gameId}/announcements`).orderBy('createdAt', 'desc').limit(5);
    const mktRef = db().doc(`games/${gameId}/marketData/current`);

    let state = {};
    let listeners = [];

    function emit() { if (_onState) _onState({ ...state }); }

    const u1 = gameRef.onSnapshot(doc => {
      if (!doc.exists) { _onState({ status: 'no_game' }); return; }
      const d = doc.data();
      // Never expose fundamentalValue to client-side state
      const { fundamentalValue, ...safe } = d;
      state = { ...state, ...safe, gameId };
      emit();
    });

    const u2 = ordersRef.onSnapshot(snap => {
      const bids = [], asks = [];
      snap.forEach(doc => {
        const o = { id: doc.id, ...doc.data() };
        if (o.side === 'buy') bids.push(o);
        else asks.push(o);
      });
      state.orderBook = { bids, asks };
      emit();
    });

    const u3 = tradesRef.onSnapshot(snap => {
      state.trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      emit();
    });

    const u4 = studentsRef.onSnapshot(snap => {
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

    _unsub = () => { [u1,u2,u3,u4,u5,u6].forEach(u => u && u()); };
  }

  /* ── STUDENT: join game ── */
  async function joinGame({ gameCode, name, rollNo }) {
    try {
      const snap = await db().collection('games')
        .where('gameCode', '==', gameCode.toUpperCase())
        .limit(1).get();
      if (snap.empty) return { error: 'Game code not found' };
      const gameDoc = snap.docs[0];
      _gameId = gameDoc.id;
      const game = gameDoc.data();
      if (game.status === 'ended') return { error: 'This game has ended' };

      const studentId = rollNo || name.replace(/\s+/g, '_').toLowerCase() + '_' + Date.now().toString(36);
      const studentRef = db().doc(`games/${_gameId}/students/${studentId}`);
      const existing = await studentRef.get();

      if (!existing.exists) {
        await studentRef.set({
          name, rollNo: rollNo || '',
          role: 'speculator', privateValue: null,
          capitalRemaining: game.defaultCapital || 500000,
          netPosition: 0, averagePrice: 0,
          realisedPnl: 0, unrealisedPnl: 0,
          joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
          isConnected: true
        });
      } else {
        await studentRef.update({ isConnected: true });
      }

      _subscribeGame(_gameId);
      return { ok: true, studentId, gameId: _gameId, game: gameDoc.data() };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ── STUDENT: place order ── */
  async function placeOrder({ studentId, side, type, price, qty, instrument }) {
    if (!_gameId) return { error: 'No active game' };
    try {
      const ref = db().collection(`games/${_gameId}/orders`).doc();
      await ref.set({
        traderId: studentId,
        side,                         // 'buy' | 'sell'
        type,                         // 'limit' | 'market'
        price: type === 'market' ? 0 : price,
        instrument: instrument || 'spot',
        originalQty: qty,
        remainingQty: qty,
        status: 'open',               // Cloud Function will match and update
        placedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        cancelledAt: null
      });
      return { ok: true, orderId: ref.id };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ── STUDENT: cancel limit order ──
     Student sets status to 'cancel_requested'.
     Cloud Function onOrderCancelRequested handles the actual cancellation.  */
  async function cancelOrder(orderId) {
    if (!_gameId) return { error: 'No active game' };
    try {
      await db().doc(`games/${_gameId}/orders/${orderId}`).update({
        status: 'cancel_requested',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ── INSTRUCTOR: create game ── */
  async function createGame(params) {
    try {
      const code = _genCode();
      const ref = db().collection('games').doc();
      await ref.set({
        gameCode: code,
        assetName: params.assetName,
        assetSymbol: params.assetSymbol || '',
        spotPrice: params.spotPrice || 0,
        lotSize: params.lotSize || 50,
        numRounds: params.numRounds || 3,
        currentRound: 0,
        positionLimit: params.positionLimit || 10,
        defaultCapital: params.defaultCapital || 500000,
        status: 'waiting',
        roundCue: params.roundCue || '',
        optionsEnabled: params.optionsEnabled || false,
        optionsStrike: params.optionsStrike || null,
        optionsExpiry: params.optionsExpiry || null,
        openInterest: 0,
        settlementPrice: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      _gameId = ref.id;
      _subscribeGame(_gameId);
      return { ok: true, gameId: ref.id, gameCode: code };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ── INSTRUCTOR: round controls ── */
  async function openRound() {
    if (!_gameId) return { error: 'No game' };
    try {
      const snap = await db().doc(`games/${_gameId}`).get();
      const d = snap.data();
      const nextRound = (d.currentRound || 0) === 0 ? 1 : d.currentRound;
      const duration = d.roundDuration || 420; // 7 minutes default
      await db().doc(`games/${_gameId}`).update({
        status: 'open',
        currentRound: nextRound,
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endsAt: new Date(Date.now() + duration * 1000)
      });
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  async function closeRound() {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({ status: 'closed' });
      // Cancel all open orders
      const openOrders = await db().collection(`games/${_gameId}/orders`)
        .where('status', 'in', ['open', 'partial']).get();
      const batch = db().batch();
      openOrders.forEach(doc => {
        batch.update(doc.ref, {
          status: 'cancelled',
          remainingQty: 0,
          cancelledAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  async function pauseRound() {
    if (!_gameId) return { error: 'No game' };
    try { await db().doc(`games/${_gameId}`).update({ status: 'paused' }); return { ok: true }; }
    catch (e) { return { error: e.message }; }
  }

  async function nextRound({ roundCue }) {
    if (!_gameId) return { error: 'No game' };
    try {
      const snap = await db().doc(`games/${_gameId}`).get();
      const d = snap.data();
      const next = (d.currentRound || 0) + 1;
      if (next > (d.numRounds || 3)) return { error: 'All rounds complete' };
      const duration = d.roundDuration || 420;
      await db().doc(`games/${_gameId}`).update({
        status: 'open',
        currentRound: next,
        roundCue: roundCue || '',
        startedAt: firebase.firestore.FieldValue.serverTimestamp(),
        endsAt: new Date(Date.now() + duration * 1000)
      });
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  async function settleRound({ settlementPrice }) {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().doc(`games/${_gameId}`).update({
        status: 'settled',
        settlementPrice
      });
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  async function endGame() {
    if (!_gameId) return { error: 'No game' };
    try { await db().doc(`games/${_gameId}`).update({ status: 'ended' }); return { ok: true }; }
    catch (e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: capital management ── */
  async function adjustCapital(studentId, newCapital, note) {
    if (!_gameId) return { error: 'No game' };
    if (!newCapital || newCapital < 1000) return { error: 'Minimum capital is ₹1,000' };
    try {
      const studentRef = db().doc(`games/${_gameId}/students/${studentId}`);
      const snap = await studentRef.get();
      if (!snap.exists) return { error: 'Student not found' };
      const prev = snap.data().capitalRemaining || 0;

      const batch = db().batch();
      batch.update(studentRef, {
        capitalRemaining: newCapital,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Audit log
      const logRef = db().collection(`games/${_gameId}/capitalLog`).doc();
      batch.set(logRef, {
        studentId,
        studentName: snap.data().name || studentId,
        previousCapital: prev,
        newCapital,
        delta: newCapital - prev,
        instructorNote: note || '',
        adjustedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Notify student with targeted announcement
      if (note) {
        const annRef = db().collection(`games/${_gameId}/announcements`).doc();
        batch.set(annRef, {
          message: `Capital updated to ₹${newCapital.toLocaleString('en-IN')}. ${note}`,
          type: 'capital_update',
          targetStudentId: studentId,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 10000)
        });
      }

      await batch.commit();
      return { ok: true, previous: prev, newCapital };
    } catch (e) { return { error: e.message }; }
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
    } catch (e) { return { error: e.message }; }
  }

  /* ── INSTRUCTOR: announce ── */
  async function announce(message) {
    if (!_gameId) return { error: 'No game' };
    try {
      await db().collection(`games/${_gameId}/announcements`).add({
        message,
        type: 'announcement',
        targetStudentId: null,  // null = broadcast to all
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 8000)
      });
      return { ok: true };
    } catch (e) { return { error: e.message }; }
  }

  /* ── HELPERS ── */
  function _genCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digits = '23456789';
    return letters[Math.floor(Math.random()*letters.length)] +
           letters[Math.floor(Math.random()*letters.length)] +
           digits[Math.floor(Math.random()*digits.length)] +
           digits[Math.floor(Math.random()*digits.length)];
  }

  /* ── PUBLIC API ── */
  return {
    init,
    joinGame,
    placeOrder,
    cancelOrder,
    createGame,
    openRound,
    closeRound,
    pauseRound,
    nextRound,
    settleRound,
    endGame,
    adjustCapital,
    setOptions,
    announce,
    getGameId: () => _gameId
  };
})();
