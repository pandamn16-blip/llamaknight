(() => {
  'use strict';
  const RELEASE_AT = Date.parse('2026-11-22T19:29:00Z');
  const HASH = '1fdf7964e337ea72432b47060405b22d845fe37c2ced00cd8f105086f5e7c9ba';
  const KEY = 'llamaknight-preview-unlocked-v1';
  // Never trust the visitor's device clock for unlocking.
  // GitHub Pages sends a server-side Date response header.
  const TIME_URL = new URL('launch-gate.js', document.currentScript?.src || location.href);
  let verifiedReleased = false;
  let checking = false;
  let timer;
  if (sessionStorage.getItem(KEY) === 'yes') return;

  async function checkServerTime() {
    if (checking || verifiedReleased) return;
    checking = true;
    try {
      const url = new URL(TIME_URL.href);
      url.searchParams.set('time-check', Math.random().toString(36).slice(2));
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) throw new Error('Time endpoint unavailable');
      const header = response.headers.get('Date');
      if (!header) throw new Error('Server Date header unavailable');
      const serverTime = Date.parse(header);
      if (!Number.isFinite(serverTime)) throw new Error('Invalid server Date header');
      if (serverTime >= RELEASE_AT) {
        verifiedReleased = true;
        removeGate();
      }
    } catch (error) {
      // Fail closed when server time cannot be confirmed. Password still works.
      console.warn('LlamaKnight: server-time verification unavailable; preview stays locked.', error);
    } finally {
      checking = false;
    }
  }


  const css = document.createElement('style');
  css.id = 'lk-preview-styles';
  css.textContent = `
    #lk-preview-gate { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; padding:22px; background:radial-gradient(ellipse at 50% 30%,#3e2849 0%,#181122 48%,#090710 100%); color:#fff0ca; font-family:Georgia,serif; text-align:center; overflow:auto; }
    #lk-preview-gate * { box-sizing:border-box; }
    #lk-preview-gate .lk-panel { width:min(100%,470px); border:1px solid #cda466; border-radius:18px; padding:clamp(24px,5vw,44px); background:linear-gradient(165deg,#26172fe8,#100b1be8); box-shadow:0 22px 90px #0009, inset 0 0 40px #cda4660c; }
    #lk-preview-gate .lk-mark { color:#f9d992; font-size:38px; margin-bottom:12px; }
    #lk-preview-gate h1 { font:600 clamp(30px,7vw,43px)/1.16 Georgia,serif; margin:0 0 13px; color:#fff0ca; }
    #lk-preview-gate .lk-desc { margin:0 auto 25px; color:#e0c9a9; font:16px/1.6 system-ui,sans-serif; max-width:330px; }
    #lk-preview-gate label { display:block; font:600 12px/1.4 system-ui,sans-serif; text-align:left; letter-spacing:.09em; text-transform:uppercase; margin-bottom:9px; }
    #lk-preview-gate input { width:100%; border:1px solid #94765c; border-radius:9px; padding:14px 15px; background:#120c1b; color:white; font:16px system-ui,sans-serif; }
    #lk-preview-gate input:focus { outline:2px solid #f4cf8b; outline-offset:2px; }
    #lk-preview-gate button { display:block; margin-top:14px; width:100%; border:0; border-radius:9px; padding:15px; background:linear-gradient(135deg,#ffe6ae,#d9a45c); color:#271223; font:700 16px Georgia,serif; cursor:pointer; }
    #lk-preview-gate .lk-error { min-height:21px; margin:12px 0 0; color:#ffb9b9; font:14px system-ui,sans-serif; }
    #lk-preview-gate .lk-time { margin:23px 0 0; color:#c7b2c9; font:13px/1.5 system-ui,sans-serif; }
  `;
  const gate = document.createElement('div');
  gate.id = 'lk-preview-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-labelledby', 'lk-preview-title');
  gate.innerHTML = `
    <div class="lk-panel">
      <div class="lk-mark" aria-hidden="true">♜</div>
      <h1 id="lk-preview-title">LlamaKnight</h1>
      <p class="lk-desc">The Breadlands open to everyone on 22 November at 19:30 UTC. Until then, this adventure is for invited knights only.</p>
      <form id="lk-preview-form" autocomplete="off">
        <label for="lk-preview-password">Preview password</label>
        <input id="lk-preview-password" type="password" autocomplete="off" required placeholder="Enter your invitation password" />
        <button type="submit">Enter the Breadlands</button>
        <p class="lk-error" id="lk-preview-error" role="alert"></p>
      </form>
      <p class="lk-time">Public launch · 22 November 2026 · 19:30 UTC</p>
    </div>
  `;
  const removeGate = () => {
    gate.remove();
    css.remove();
    document.body.style.removeProperty('overflow');
    document.removeEventListener('keydown', keepFocus, true);
    if (timer) clearInterval(timer);
  };
  const keepFocus = (event) => {
    if (event.key === 'Tab' && !gate.contains(document.activeElement)) {
      event.preventDefault();
      gate.querySelector('input').focus();
    }
  };
  const start = () => {
    document.head.append(css);
    document.body.append(gate);
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', keepFocus, true);
    const input = gate.querySelector('input');
    const error = gate.querySelector('#lk-preview-error');
    gate.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      await checkServerTime();
      if (verifiedReleased) return;
      const bytes = new TextEncoder().encode(input.value);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
      if (hex === HASH) {
        sessionStorage.setItem(KEY, 'yes');
        removeGate();
      } else {
        error.textContent = 'That password is not quite right.';
        input.select();
      }
    });
    input.focus();
    // Recheck the authoritative server clock, including tabs left open.
    void checkServerTime();
    timer = setInterval(() => { void checkServerTime(); }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void checkServerTime();
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();