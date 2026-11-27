'use strict';

/* Облачная синхронизация через Supabase.
   Приложение всегда пишет сначала в память устройства (IndexedDB) и отмечает изменение
   в очереди outbox. Здесь очередь отправляется в облако, а чужие изменения забираются.
   При конфликте побеждает более поздняя правка. Без входа приложение работает как раньше.
   Ключ ниже — открытый (publishable): он рассчитан на публикацию, а доступ к строкам
   ограничен правилами базы: каждый пользователь видит только свои. */
window.Sync = (() => {
  const API = 'https://dcvirzrsdffxuxkyxntx.supabase.co';
  const KEY = 'sb_publishable_wE-8K6knq3n5uvbz3jK5dQ_ZRGbfAQ_';
  const TABLES = ['categories', 'accounts', 'settings', 'tx'];
  const PAGE = 1000;
  const BATCH = 300;

  const st = { running: false, again: false, error: '', offline: false, pending: 0 };
  let kickTimer = 0;

  const session = () => S.settings.syncSession || null;
  const signedIn = () => !!session();
  const busyUI = () => !$('sheet-back').hidden || !$('import-view').hidden;
  const appUrl = () => location.origin + location.pathname;

  async function setLocal(key, value) {
    if (value === undefined) {
      delete S.settings[key];
      await dbTx(['settings'], 'readwrite', (t) => { t.objectStore('settings').delete(key); });
    } else {
      S.settings[key] = value;
      await dbPutRaw('settings', { key, value });
    }
  }

  /* ---------- сеть ---------- */
  class NetError extends Error {}
  class AuthError extends Error {}
  class Retry extends Error {}

  async function http(path, { method = 'GET', body, token, headers } = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: Object.assign({ apikey: KEY }, token ? { Authorization: 'Bearer ' + token } : {},
          body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new NetError('нет сети');
    }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      const err = new Error((data && (data.msg || data.message || data.error_description)) || ('ошибка ' + res.status));
      err.status = res.status;
      err.code = (data && (data.error_code || data.code)) || '';
      throw err;
    }
    return data;
  }

  function toSession(d) {
    return {
      access_token: d.access_token, refresh_token: d.refresh_token,
      expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      user: { id: d.user.id, email: d.user.email },
    };
  }

  let refreshing = null;
  async function token() {
    const s = session();
    if (!s) throw new AuthError('нет входа');
    if (s.expires_at - Date.now() > 60000) return s.access_token;
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const d = await http('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: s.refresh_token } });
          await setLocal('syncSession', toSession(d));
        } catch (e) {
          if (e instanceof NetError || e.status >= 500 || e.status === 429) throw e;
          await setLocal('syncSession', undefined);
          throw new AuthError('Вход устарел. Войдите снова.');
        } finally { refreshing = null; }
      })();
    }
    await refreshing;
    return session().access_token;
  }

  const rest = async (path, opts) => http('/rest/v1/' + path, Object.assign({}, opts, { token: await token() }));

  /* ---------- чтение из облака ---------- */
  async function fetchRows(table, cursor) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const q = table + '?select=id,data,mtime,deleted,updated_at&order=updated_at.asc,id.asc&limit=' + PAGE + '&offset=' + offset +
        (cursor ? '&updated_at=gte.' + encodeURIComponent(cursor) : '');
      const page = await rest(q);
      rows.push(...page);
      if (page.length < PAGE) break;
    }
    return rows;
  }

  const toLocal = (table, row) => (table === 'settings' ? { key: row.id, value: row.data ? row.data.value : undefined } : row.data);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const idOf = (table, rec) => (table === 'settings' ? rec.key : rec.id);

  async function outboxMap() {
    const m = new Map();
    (await dbAll('outbox')).forEach((o) => m.set(o.k, o));
    return m;
  }

  /* ---------- первое соединение этого устройства с аккаунтом ----------
     Ничего не теряем: всё локальное, чего нет в облаке, ставится в очередь на отправку.
     Категории и счета с одинаковыми названиями склеиваются, чтобы не было двойных «Продукты». */
  async function firstMerge() {
    const user = session().user;
    if (S.settings.syncUser === user.id) return;
    if (busyUI()) throw new Retry();

    const remote = {};
    for (const t of TABLES) remote[t] = await fetchRows(t, null);
    if (busyUI()) throw new Retry();
    const ob = await outboxMap();
    const remoteHasData = TABLES.some((t) => remote[t].some((r) => !r.deleted));

    /* чистое устройство (ни одного расхода и ни одной правки) и пустое облако: ждём, пока появятся данные */
    const pristine = !S.tx.length && ob.size === 0;
    if (pristine && !remoteHasData) return;

    const idMap = {};
    const drop = { categories: [], accounts: [] };
    for (const t of ['categories', 'accounts']) {
      const rIds = new Set(remote[t].map((r) => r.id));
      const byName = new Map();
      remote[t].forEach((r) => {
        if (!r.deleted && r.data && !r.data.archived && r.data.name) byName.set(r.data.name.trim().toLowerCase(), r.id);
      });
      for (const x of S[t]) {
        if (rIds.has(x.id)) continue;
        const twin = !x.archived && byName.get(String(x.name || '').trim().toLowerCase());
        if (twin) { idMap[x.id] = twin; drop[t].push(x.id); }
        else if (pristine) drop[t].push(x.id); /* стартовый набор нового устройства уступает облачному */
      }
    }

    const now = Date.now();
    const rules = Object.assign({}, S.settings.merchantRules || {});
    let rulesChanged = false;
    for (const k of Object.keys(rules)) if (idMap[rules[k]]) { rules[k] = idMap[rules[k]]; rulesChanged = true; }

    await dbTx(['tx', 'categories', 'accounts', 'settings', 'outbox'], 'readwrite', (t) => {
      for (const s of ['categories', 'accounts']) {
        drop[s].forEach((id) => { t.objectStore(s).delete(id); t.objectStore('outbox').delete(s + '|' + id); ob.delete(s + '|' + id); });
      }
      for (const x of S.tx) {
        const c = idMap[x.categoryId], a = idMap[x.accountId];
        if (!c && !a) continue;
        const next = Object.assign({}, x, c ? { categoryId: c } : {}, a ? { accountId: a } : {});
        t.objectStore('tx').put(next);
        mark(t, 'tx', x.id, false, now);
        ob.set('tx|' + x.id, true);
      }
      if (rulesChanged) {
        t.objectStore('settings').put({ key: 'merchantRules', value: rules });
        mark(t, 'settings', 'merchantRules', false, now);
        ob.set('settings|merchantRules', true);
      }
      if (idMap[S.settings.account]) t.objectStore('settings').put({ key: 'account', value: idMap[S.settings.account] });

      /* всё локальное, чего в облаке нет, отправится при первой же синхронизации */
      for (const s of ['tx', 'categories', 'accounts']) {
        const rIds = new Set(remote[s].map((r) => r.id));
        for (const x of S[s]) {
          if (drop[s] && drop[s].includes(x.id)) continue;
          if (!rIds.has(x.id) && !ob.has(s + '|' + x.id)) mark(t, s, x.id, false, 1);
        }
      }
      const rKeys = new Set(remote.settings.map((r) => r.id));
      for (const key of SYNCED_SETTINGS) {
        if (S.settings[key] !== undefined && !rKeys.has(key) && !ob.has('settings|' + key)) mark(t, 'settings', key, false, 1);
      }
      t.objectStore('settings').put({ key: 'syncUser', value: user.id });
      t.objectStore('settings').delete('syncCursor');
    });
    await load();
  }

  /* ---------- отправка ---------- */
  async function push() {
    const all = await dbAll('outbox');
    if (!all.length) return;
    const user = session().user;
    for (const table of TABLES) {
      const list = all.filter((o) => o.store === table);
      if (!list.length) continue;
      const local = new Map((await dbAll(table)).map((x) => [idOf(table, x), x]));
      for (let i = 0; i < list.length; i += BATCH) {
        const part = list.slice(i, i + BATCH);
        const rows = part.map((o) => {
          const rec = local.get(o.id);
          const gone = o.deleted || rec === undefined;
          return {
            user_id: user.id, id: o.id, mtime: o.mtime, deleted: gone,
            data: gone ? {} : (table === 'settings' ? { value: rec.value } : rec),
          };
        });
        await rest(table + '?on_conflict=user_id,id', {
          method: 'POST', body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        });
        /* снимаем отметку, только если запись за это время не меняли ещё раз */
        await dbTx(['outbox'], 'readwrite', (t) => {
          const os = t.objectStore('outbox');
          part.forEach((o) => {
            const r = os.get(o.k);
            r.onsuccess = () => { if (r.result && r.result.mtime === o.mtime) os.delete(o.k); };
          });
        });
      }
    }
  }

  /* ---------- получение ---------- */
  async function pull() {
    const cursors = Object.assign({}, S.settings.syncCursor || {});
    const got = {};
    for (const t of TABLES) {
      got[t] = await fetchRows(t, cursors[t]);
      if (got[t].length) cursors[t] = got[t][got[t].length - 1].updated_at;
    }
    const ob = await outboxMap();
    const local = {};
    for (const t of TABLES) local[t] = new Map((await dbAll(t)).map((x) => [idOf(t, x), x]));

    const ops = [];
    for (const t of TABLES) {
      for (const row of got[t]) {
        if (t === 'settings' && !SYNCED_SETTINGS.includes(row.id)) continue;
        const o = ob.get(t + '|' + row.id);
        if (o && o.mtime > row.mtime) continue; /* локальная правка новее, она уйдёт при отправке */
        const cur = local[t].get(row.id);
        if (row.deleted) {
          if (cur !== undefined || o) ops.push({ t, id: row.id, del: true, clear: !!o });
        } else {
          const next = toLocal(t, row);
          if (!same(cur, next) || o) ops.push({ t, id: row.id, put: next, changed: !same(cur, next), clear: !!o });
        }
      }
    }
    const changed = ops.some((x) => x.del || x.changed);
    if (changed && busyUI()) throw new Retry(); /* не меняем данные под открытой формой */
    if (ops.length) {
      await dbTx([...TABLES, 'outbox'], 'readwrite', (tr) => {
        for (const x of ops) {
          if (x.del) tr.objectStore(x.t).delete(x.id); else tr.objectStore(x.t).put(x.put);
          if (x.clear) tr.objectStore('outbox').delete(x.t + '|' + x.id);
        }
      });
    }
    await setLocal('syncCursor', cursors);
    if (changed) {
      await load();
      softRefresh();
    }
  }

  function softRefresh() {
    const a = document.activeElement;
    if (S.tab === 'list' && a && a.id === 'search') { renderAdd(); renderListBody(); } else refresh();
  }

  /* ---------- цикл ---------- */
  async function run() {
    if (!signedIn()) return;
    if (st.running) { st.again = true; return; }
    st.running = true;
    let retry = false;
    paint();
    try {
      await firstMerge();
      if (S.settings.syncUser === session().user.id) {
        await push();
        await pull();
      }
      st.error = ''; st.offline = false;
      await setLocal('syncAt', Date.now());
    } catch (e) {
      if (e instanceof Retry) retry = true;
      else if (e instanceof NetError) st.offline = true;
      else if (e instanceof AuthError) { st.error = e.message; toast(e.message); }
      else { st.offline = false; st.error = 'Не удалось синхронизировать: ' + (e && e.message || 'ошибка'); }
    }
    try { st.pending = (await dbAll('outbox')).length; } catch (e) { /* оставим прежнее число */ }
    st.running = false;
    paint();
    if (retry) kick(3000);
    else if (st.again) kick(300);
    st.again = false;
  }

  function kick(delay) {
    if (!signedIn()) return;
    clearTimeout(kickTimer);
    kickTimer = setTimeout(run, delay === undefined ? 1200 : delay);
  }

  /* ---------- вход, регистрация, пароль ---------- */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function authMessage(e) {
    if (e instanceof NetError) return 'Нет связи с интернетом. Попробуйте ещё раз.';
    const c = e.code || '';
    if (c === 'invalid_credentials') return 'Неверная почта или пароль. Если аккаунта ещё нет, нажмите «Создать аккаунт».';
    if (c === 'email_not_confirmed') return 'Почта ещё не подтверждена. Откройте письмо от Supabase и нажмите ссылку в нём, затем войдите.';
    if (c === 'weak_password') return 'Пароль слишком простой. Нужно не меньше 6 символов.';
    if (c === 'user_already_exists' || c === 'email_exists') return 'Такой аккаунт уже есть. Нажмите «Войти».';
    if (c === 'over_email_send_rate_limit' || e.status === 429) return 'Слишком много попыток. Подождите несколько минут и попробуйте снова.';
    if (c === 'email_address_invalid' || c === 'validation_failed') return 'Проверьте адрес почты.';
    if (c === 'same_password') return 'Новый пароль совпадает со старым.';
    return 'Не получилось: ' + e.message;
  }
  function check(v, needPassword) {
    if (!EMAIL_RE.test(v.email || '')) return 'Введите адрес почты.';
    if (needPassword && (v.password || '').length < 6) return 'Пароль должен быть не короче 6 символов.';
    return '';
  }

  async function afterSignIn(d) {
    await setLocal('syncSession', toSession(d));
    st.error = ''; st.offline = false;
    clearTimeout(kickTimer);
    run();
    refresh();
    toast('Вход выполнен. Синхронизирую…');
  }

  function openAuth(email) {
    openSheet({
      title: 'Облако',
      saveLabel: 'Войти',
      note: 'Данные будут храниться в вашем личном облаке и синхронизироваться между устройствами. Видите их только вы.',
      fields: [
        { name: 'email', label: 'Почта', type: 'email', value: email || S.settings.syncEmail || '', autocomplete: 'username' },
        { name: 'password', label: 'Пароль', type: 'password', value: '', autocomplete: 'current-password' },
      ],
      onSave: async (v) => {
        const bad = check(v, true);
        if (bad) return bad;
        try {
          const d = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: v.email, password: v.password } });
          await setLocal('syncEmail', v.email);
          await afterSignIn(d);
        } catch (e) { return authMessage(e); }
      },
      extras: [
        {
          label: 'Создать аккаунт',
          onClick: async (v) => {
            const bad = check(v, true);
            if (bad) return bad + ' Придумайте пароль и нажмите «Создать аккаунт».';
            try {
              const d = await http('/auth/v1/signup?redirect_to=' + encodeURIComponent(appUrl()), { method: 'POST', body: { email: v.email, password: v.password } });
              await setLocal('syncEmail', v.email);
              if (d && d.access_token) { await afterSignIn(d); return; }
              if (d && Array.isArray(d.identities) && !d.identities.length) return 'Такой аккаунт уже есть. Нажмите «Войти».';
              return 'Письмо отправлено на ' + v.email + '. Нажмите ссылку в письме, вернитесь сюда и нажмите «Войти».';
            } catch (e) { return authMessage(e); }
          },
        },
        {
          label: 'Забыли пароль?',
          onClick: async (v) => {
            const bad = check(v, false);
            if (bad) return bad;
            try {
              await http('/auth/v1/recover?redirect_to=' + encodeURIComponent(appUrl()), { method: 'POST', body: { email: v.email } });
              return 'Письмо для смены пароля отправлено на ' + v.email + '. Откройте ссылку из него.';
            } catch (e) { return authMessage(e); }
          },
        },
      ],
    });
  }

  async function signOut() {
    const s = session();
    if (!s) return;
    const waiting = st.pending;
    if (!confirm(waiting
      ? 'Ещё не отправлено изменений: ' + waiting + '. Они останутся на этом устройстве и уйдут в облако после следующего входа. Выйти?'
      : 'Выйти из облака? Данные останутся на этом устройстве, но перестанут синхронизироваться.')) return;
    clearTimeout(kickTimer);
    http('/auth/v1/logout?scope=local', { method: 'POST', token: s.access_token }).catch(() => {});
    await setLocal('syncSession', undefined);
    st.error = ''; st.offline = false;
    refresh();
    toast('Вы вышли из облака');
  }

  /* Ссылки из писем возвращают на адрес приложения с данными в адресной строке после «#». */
  async function handleLink() {
    const h = location.hash.slice(1);
    if (!/(^|&)(access_token|error_description|error_code)=/.test(h)) return;
    const p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('error_description') || p.get('error_code')) {
      toast(p.get('error_code') === 'otp_expired' ? 'Ссылка из письма устарела. Запросите новую.' : 'Ссылка из письма не сработала');
      return;
    }
    const type = p.get('type');
    if (type === 'recovery') {
      const access = p.get('access_token');
      showTab('settings');
      openSheet({
        title: 'Новый пароль',
        fields: [{ name: 'password', label: 'Новый пароль', type: 'password', value: '', autocomplete: 'new-password' }],
        onSave: async (v) => {
          if ((v.password || '').length < 6) return 'Пароль должен быть не короче 6 символов.';
          try {
            const user = await http('/auth/v1/user', { method: 'PUT', token: access, body: { password: v.password } });
            await afterSignIn({ access_token: access, refresh_token: p.get('refresh_token'), expires_in: p.get('expires_in'), user });
            toast('Пароль изменён');
          } catch (e) { return authMessage(e); }
        },
      });
      return;
    }
    /* подтверждение почты: вход делается отдельно, там, где лежат данные (в установленном приложении) */
    showTab('settings');
    openSheet({
      title: 'Почта подтверждена',
      note: 'Теперь откройте приложение «Расходы» на телефоне, раздел «Ещё», и войдите с этой почтой и паролем. Если хотите пользоваться здесь, в браузере, войдите тут.',
      fields: [],
      saveLabel: 'Войти здесь',
      onSave: async () => { setTimeout(() => openAuth(), 0); return false; },
    });
  }

  /* ---------- вид в разделе «Ещё» ---------- */
  function timeLabel(ms) {
    const d = new Date(ms);
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return dateStr(d) === todayStr() ? 'сегодня в ' + hm : dayLabel(dateStr(d)).replace(/, ..$/, '').toLowerCase() + ' в ' + hm;
  }
  function statusText() {
    if (st.error) return st.error;
    if (st.running) return 'Синхронизирую…';
    if (st.pending) return (st.offline ? 'Нет сети. ' : '') + 'Ждёт отправки: ' + st.pending;
    if (st.offline) return 'Нет сети. Синхронизирую, когда появится';
    return S.settings.syncAt ? 'Синхронизировано ' + timeLabel(S.settings.syncAt) : 'Ещё не синхронизировано';
  }
  function html() {
    const s = session();
    if (!s) {
      return `<button type="button" class="btn" data-cloud="signin">Войти или создать аккаунт</button>
        <p class="hint">Расходы будут сохраняться в вашем личном облаке и появятся на компьютере и других устройствах. Без интернета всё работает как раньше.</p>`;
    }
    return `<div class="card">
        <div class="row"><span class="mid"><span class="t">${esc(s.user.email || 'Аккаунт')}</span><span class="s${st.error ? ' bad' : ''}" id="cloud-status">${esc(statusText())}</span></span></div>
        <button type="button" class="row" data-cloud="now"><span class="mid"><span class="t">Синхронизировать сейчас</span></span></button>
        <button type="button" class="row" data-cloud="signout"><span class="mid"><span class="t">Выйти</span></span></button>
      </div>`;
  }
  function paint() {
    const el = $('cloud-status');
    if (el && signedIn()) { el.textContent = statusText(); el.classList.toggle('bad', !!st.error); return; }
    const box = $('cloud-box');
    if (box) box.innerHTML = html();
  }

  function action(name) {
    if (name === 'now') { st.error = ''; kick(0); }
    else if (name === 'signout') signOut();
    else if (name === 'signin') {
      /* перед самым первым входом предлагаем сохранить копию: так спокойнее */
      if (S.tx.length && !S.settings.syncUser && !S.settings.lastBackupOffer) {
        setLocal('lastBackupOffer', Date.now());
        if (confirm('Перед первой синхронизацией стоит сохранить резервную копию. Сохранить её сейчас?\n\nПосле сохранения нажмите «Войти или создать аккаунт» ещё раз.')) { exportBackup(); return; }
      }
      openAuth();
    }
  }

  function start() {
    handleLink();
    window.addEventListener('online', () => { st.offline = false; kick(0); });
    window.addEventListener('offline', () => { st.offline = true; paint(); });
    setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine !== false) kick(0); }, 60000);
    dbAll('outbox').then((o) => { st.pending = o.length; paint(); }).catch(() => {});
    kick(0);
  }

  return { start, kick, html, action, signedIn };
})();
