import { escapeHtml, jsLiteral } from './html.ts'

export interface JoinPageOptions {
  prefix: string
  code: string
  invite: string
  role: 'auto' | 'sit' | 'watch'
  /** 内联脚本的 CSP nonce；不传时由路由层拒绝渲染。 */
  nonce?: string
}

/**
 * 邀请落地页：只做「这是哪一桌 / 要不要现在进去」。
 * 真正的牌桌在 /play —— 那个页面自带完整客户端，对方不用装任何东西。
 */
export function joinPageHtml(options: JoinPageOptions): string {
  const play = `${options.prefix}/play?code=${encodeURIComponent(options.code)}&invite=${encodeURIComponent(options.invite)}&role=${options.role}`
  const roleText = options.role === 'watch' ? '观战' : '入座（满员自动观战）'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>加入德州扑克 · ${escapeHtml(options.code)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #101418; color: #e9ecf2;
    background-image: radial-gradient(circle at 50% 0%, #17352c 0%, #101418 60%);
  }
  .card { width: min(460px, 100%); background: #181c22; border: 1px solid #2a313a; border-radius: 16px; padding: 24px; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .meta { color: #93a0b1; font-size: 13px; margin-bottom: 16px; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 26px; letter-spacing: 4px; color: #e8c15a; margin: 8px 0 16px; }
  .info { border: 1px solid #2a313a; border-radius: 10px; padding: 12px; background: #141a20; margin-bottom: 16px; }
  .info .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
  .info .row + .row { margin-top: 6px; }
  .info .k { color: #93a0b1; }
  .hint { color: #93a0b1; font-size: 12px; margin: 0 0 12px; }
  .error { color: #e06c75; font-size: 12px; margin: 0 0 12px; }
  button { font: inherit; border-radius: 10px; border: 1px solid transparent; padding: 11px 16px; cursor: pointer; width: 100%; }
  .primary { background: #2f9c76; color: #06130f; font-weight: 700; }
  .primary:disabled { opacity: .55; cursor: progress; }
  footer { margin-top: 14px; font-size: 11.5px; color: #7b899a; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
  <h1>加入德州扑克牌桌</h1>
  <div class="meta">娱乐筹码 · 邀请链接直接进桌</div>
  <div class="code">${escapeHtml(options.code)}</div>
  <div class="info">
    <div class="row"><span class="k">房间</span><span id="title">读取中…</span></div>
    <div class="row"><span class="k">盲注</span><span id="blinds">—</span></div>
    <div class="row"><span class="k">座位</span><span id="seats">—</span></div>
    <div class="row"><span class="k">身份</span><span>${roleText}</span></div>
  </div>
  <p class="hint" id="hint">点下面的按钮进入牌桌，浏览器里直接就能玩，不用安装任何东西。</p>
  <p class="error" id="error" hidden></p>
  <button class="primary" id="enter" type="button">进入牌桌</button>
  <footer>牌桌地址：${escapeHtml(play)}</footer>
</div>
<script${options.nonce ? ` nonce="${escapeHtml(options.nonce)}"` : ''}>
(function () {
  var prefix = ${jsLiteral(options.prefix)};
  var code = ${jsLiteral(options.code)};
  var invite = ${jsLiteral(options.invite)};
  var role = ${jsLiteral(options.role)};
  var target = ${jsLiteral(play)};
  var enter = document.getElementById('enter');
  var error = document.getElementById('error');
  var hint = document.getElementById('hint');

  fetch(prefix + '/api/preview?code=' + encodeURIComponent(code) + '&invite=' + encodeURIComponent(invite) + '&role=' + encodeURIComponent(role), { credentials: 'same-origin' })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (room) {
      if (!room) {
        error.hidden = false;
        error.textContent = '房间可能已解散，请向房主要一个新链接。';
        return;
      }
      document.getElementById('title').textContent = room.title;
      document.getElementById('blinds').textContent = room.settings.sb + '/' + room.settings.bb + ' · 带入 ' + room.settings.buyIn;
      document.getElementById('seats').textContent = room.seated + '/' + room.seats.length + ' 人在座';
      hint.textContent = room.alreadyInRoom
        ? '你之前已经进过这一桌，直接继续就行。'
        : '点下面的按钮进入牌桌，浏览器里直接就能玩，不用安装任何东西。';
    })
    .catch(function () {
      error.hidden = false;
      error.textContent = '连不上房主的进程，确认链接没有过期。';
    });

  enter.addEventListener('click', function () {
    enter.disabled = true;
    enter.textContent = '正在进入…';
    location.replace(target);
  });
})();
</script>
</body>
</html>`
}
