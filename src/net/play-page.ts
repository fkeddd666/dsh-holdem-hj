/**
 * 给「不在同一台机器上」的朋友用的独立牌桌页面。
 *
 * 邀请链接指向的就是这里：宿主进程直接把这个页面发给对方浏览器，不需要对方装 DSH、
 * 也不需要 DSH Web UI 的访问令牌——页面自己调 /holdem 的 HTTP 接口（轮询）。
 */

import { escapeHtml } from './html.ts'

export interface PlayPageOptions {
  prefix: string
  code: string
  invite: string
  role: 'auto' | 'sit' | 'watch'
  /** 邀请链接里带了昵称就直接进，不再弹昵称框。 */
  name?: string
  /** 内联脚本的 CSP nonce。 */
  nonce?: string
}

export function playPageHtml(options: PlayPageOptions): string {
  const role = options.role
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>德州扑克 · ${escapeHtml(options.code)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #0f1512; color: #e9ecf2;
  }
  header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 16px; border-bottom: 1px solid #1f2a24; }
  header h1 { margin: 0; font-size: 15px; }
  .pill { border: 1px solid #2a3a32; border-radius: 999px; padding: 1px 9px; font-size: 11px; color: #9db0a6; }
  .grow { flex: 1; }
  main { display: flex; flex: 1; min-height: 0; }
  #feltWrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; }
  #felt {
    position: relative; flex: 1; min-height: 300px; border-radius: 24px; overflow: hidden;
    background:
      radial-gradient(ellipse at 50% 38%, rgba(255,255,255,.12), transparent 58%),
      radial-gradient(ellipse at 50% 120%, rgba(0,0,0,.5), transparent 62%),
      linear-gradient(165deg, #1f6a4f 0%, #17553f 55%, #123f30 100%);
    border: 1px solid rgba(0,0,0,.32);
    box-shadow: inset 0 0 70px rgba(0,0,0,.42);
  }
  .seat {
    position: absolute; width: 158px; padding: 7px 9px; border-radius: 12px;
    background: rgba(247,247,248,.94); color: #14181c; display: flex; flex-direction: column; gap: 4px;
    border: 1px solid rgba(0,0,0,.18);
  }
  .seat.you { border-color: #e8c15a; box-shadow: 0 0 0 1px #e8c15a; }
  .seat.actor { border-color: #e8c15a; box-shadow: 0 0 0 1px #e8c15a, 0 0 18px rgba(232,193,90,.45); }
  .seat.folded { opacity: .5; }
  .seat.empty { background: rgba(255,255,255,.06); color: rgba(255,255,255,.6); border: 1px dashed rgba(255,255,255,.28); align-items: center; justify-content: center; min-height: 64px; }
  .seatTop { display: flex; align-items: center; gap: 6px; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; flex: none; display: grid; place-items: center; font-weight: 700; font-size: 12px; color: #fff; background: linear-gradient(150deg,#3f7f66,#245040); }
  .who { min-width: 0; flex: 1; }
  .name { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stack { font-size: 11.5px; color: #4b5b52; font-variant-numeric: tabular-nums; }
  .badges { display: flex; gap: 4px; flex-wrap: wrap; font-size: 9px; color: #6c7a70; }
  .badges span { border: 1px solid currentColor; border-radius: 4px; padding: 0 3px; }
  .lastAction { font-size: 10px; color: #6c7a70; }
  .cards { display: flex; gap: 3px; justify-content: center; min-height: 46px; align-items: center; }
  .p0 { left: 50%; bottom: 8px; transform: translateX(-50%); }
  .p1 { left: 2%; bottom: 96px; }
  .p2 { left: 1%; top: 62px; }
  .p3 { left: 50%; top: 6px; transform: translateX(-50%); }
  .p4 { right: 1%; top: 62px; }
  .p5 { right: 2%; bottom: 96px; }
  #center { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); text-align: center; display: flex; flex-direction: column; gap: 6px; align-items: center; }
  #street { font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,255,255,.62); }
  #board { display: flex; gap: 6px; }
  #pot { font-size: 12.5px; font-weight: 700; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.4); }
  #banner { background: #fff; color: #14181c; border-radius: 10px; padding: 7px 12px; font-size: 12px; box-shadow: 0 10px 24px rgba(0,0,0,.3); }
  #banner b { display: block; margin-bottom: 2px; }
  /* 方案 A：左上角点数 + 中央大花色 */
  .card {
    position: relative; display: block; flex: none; overflow: hidden;
    width: 50px; height: 70px; border-radius: 8px;
    background: #fcfbf7; color: #16171a; border: 1px solid #e2e0d7;
    box-shadow: 0 1px 2px rgba(0,0,0,.22), 0 3px 8px rgba(0,0,0,.12);
    font-family: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif;
    font-weight: 750; font-variant-numeric: tabular-nums; line-height: 1;
    --rank: 16px; --suit: 27px;
  }
  .card .rank { position: absolute; left: 5px; top: 4px; font-size: var(--rank); line-height: 1; }
  .card .suit { position: absolute; left: 50%; top: 60%; transform: translate(-50%,-50%); font-size: var(--suit); line-height: 1; }
  .card.red { color: #d81b3c; }
  .card.sm { width: 38px; height: 54px; border-radius: 6px; --rank: 13px; --suit: 19px; }
  .card.back {
    background: radial-gradient(circle at 50% 50%, #2f6f5c 0 2.5px, transparent 2.6px) 0 0 / 9px 9px, #f6f3ea;
    border-color: #d9d6cb; box-shadow: inset 0 0 0 3px #f6f3ea, 0 1px 2px rgba(0,0,0,.22);
  }
  .card.slot { background: transparent; border: 1px dashed rgba(255,255,255,.32); box-shadow: none; }
  #me { display: flex; align-items: center; gap: 12px; border: 1px solid #22302a; background: #141c18; border-radius: 12px; padding: 8px 10px; flex: none; }
  #myCards { display: flex; gap: 6px; }
  #myMeta { display: flex; flex-direction: column; gap: 1px; min-width: 88px; }
  #myName { font-weight: 600; }
  #myStack { font-size: 11.5px; color: #9db0a6; }
  #actions { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; border-radius: 8px; border: 1px solid #2f4038; background: #1b2621; color: #e9ecf2; padding: 7px 12px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: #47604f; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #2f9c76; border-color: transparent; color: #06130f; font-weight: 700; }
  button.warn { border-color: #d64545; color: #d64545; background: transparent; }
  button.ghost { background: transparent; }
  input[type=range] { flex: 1; min-width: 120px; accent-color: #2f9c76; }
  input[type=text] { font: inherit; border-radius: 8px; border: 1px solid #33443b; background: #101714; color: #e9ecf2; padding: 7px 10px; }
  #raiseValue { font-variant-numeric: tabular-nums; font-weight: 700; min-width: 70px; text-align: right; }
  .hint { color: #8fa197; font-size: 11.5px; }
  aside { width: 260px; flex: none; border-left: 1px solid #1f2a24; padding: 10px 12px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #8fa197; margin: 0; }
  .list { display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; }
  .leaderRow { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; }
  .chat { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; max-height: 180px; overflow-y: auto; }
  .chat b { color: #6fd0a8; font-weight: 600; }
  #toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: #1b2621; border: 1px solid #2f4038; border-radius: 999px; padding: 8px 16px; display: none; z-index: 40; }
  #overlay { position: fixed; inset: 0; background: rgba(6,10,8,.72); display: none; place-items: center; padding: 20px; z-index: 30; }
  #overlayCard { width: min(680px, 100%); max-height: 100%; overflow-y: auto; background: #131a16; border: 1px solid #2a3a32; border-radius: 14px; padding: 18px; }
  #overlayCard h2 { margin: 0 0 6px; font-size: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
  th, td { text-align: left; padding: 7px 8px; border-top: 1px solid #1f2a24; }
  th { color: #8fa197; font-weight: 500; font-size: 11px; }
  .up { color: #4cc38a; }
  .down { color: #e06c75; }
  #join { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(6,10,8,.78); z-index: 50; }
  #joinCard { width: min(380px, 92vw); background: #131a16; border: 1px solid #2a3a32; border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
  @media (max-width: 980px) {
    aside { display: none; }
    .seat { width: 132px; }
    .p1, .p2, .p4, .p5 { top: auto; bottom: auto; }
  }
</style>
</head>
<body data-prefix="${escapeHtml(options.prefix)}" data-code="${escapeHtml(options.code)}" data-invite="${escapeHtml(options.invite)}" data-role="${escapeHtml(role)}" data-name="${escapeHtml(options.name ?? '')}">
<header>
  <h1 id="roomTitle">德州扑克</h1>
  <span class="pill" id="roomCode">房号 ${escapeHtml(options.code)}</span>
  <span class="pill" id="phase">连接中…</span>
  <span class="pill" id="blinds"></span>
  <span class="grow"></span>
  <span class="pill" id="conn">○</span>
  <button class="ghost" id="leave" type="button">离开</button>
</header>
<main>
  <div id="feltWrap">
    <div id="felt">
      <div id="seats"></div>
      <div id="center">
        <div id="street"></div>
        <div id="board"></div>
        <div id="pot"></div>
        <div id="banner" style="display:none"></div>
      </div>
    </div>
    <div id="me">
      <div id="myCards"></div>
      <div id="myMeta">
        <span id="myName">—</span>
        <span id="myStack"></span>
      </div>
      <div id="actions"><span class="hint" id="actionHint">等待其他人…</span></div>
    </div>
  </div>
  <aside>
    <div><h2>排行榜</h2><div class="list" id="leaderboard"></div></div>
    <div><h2>桌边聊天</h2><div class="chat" id="chat"></div><div class="row" style="margin-top:6px"><input type="text" id="chatInput" placeholder="说点什么…" style="flex:1" /><button id="chatSend" type="button">发送</button></div></div>
  </aside>
</main>
<div id="toast"></div>
<div id="overlay"><div id="overlayCard"></div></div>
<div id="join" style="display:none">
  <div id="joinCard">
    <h2 style="margin:0;font-size:16px">加入牌桌</h2>
    <p class="hint" id="joinHint" style="margin:0"></p>
    <input type="text" id="nameInput" placeholder="你的昵称" maxlength="16" />
    <div class="row">
      <button class="primary" id="joinSit" type="button">进入牌桌</button>
      <button id="joinWatch" type="button">只看不打</button>
    </div>
  </div>
</div>
<script${options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : ''}>
(function () {
  var body = document.body
  var prefix = body.dataset.prefix || '/holdem'
  var code = body.dataset.code || ''
  var invite = body.dataset.invite || ''
  var preferWatch = body.dataset.role === 'watch'
  var presetName = body.dataset.name || ''
  var storeKey = 'holdem-guest:' + code
  var state = { token: '', roomId: '', view: null, busy: false, sig: '', ended: '', poll: 0, timer: 0 }
  var els = {
    title: document.getElementById('roomTitle'),
    code: document.getElementById('roomCode'),
    phase: document.getElementById('phase'),
    blinds: document.getElementById('blinds'),
    conn: document.getElementById('conn'),
    seats: document.getElementById('seats'),
    street: document.getElementById('street'),
    board: document.getElementById('board'),
    pot: document.getElementById('pot'),
    banner: document.getElementById('banner'),
    myCards: document.getElementById('myCards'),
    myName: document.getElementById('myName'),
    myStack: document.getElementById('myStack'),
    actions: document.getElementById('actions'),
    leaderboard: document.getElementById('leaderboard'),
    chat: document.getElementById('chat'),
    chatInput: document.getElementById('chatInput'),
    toast: document.getElementById('toast'),
    overlay: document.getElementById('overlay'),
    overlayCard: document.getElementById('overlayCard'),
    join: document.getElementById('join'),
    joinHint: document.getElementById('joinHint'),
    nameInput: document.getElementById('nameInput'),
    leave: document.getElementById('leave')
  }

  var SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' }
  var RANK = { T: '10' }

  function cardHtml(card, size) {
    var rank = card.charAt(0)
    var suit = card.charAt(1)
    var red = suit === 'h' || suit === 'd'
    var cls = 'card' + (size === 'sm' ? ' sm' : '') + (red ? ' red' : '')
    return '<span class="' + cls + '"><span class="rank">' + (RANK[rank] || rank) + '</span><span class="suit">' + (SUIT[suit] || '') + '</span></span>'
  }

  function backHtml(size) {
    return '<span class="card back' + (size === 'sm' ? ' sm' : '') + '"></span>'
  }

  function slotHtml() {
    return '<span class="card slot"></span>'
  }

  function chips(value) {
    return Math.round(value).toLocaleString('en-US')
  }

  function signed(value) {
    if (!value) return '0'
    return (value > 0 ? '+' : '−') + chips(Math.abs(value))
  }

  function toast(text, isError) {
    els.toast.textContent = text
    els.toast.style.display = 'block'
    els.toast.style.borderColor = isError ? '#d64545' : '#2f4038'
    clearTimeout(toast.timer)
    toast.timer = setTimeout(function () { els.toast.style.display = 'none' }, isError ? 4200 : 2400)
  }

  function headers(extra) {
    var out = { 'content-type': 'application/json', 'x-requested-with': '@zhuweiyou/dsh-holdem' }
    if (state.token) out['x-holdem-seat'] = state.token
    if (extra) for (var key in extra) out[key] = extra[key]
    return out
  }

  function api(path, options) {
    var init = options || {}
    return fetch(prefix + path, {
      method: init.method || 'GET',
      headers: headers(),
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = text ? JSON.parse(text) : {}
        if (!response.ok) {
          var error = new Error(payload.message || ('HTTP ' + response.status))
          error.status = response.status
          error.code = payload.error
          error.view = payload.view
          throw error
        }
        return payload
      })
    })
  }

  function actionId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID()
    if (window.crypto && window.crypto.getRandomValues) {
      var bytes = new Uint8Array(16)
      window.crypto.getRandomValues(bytes)
      var out = ''
      for (var i = 0; i < bytes.length; i += 1) out += ('0' + bytes[i].toString(16)).slice(-2)
      return 'g' + out
    }
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  // ---------------------------------------------------------------- 加入
  function storedName() {
    try { return localStorage.getItem('holdem-name') || '' } catch (e) { return '' }
  }

  function saveName(name) {
    try { localStorage.setItem('holdem-name', name) } catch (e) {}
  }

  function askJoin() {
    els.join.style.display = 'grid'
    els.nameInput.value = storedName()
    els.joinHint.textContent = preferWatch ? '以观战身份进入房间 ' + code : '房间 ' + code + '：有空位就直接入座，满员自动观战'
    setTimeout(function () { els.nameInput.focus() }, 50)
  }

  function join(role) {
    var name = (els.nameInput.value || '').trim()
    if (!name) { toast('先填个昵称', true); return }
    saveName(name)
    els.join.style.display = 'none'
    api('/api/join', { method: 'POST', body: { roomCode: code, invite: invite, displayName: name, role: role } }).then(function (payload) {
      state.token = payload.sessionToken || ''
      state.roomId = payload.roomId || ''
      try { sessionStorage.setItem(storeKey, state.token) } catch (e) {}
      applyView(payload.view)
      startPolling()
      toast(role === 'watch' ? '已进入观战席' : '已入座')
    }).catch(function (error) {
      els.join.style.display = 'grid'
      els.joinHint.textContent = error.message || '加入失败'
    })
  }

  els.nameInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') join(preferWatch ? 'watch' : 'sit') })
  document.getElementById('joinSit').addEventListener('click', function () { join('sit') })
  document.getElementById('joinWatch').addEventListener('click', function () { join('watch') })

  // ---------------------------------------------------------------- 视图
  function applyView(view) {
    if (!view) return
    state.view = view
    state.roomId = view.room.roomId
    if (view.room.phase === 'closed') stopPolling()
    render()
  }

  function startPolling() {
    if (state.poll) return
    state.poll = setInterval(tick, 1200)
    tick()
  }

  function stopPolling() {
    if (state.poll) clearInterval(state.poll)
    state.poll = 0
  }

  function tick() {
    if (!state.roomId || state.busy) return
    api('/api/rooms/' + encodeURIComponent(state.roomId) + '/state').then(function (payload) {
      els.conn.textContent = '●'
      els.conn.style.color = '#4cc38a'
      applyView(payload.view)
    }).catch(function (error) {
      if (error.status === 403 || error.status === 404) {
        els.conn.textContent = '○'
        els.conn.style.color = '#e06c75'
        if (state.ended !== 'gone') {
          state.ended = 'gone'
          stopPolling()
          toast('房间已解散', true)
        }
        return
      }
      els.conn.textContent = '◐'
      els.conn.style.color = '#c58a00'
    })
  }

  function command(cmd) {
    if (!state.view) return Promise.resolve()
    state.busy = true
    var baseSeq = state.view.room.seq
    return api('/api/rooms/' + encodeURIComponent(state.roomId) + '/action', {
      method: 'POST',
      body: { actionId: actionId(), baseSeq: baseSeq, command: cmd }
    }).then(function (payload) {
      applyView(payload.view)
    }).catch(function (error) {
      if (error.view) applyView(error.view)
      if (error.code === 'stale') toast('状态已更新，请重试', true)
      else if (error.code !== 'not-your-turn') toast(error.message || '操作失败', true)
    }).then(function () {
      state.busy = false
      tick()
    })
  }

  // ---------------------------------------------------------------- 渲染
  function phaseText(phase) {
    return phase === 'hand' ? '正在打牌' : phase === 'handOver' ? '本手结束' : phase === 'closed' ? '已结束' : '等待开局'
  }

  function render() {
    var view = state.view
    if (!view) return
    var room = view.room
    els.title.textContent = room.title
    els.code.textContent = '房号 ' + room.roomCode
    els.phase.textContent = phaseText(room.phase)
    els.blinds.textContent = room.settings.sb + '/' + room.settings.bb + ' · 带入 ' + chips(room.settings.buyIn)
    els.conn.textContent = '●'
    renderSeats(view)
    renderCenter(view)
    renderMe(view)
    renderRail(view)
    if (room.phase === 'closed' && view.settlement) renderSettlement(view)
    else els.overlay.style.display = 'none'
  }

  function renderSeats(view) {
    var room = view.room
    var hand = view.hand
    var base = view.you.seat === null ? 0 : view.you.seat
    var html = ''
    for (var i = 0; i < room.seats.length; i += 1) {
      var seat = room.seats[i]
      var rel = (seat.seat - base + 6) % 6
      var cls = 'seat p' + rel
      if (seat.seat === view.you.seat) cls += ' you'
      if (hand && hand.toActSeat === seat.seat && room.phase === 'hand') cls += ' actor'
      if (seat.folded) cls += ' folded'
      if (!seat.playerId) {
        html += '<div class="seat empty p' + rel + '">入座</div>'
        continue
      }
      var shown = null
      if (hand) for (var j = 0; j < hand.shownHands.length; j += 1) if (hand.shownHands[j].seat === seat.seat) shown = hand.shownHands[j]
      html += '<div class="' + cls + '">'
      html += '<div class="seatTop"><div class="avatar">' + escape((seat.displayName || '?').slice(0, 1)) + '</div>'
      html += '<div class="who"><div class="name">' + escape(seat.displayName || '—') + '</div><div class="stack">' + chips(seat.stack) + '</div></div></div>'
      html += '<div class="badges">'
      if (seat.host) html += '<span>房主</span>'
      if (hand && hand.button === seat.seat) html += '<span>D</span>'
      if (hand && hand.sbSeat === seat.seat) html += '<span>SB</span>'
      if (hand && hand.bbSeat === seat.seat) html += '<span>BB</span>'
      if (seat.allIn) html += '<span>全下</span>'
      html += '</div>'
      html += '<div class="cards">'
      if (shown) { for (var k = 0; k < shown.cards.length; k += 1) html += cardHtml(shown.cards[k], 'sm') }
      else { for (var b = 0; b < seat.holeCount; b += 1) html += backHtml('sm') }
      html += '</div>'
      if (seat.lastAction) html += '<div class="lastAction">' + escape(seat.lastAction) + '</div>'
      if (seat.committed > 0) html += '<div class="lastAction">本轮 ' + chips(seat.committed) + '</div>'
      html += '</div>'
    }
    els.seats.innerHTML = html
  }

  function renderCenter(view) {
    var hand = view.hand
    var room = view.room
    if (hand) {
      els.street.textContent = ({ preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' })[hand.street] || ''
      var board = ''
      for (var i = 0; i < 5; i += 1) board += hand.board[i] ? cardHtml(hand.board[i]) : slotHtml()
      els.board.innerHTML = board
      els.pot.textContent = '底池 ' + chips(hand.potTotal)
    } else {
      els.street.textContent = ''
      els.board.innerHTML = ''
      els.pot.textContent = ''
    }
    var last = view.lastHand
    if (room.phase === 'handOver' && last) {
      var winners = last.winners.map(function (seat) {
        var found = room.seats.filter(function (entry) { return entry.seat === seat })[0]
        return found && found.displayName ? found.displayName : '座位 ' + seat
      }).join(' · ')
      var gains = last.deltas.filter(function (delta) { return delta.net !== 0 }).map(function (delta) {
        return escape(delta.displayName) + ' ' + signed(delta.net)
      }).join('　')
      els.banner.style.display = 'block'
      els.banner.innerHTML = '<b>' + (last.foldedWin ? '无人跟注，直接收池' : escape(winners) + ' 赢得 ' + chips(last.pots.reduce(function (sum, pot) { return sum + pot.amount }, 0))) + '</b>' + gains
    } else {
      els.banner.style.display = 'none'
    }
  }

  function renderMe(view) {
    var you = view.you
    var room = view.room
    var hand = view.hand
    var html = ''
    if (you.holeCards.length > 0) {
      for (var i = 0; i < you.holeCards.length; i += 1) html += cardHtml(you.holeCards[i])
    } else if (room.phase === 'hand' && !you.spectator) {
      html += backHtml() + backHtml()
    }
    els.myCards.innerHTML = html
    els.myName.textContent = you.displayName
    els.myStack.textContent = you.spectator ? '观战中' : chips((room.seats.filter(function (seat) { return seat.seat === you.seat })[0] || {}).stack || 0) + ' · 净赢 ' + signed(you.netChips)
    renderActions(view)
  }

  function renderActions(view) {
    var you = view.you
    var room = view.room
    var hand = view.hand
    var legal = you.legal
    var canAct = you.canAct && legal && room.phase === 'hand'
    var sig = canAct
      ? ['act', hand ? hand.handNo : 0, hand ? hand.toActSeat : -1, legal.minRaiseTo, legal.maxRaiseTo, legal.canCheck, legal.canCall, legal.canRaise, legal.callAmount].join(':')
      : ['idle', room.phase, you.ready, you.spectator, you.seat, room.hostPlayerId === you.playerId]
    if (sig === state.sig) { updateTimer(); return }
    state.sig = sig
    if (canAct) {
      var isAllIn = legal.canRaise && legal.minRaiseTo >= legal.maxRaiseTo
      var raiseValue = legal.minRaiseTo
      var step = Math.max(1, Math.round(room.settings.bb / 2))
      els.actions.innerHTML =
        '<div class="row"><span class="hint" style="color:#e8c15a;font-weight:700">轮到你</span><span class="hint" id="timer"></span></div>' +
        '<div class="row">' +
        '<button class="ghost" data-act="fold"' + (legal.canFold ? '' : ' disabled') + '>弃牌</button>' +
        (legal.canCheck
          ? '<button data-act="check">过牌</button>'
          : '<button data-act="call"' + (legal.canCall ? '' : ' disabled') + '>跟注 ' + chips(legal.callAmount) + '</button>') +
        (legal.canRaise
          ? '<span id="raiseValue">' + chips(raiseValue) + '</span>' +
            '<input type="range" id="raiseRange" min="' + legal.minRaiseTo + '" max="' + legal.maxRaiseTo + '" step="' + step + '" value="' + raiseValue + '" />' +
            '<button data-range="0.5" class="ghost">1/2 池</button>' +
            '<button data-range="0.66" class="ghost">2/3 池</button>' +
            '<button data-range="1" class="ghost">一池</button>' +
            '<button data-range="max" class="ghost">最大</button>' +
            '<button class="primary" data-act="raise">' + (isAllIn ? '全下' : '加注') + '</button>'
          : '') +
        '</div>'
      var range = document.getElementById('raiseRange')
      var value = document.getElementById('raiseValue')
      if (range) {
        range.addEventListener('input', function () { value.textContent = chips(Number(range.value)) })
      }
      els.actions.querySelectorAll('[data-range]').forEach(function (button) {
        button.addEventListener('click', function () {
          var ratio = button.dataset.range
          var next = ratio === 'max' ? legal.maxRaiseTo : Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round((hand ? hand.potTotal : 0) * Number(ratio))))
          range.value = String(next)
          value.textContent = chips(next)
        })
      })
      els.actions.querySelectorAll('[data-act]').forEach(function (button) {
        button.addEventListener('click', function () {
          var act = button.dataset.act
          if (act === 'fold') command({ type: 'action', action: { type: 'fold' } })
          else if (act === 'check') command({ type: 'action', action: { type: 'check' } })
          else if (act === 'call') command({ type: 'action', action: { type: 'call' } })
          else if (act === 'raise') command({ type: 'action', action: { type: 'raise', to: Number(range.value) } })
        })
      })
      updateTimer()
      return
    }

    // 不能行动时：按阶段给出等待/准备/开始/入座
    var parts = []
    if (you.spectator) {
      parts.push('<span class="hint">你在观战席' + (room.phase === 'lobby' ? '，等待阶段可以入座' : '') + '</span>')
      if (room.phase === 'lobby') parts.push('<button class="primary" data-cmd="sit">入座</button>')
    } else if (room.phase === 'lobby') {
      parts.push('<span class="hint">' + (you.ready ? '已准备，等房主开局' : '尚未准备') + '</span>')
      parts.push('<button data-cmd="' + (you.ready ? 'unready' : 'ready') + '">' + (you.ready ? '取消准备' : '准备') + '</button>')
      if (room.hostPlayerId === you.playerId) parts.push('<button class="primary" data-cmd="start">开始</button>')
      parts.push('<button class="ghost" data-cmd="stand">离座</button>')
    } else if (room.phase === 'hand') {
      var actorName = ''
      if (hand && hand.toActSeat !== null) {
        var actorSeat = room.seats.filter(function (seat) { return seat.seat === hand.toActSeat })[0]
        actorName = actorSeat && actorSeat.displayName ? actorSeat.displayName : ''
      }
      parts.push('<span class="hint">' + (actorName ? '等待 ' + escape(actorName) + ' 行动' : '等待中') + '</span>')
    } else if (room.phase === 'handOver') {
      parts.push('<span class="hint">' + (room.nextHandAt ? '马上开下一手…' : '本手结束') + '</span>')
    } else {
      parts.push('<span class="hint">房间已结束</span>')
    }
    els.actions.innerHTML = '<div class="row">' + parts.join('') + '</div>'
    els.actions.querySelectorAll('[data-cmd]').forEach(function (button) {
      button.addEventListener('click', function () {
        var cmd = button.dataset.cmd
        if (cmd === 'ready') command({ type: 'ready', ready: true })
        else if (cmd === 'unready') command({ type: 'ready', ready: false })
        else if (cmd === 'start') command({ type: 'start' })
        else if (cmd === 'sit') command({ type: 'sit' })
        else if (cmd === 'stand') command({ type: 'stand' })
      })
    })
  }

  function updateTimer() {
    var view = state.view
    var node = document.getElementById('timer')
    if (!node || !view || !view.hand || !view.hand.deadlineAt) return
    var left = Math.max(0, Math.ceil((Date.parse(view.hand.deadlineAt) - Date.now()) / 1000))
    node.textContent = left + ' 秒'
    node.style.color = left <= 5 ? '#e06c75' : '#9db0a6'
  }

  function renderRail(view) {
    var board = ''
    for (var i = 0; i < view.leaderboard.length; i += 1) {
      var entry = view.leaderboard[i]
      board += '<div class="leaderRow"><span>' + (i + 1) + '</span><span>' + escape(entry.displayName) + '</span><span class="' + (entry.netChips >= 0 ? 'up' : 'down') + '">' + signed(entry.netChips) + '</span></div>'
    }
    els.leaderboard.innerHTML = board || '<span class="hint">还没有记录</span>'
    var chat = ''
    for (var j = 0; j < view.chat.length; j += 1) {
      chat += '<div><b>' + escape(view.chat[j].displayName) + '</b> ' + escape(view.chat[j].text) + '</div>'
    }
    els.chat.innerHTML = chat || '<span class="hint">还没有记录</span>'
    els.chatInput.disabled = !view.room.settings.chatEnabled
  }

  function renderSettlement(view) {
    var summary = view.settlement
    if (!summary) return
    var rows = summary.players.map(function (player) {
      return '<tr><td>' + player.rank + '</td><td>' + escape(player.displayName) + '</td><td>' + player.handsPlayed + '</td><td>' + player.handsWon + '</td><td class="' + (player.netChips >= 0 ? 'up' : 'down') + '">' + signed(player.netChips) + '</td></tr>'
    }).join('')
    els.overlayCard.innerHTML =
      '<h2>本场结算</h2>' +
      '<p class="hint" style="margin:0">' + escape(summary.title) + ' · 房号 ' + escape(summary.roomCode) + ' · 共 ' + summary.handsPlayed + ' 手 · ' + (summary.reason === 'host-idle' ? '房主失联自动解散' : '房主解散房间') + '</p>' +
      '<table><thead><tr><th>名次</th><th>玩家</th><th>手数</th><th>胜局</th><th>净赢</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="hint" style="margin-top:12px">这局已经结束，房间不会重开。想再打请向房主要新链接。</p>'
    els.overlay.style.display = 'grid'
  }

  function escape(text) {
    return String(text).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    })
  }

  // ---------------------------------------------------------------- 聊天 / 离开
  document.getElementById('chatSend').addEventListener('click', function () {
    var text = (els.chatInput.value || '').trim()
    if (!text) return
    els.chatInput.value = ''
    command({ type: 'chat', text: text.slice(0, 80) })
  })
  els.chatInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') document.getElementById('chatSend').click()
  })

  els.leave.addEventListener('click', function () {
    api('/api/leave', { method: 'POST', body: { roomId: state.roomId } }).catch(function () {}).then(function () {
      try { sessionStorage.removeItem(storeKey) } catch (e) {}
      location.reload()
    })
  })

  // 键盘：F 弃牌 / C 过牌-跟注 / R 加注
  window.addEventListener('keydown', function (event) {
    var target = event.target
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    var view = state.view
    if (!view || !view.you.legal || !view.you.canAct) return
    var legal = view.you.legal
    var key = event.key.toLowerCase()
    if (key === 'f' && legal.canFold) command({ type: 'action', action: { type: 'fold' } })
    else if (key === 'c') command({ type: 'action', action: legal.canCheck ? { type: 'check' } : { type: 'call' } })
    else if (key === 'r' && legal.canRaise) {
      var range = document.getElementById('raiseRange')
      command({ type: 'action', action: { type: 'raise', to: Number(range ? range.value : legal.minRaiseTo) } })
    }
  })

  // ---------------------------------------------------------------- 启动
  state.timer = setInterval(updateTimer, 250)
  var saved = ''
  try { saved = sessionStorage.getItem(storeKey) || '' } catch (e) {}
  if (presetName) {
    els.nameInput.value = presetName
    join(preferWatch ? 'watch' : 'sit')
    state.timer = setInterval(updateTimer, 250)
    return
  }
  if (saved) {
    state.token = saved
    api('/api/session?roomId=' + encodeURIComponent(''))
      .then(function (payload) {
        if (payload.inRoom && payload.view && payload.view.room.roomCode === code) {
          applyView(payload.view)
          startPolling()
          return
        }
        state.token = ''
        try { sessionStorage.removeItem(storeKey) } catch (e) {}
        askJoin()
      })
      .catch(function () { askJoin() })
  } else {
    askJoin()
  }
})();
</script>
</body>
</html>`
}
