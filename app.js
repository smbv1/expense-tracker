'use strict';

/* ================= хранилище (IndexedDB) ================= */
const DB_NAME = 'expense-tracker';
const STORES = ['tx', 'categories', 'accounts', 'settings'];
let dbp = null;

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tx', { keyPath: 'id' });
      db.createObjectStore('categories', { keyPath: 'id' });
      db.createObjectStore('accounts', { keyPath: 'id' });
      db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function dbTx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Не удалось сохранить данные'));
    out = fn(t);
  });
}
const dbAll = (store) => dbTx([store], 'readonly', (t) => {
  const r = t.objectStore(store).getAll();
  const box = [];
  r.onsuccess = () => box.push(...r.result);
  return box;
});
const dbPut = (store, value) => dbTx([store], 'readwrite', (t) => { t.objectStore(store).put(value); });
const dbDel = (store, key) => dbTx([store], 'readwrite', (t) => { t.objectStore(store).delete(key); });

/* ================= состояние ================= */
const S = {
  tx: [], categories: [], accounts: [], settings: {},
  input: '', date: todayStr(), tab: 'add',
  period: 'month', cursor: todayStr(), listLimit: 150,
};

const DEFAULT_CATEGORIES = [
  ['Продукты', '🛒'], ['Кафе', '🍽️'], ['Транспорт', '🚕'], ['Дом', '🏠'],
  ['Связь', '📱'], ['Здоровье', '💊'], ['Одежда', '👕'], ['Развлечения', '🎬'],
  ['Подарки', '🎁'], ['Красота', '💈'], ['Обучение', '📚'], ['Другое', '📦'],
];
const DEFAULT_ACCOUNTS = ['Наличные', 'МБАНК'];
const DEFAULT_RATE = 87.5;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

async function setSetting(key, value) {
  S.settings[key] = value;
  await dbPut('settings', { key, value });
}

async function load() {
  const [tx, categories, accounts, settings] = await Promise.all(STORES.map(dbAll));
  S.tx = tx; S.categories = categories; S.accounts = accounts;
  S.settings = {};
  for (const s of settings) S.settings[s.key] = s.value;

  if (!S.settings.seeded) {
    if (!S.categories.length) {
      S.categories = DEFAULT_CATEGORIES.map(([name, emoji], i) => ({ id: uid() + i, name, emoji, order: i }));
    }
    if (!S.accounts.length) {
      S.accounts = DEFAULT_ACCOUNTS.map((name, i) => ({ id: uid() + i, name, order: i }));
    }
    await dbTx(['categories', 'accounts', 'settings'], 'readwrite', (t) => {
      S.categories.forEach((c) => t.objectStore('categories').put(c));
      S.accounts.forEach((a) => t.objectStore('accounts').put(a));
      t.objectStore('settings').put({ key: 'seeded', value: true });
      t.objectStore('settings').put({ key: 'usdRate', value: DEFAULT_RATE });
    });
    S.settings.seeded = true;
    S.settings.usdRate = DEFAULT_RATE;
  }
  if (!S.settings.usdRate) S.settings.usdRate = DEFAULT_RATE;
  if (!activeAccounts().some((a) => a.id === S.settings.account)) {
    S.settings.account = (activeAccounts()[0] || {}).id;
  }
  if (S.settings.currency !== 'USD') S.settings.currency = 'KGS';
}

const activeAccounts = () => S.accounts.filter((a) => !a.archived).sort((a, b) => a.order - b.order);
const activeCategories = () => S.categories.filter((c) => !c.archived);
const catById = (id) => S.categories.find((c) => c.id === id) || { name: 'Без категории', emoji: '❔' };
const accById = (id) => S.accounts.find((a) => a.id === id) || { name: 'Без счёта' };

/* Категории: чаще используемые за 60 дней выше, при равенстве — недавние. */
function sortedCategories() {
  const since = dateStr(new Date(Date.now() - 60 * 864e5));
  const count = {}, last = {};
  for (const t of S.tx) {
    if (t.date >= since) count[t.categoryId] = (count[t.categoryId] || 0) + 1;
    if (!last[t.categoryId] || t.ts > last[t.categoryId]) last[t.categoryId] = t.ts;
  }
  return activeCategories().sort((a, b) =>
    (count[b.id] || 0) - (count[a.id] || 0) || (last[b.id] || 0) - (last[a.id] || 0) || a.order - b.order);
}

/* ================= форматирование ================= */
const NBSP = ' ';
function fmt(n) {
  const neg = n < 0; n = Math.abs(round2(n));
  let [i, f] = n.toFixed(2).split('.');
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return (neg ? '−' : '') + i + (f === '00' ? '' : ',' + f);
}
const curSign = (c) => (c === 'USD' ? '$' : 'с');
const money = (n, c) => fmt(n) + NBSP + curSign(c);
function parseNum(s) {
  const n = parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function dayLabel(s) {
  const today = todayStr();
  if (s === today) return 'Сегодня';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (s === dateStr(y)) return 'Вчера';
  const d = parseDate(s);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear();
  return d.getDate() + ' ' + MONTHS_GEN[d.getMonth()] + year + ', ' + WEEKDAYS[d.getDay()];
}
function sumKgs(list) { return round2(list.reduce((a, t) => a + t.amountKgs, 0)); }

const $ = (id) => document.getElementById(id);

/* ================= экран ввода ================= */
function renderAdd() {
  $('accounts').innerHTML = activeAccounts().map((a) =>
    `<button type="button" class="chip${a.id === S.settings.account ? ' on' : ''}" role="radio" aria-checked="${a.id === S.settings.account}" data-acc="${esc(a.id)}">${esc(a.name)}</button>`
  ).join('') + '<button type="button" class="chip add" data-acc-add aria-label="Добавить счёт">+ счёт</button>';

  document.querySelectorAll('#currency button').forEach((b) => {
    const on = b.dataset.cur === S.settings.currency;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on);
  });

  $('cats').innerHTML = sortedCategories().map((c) =>
    `<button type="button" class="cat" data-cat="${esc(c.id)}"><span class="em">${esc(c.emoji || '•')}</span><span class="nm">${esc(c.name)}</span></button>`
  ).join('');

  const isToday = S.date === todayStr();
  $('date-label').textContent = isToday ? 'Сегодня' : dayLabel(S.date).replace(/, ..$/, '');
  $('date-chip').classList.toggle('other', !isToday);
  $('date-input').value = S.date;
  $('date-input').max = todayStr();

  const tt = sumKgs(S.tx.filter((t) => t.date === todayStr()));
  $('today-total').textContent = tt ? 'Сегодня потрачено ' + money(tt, 'KGS') : '';
  renderAmount();
}

function renderAmount() {
  const usd = S.settings.currency === 'USD';
  const raw = S.input;
  let shown = '0';
  if (raw) {
    const [i, f] = raw.split(',');
    shown = (i || '0').replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + (raw.includes(',') ? ',' + (f || '') : '');
  }
  $('amount-num').textContent = shown;
  $('amount-cur').textContent = curSign(S.settings.currency);
  const el = $('amount');
  el.classList.toggle('zero', !raw);
  el.classList.toggle('usd', usd);
  el.classList.toggle('long', shown.length > 8);
  const rl = $('rate-line');
  rl.hidden = !usd;
  if (usd) {
    const n = parseNum(raw) || 0;
    rl.textContent = (n ? '≈ ' + money(n * S.settings.usdRate, 'KGS') + ', ' : '') + 'курс ' + fmt(S.settings.usdRate);
  }
}

function pressKey(k) {
  let v = S.input;
  if (k === 'back') v = v.slice(0, -1);
  else if (k === ',') { if (!v.includes(',')) v = (v || '0') + ','; }
  else {
    const [i, f] = v.split(',');
    if (v.includes(',')) { if (f.length >= 2) return; }
    else if (i.length >= 9) return;
    v = v === '0' ? k : v + k;
  }
  S.input = v;
  renderAmount();
}

async function saveQuick(categoryId) {
  const amount = round2(parseNum(S.input));
  if (!(amount > 0)) {
    const el = $('amount');
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    toast('Сначала введите сумму');
    return;
  }
  const currency = S.settings.currency;
  const rate = currency === 'USD' ? S.settings.usdRate : 1;
  const t = {
    id: uid(), amount, currency, rate, amountKgs: round2(amount * rate),
    categoryId, accountId: S.settings.account, date: S.date, ts: Date.now(),
    note: $('note').value.trim(),
  };
  try {
    await dbPut('tx', t);
  } catch (e) {
    toast('Не сохранилось: ' + (e && e.message || 'ошибка хранилища'));
    return;
  }
  S.tx.push(t);
  S.input = '';
  $('note').value = '';
  $('note').blur();
  renderAdd();
  toast('Сохранено: ' + money(amount, currency) + ', ' + catById(categoryId).name, 'Отменить', async () => {
    await dbDel('tx', t.id);
    S.tx = S.tx.filter((x) => x.id !== t.id);
    S.input = String(amount).replace('.', ',');
    renderAdd();
    toast('Расход отменён');
  });
}

/* ================= плашка ================= */
let toastTimer = 0;
function toast(text, actionLabel, action) {
  const el = $('toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (actionLabel) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = actionLabel;
    b.onclick = () => { el.hidden = true; action(); };
    el.appendChild(b);
  }
  el.hidden = true; void el.offsetWidth; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 5000 : 2200);
}

/* ================= форма в выезжающей панели ================= */
let sheetCtx = null;
function openSheet({ title, fields, saveLabel, onSave, deleteLabel, onDelete }) {
  sheetCtx = { fields, onSave, onDelete };
  const html = [`<h3>${esc(title)}</h3>`];
  const one = (f) => {
    let control;
    if (f.type === 'select') {
      control = `<select name="${f.name}">` + f.options.map(([v, l]) =>
        `<option value="${esc(v)}"${v === f.value ? ' selected' : ''}>${esc(l)}</option>`).join('') + '</select>';
    } else {
      const attrs = f.type === 'decimal' ? 'type="text" inputmode="decimal"' : f.type === 'date' ? `type="date" max="${todayStr()}"` : 'type="text"';
      control = `<input name="${f.name}" ${attrs} value="${esc(f.value)}" autocomplete="off"${f.maxlength ? ` maxlength="${f.maxlength}"` : ''}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>`;
    }
    return `<label class="field"><span>${esc(f.label)}</span>${control}</label>`;
  };
  for (const f of fields) {
    html.push(Array.isArray(f) ? `<div class="two">${f.map(one).join('')}</div>` : one(f));
  }
  html.push('<div class="err" id="sheet-err" hidden></div>');
  html.push(`<button class="btn" type="submit">${esc(saveLabel || 'Сохранить')}</button>`);
  if (onDelete) html.push(`<button class="btn danger" type="button" data-sheet-delete>${esc(deleteLabel || 'Удалить')}</button>`);
  html.push('<button class="btn light" type="button" data-sheet-close>Отмена</button>');
  $('sheet').innerHTML = html.join('');
  $('sheet-back').hidden = false;
}
function closeSheet() { $('sheet-back').hidden = true; sheetCtx = null; }
function sheetError(msg) { const e = $('sheet-err'); e.textContent = msg; e.hidden = false; }

$('sheet').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!sheetCtx) return;
  const values = {};
  new FormData($('sheet')).forEach((v, k) => { values[k] = String(v).trim(); });
  const err = await sheetCtx.onSave(values);
  if (err) sheetError(err); else closeSheet();
});
$('sheet-back').addEventListener('click', async (ev) => {
  if (ev.target === $('sheet-back') || ev.target.closest('[data-sheet-close]')) return closeSheet();
  if (ev.target.closest('[data-sheet-delete]') && sheetCtx) {
    const done = await sheetCtx.onDelete();
    if (done !== false) closeSheet();
  }
});

/* ================= операции ================= */
function txSorted() {
  return S.tx.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts));
}
function txRow(t) {
  const c = catById(t.categoryId);
  const sub = [accById(t.accountId).name, t.note].filter(Boolean).join(', ');
  const usd = t.currency === 'USD';
  return `<button type="button" class="row" data-tx="${esc(t.id)}">
    <span class="em">${esc(c.emoji || '•')}</span>
    <span class="mid"><span class="t">${esc(c.name)}</span><span class="s">${esc(sub)}</span></span>
    <span class="sum">${usd ? money(t.amount, 'USD') : money(t.amount, 'KGS')}${usd ? `<small>${money(t.amountKgs, 'KGS')}</small>` : ''}</span>
  </button>`;
}
function renderList() {
  const v = $('view-list');
  const all = txSorted();
  if (!all.length) {
    v.innerHTML = '<h1>Операции</h1><div class="empty"><b>Пока пусто</b>Введите сумму на вкладке «Ввод» и нажмите категорию. Расход появится здесь.</div>';
    return;
  }
  const totals = {};
  for (const t of all) totals[t.date] = (totals[t.date] || 0) + t.amountKgs;
  const shown = all.slice(0, S.listLimit);
  const out = ['<h1>Операции</h1>'];
  let day = null;
  for (const t of shown) {
    if (t.date !== day) {
      if (day !== null) out.push('</div>');
      day = t.date;
      out.push(`<div class="day-head"><span>${esc(dayLabel(day))}</span><b>${money(totals[day], 'KGS')}</b></div><div class="card">`);
    }
    out.push(txRow(t));
  }
  out.push('</div>');
  if (all.length > shown.length) out.push('<p></p><button type="button" class="btn light" data-more>Показать ещё</button>');
  v.innerHTML = out.join('');
}

function editTx(id) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  const cats = S.categories.filter((c) => !c.archived || c.id === t.categoryId).sort((a, b) => a.order - b.order);
  const accs = S.accounts.filter((a) => !a.archived || a.id === t.accountId).sort((a, b) => a.order - b.order);
  openSheet({
    title: 'Изменить расход',
    fields: [
      [{ name: 'amount', label: 'Сумма', type: 'decimal', value: String(t.amount).replace('.', ',') },
       { name: 'currency', label: 'Валюта', type: 'select', value: t.currency, options: [['KGS', 'Сом'], ['USD', 'Доллар']] }],
      { name: 'rate', label: 'Курс доллара (нужен только для расходов в $)', type: 'decimal', value: String(t.currency === 'USD' ? t.rate : S.settings.usdRate).replace('.', ',') },
      [{ name: 'categoryId', label: 'Категория', type: 'select', value: t.categoryId, options: cats.map((c) => [c.id, (c.emoji ? c.emoji + ' ' : '') + c.name]) },
       { name: 'accountId', label: 'Счёт', type: 'select', value: t.accountId, options: accs.map((a) => [a.id, a.name]) }],
      { name: 'date', label: 'Дата', type: 'date', value: t.date },
      { name: 'note', label: 'Заметка', type: 'text', value: t.note || '', maxlength: 120 },
    ],
    onSave: async (v) => {
      const amount = round2(parseNum(v.amount));
      if (!(amount > 0)) return 'Введите сумму больше нуля.';
      let rate = 1;
      if (v.currency === 'USD') {
        rate = parseNum(v.rate);
        if (!(rate > 0)) return 'Введите курс доллара, например 87,5.';
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return 'Выберите дату.';
      const next = Object.assign({}, t, {
        amount, currency: v.currency, rate, amountKgs: round2(amount * rate),
        categoryId: v.categoryId, accountId: v.accountId, date: v.date, note: v.note,
      });
      await dbPut('tx', next);
      S.tx[S.tx.indexOf(t)] = next;
      refresh();
      toast('Изменения сохранены');
    },
    deleteLabel: 'Удалить расход',
    onDelete: async () => {
      await dbDel('tx', t.id);
      S.tx = S.tx.filter((x) => x.id !== t.id);
      refresh();
      toast('Расход удалён', 'Вернуть', async () => {
        await dbPut('tx', t);
        S.tx.push(t);
        refresh();
      });
    },
  });
}

/* ================= итоги ================= */
function shiftCursor(dir) {
  const d = parseDate(S.cursor);
  if (S.period === 'month') { d.setDate(1); d.setMonth(d.getMonth() + dir); }
  else d.setDate(d.getDate() + dir);
  S.cursor = dateStr(d);
  if (S.cursor > todayStr()) S.cursor = todayStr();
  renderStats();
}
function renderStats() {
  const v = $('view-stats');
  const cur = parseDate(S.cursor);
  const today = todayStr();
  let list, label, atEnd;
  if (S.period === 'month') {
    const prefix = S.cursor.slice(0, 7);
    list = S.tx.filter((t) => t.date.startsWith(prefix));
    label = MONTHS[cur.getMonth()] + ' ' + cur.getFullYear();
    label = label[0].toUpperCase() + label.slice(1);
    atEnd = prefix === today.slice(0, 7);
  } else {
    list = S.tx.filter((t) => t.date === S.cursor);
    label = dayLabel(S.cursor);
    atEnd = S.cursor === today;
  }
  const total = sumKgs(list);
  const usd = round2(list.filter((t) => t.currency === 'USD').reduce((a, t) => a + t.amount, 0));
  let sub = list.length ? plural(list.length, ['расход', 'расхода', 'расходов']) : '';
  if (usd) sub += ', из них в долларах ' + money(usd, 'USD');
  if (S.period === 'month' && total) {
    const days = atEnd ? new Date().getDate() : new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
    sub += ', в среднем ' + money(Math.round(total / days), 'KGS') + ' в день';
  }

  const group = (key, nameOf) => {
    const m = new Map();
    for (const t of list) m.set(t[key], (m.get(t[key]) || 0) + t.amountKgs);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id, sum]) => {
      const pct = total ? (sum / total) * 100 : 0;
      return `<div class="bar-row"><div class="bar-top"><span class="t">${esc(nameOf(id))}</span><span class="v">${money(sum, 'KGS')}<small>${Math.round(pct)}%</small></span></div><div class="bar"><i style="width:${Math.max(pct, 1.5).toFixed(1)}%"></i></div></div>`;
    }).join('');
  };

  v.innerHTML = `
    <div class="period">
      <div class="seg" role="radiogroup" aria-label="Период">
        <button type="button" data-period="day" class="${S.period === 'day' ? 'on' : ''}">День</button>
        <button type="button" data-period="month" class="${S.period === 'month' ? 'on' : ''}">Месяц</button>
      </div>
    </div>
    <div class="nav">
      <button type="button" data-shift="-1" aria-label="Раньше">‹</button>
      <span class="lbl">${esc(label)}</span>
      <button type="button" data-shift="1" aria-label="Позже"${atEnd ? ' disabled' : ''}>›</button>
    </div>
    <div class="total">${fmt(total)}<span class="cur">с</span></div>
    <div class="total-sub">${esc(sub)}</div>
    ${list.length ? `
      <h2>По категориям</h2>
      <div class="card">${group('categoryId', (id) => { const c = catById(id); return (c.emoji ? c.emoji + ' ' : '') + c.name; })}</div>
      <h2>По счетам</h2>
      <div class="card">${group('accountId', (id) => accById(id).name)}</div>
    ` : `<div class="empty"><b>Расходов нет</b>${S.period === 'month' ? 'За этот месяц ничего не записано.' : 'За этот день ничего не записано.'}</div>`}
  `;
}
function plural(n, forms) {
  const a = n % 10, b = n % 100;
  return n + ' ' + (a === 1 && b !== 11 ? forms[0] : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? forms[1] : forms[2]);
}

/* ================= настройки ================= */
function renderSettings() {
  const v = $('view-settings');
  const last = S.settings.lastBackup;
  const stale = S.tx.length && (!last || Date.now() - last > 14 * 864e5);
  const lastText = last ? 'Последняя копия: ' + dayLabel(dateStr(new Date(last))).toLowerCase() + '.' : 'Копию ещё не делали.';
  v.innerHTML = `
    <h1>Настройки</h1>

    <h2>Курс доллара</h2>
    <div class="card">
      <button type="button" class="row" data-rate>
        <span class="mid"><span class="t">1 $ = ${fmt(S.settings.usdRate)} сом</span><span class="s">Применяется к новым расходам в долларах</span></span>
        <span class="chev">Изменить</span>
      </button>
    </div>

    <h2>Счета</h2>
    <div class="card">
      ${activeAccounts().map((a) => `<button type="button" class="row" data-edit-acc="${esc(a.id)}"><span class="mid"><span class="t">${esc(a.name)}</span></span><span class="chev">Изменить</span></button>`).join('')}
      <button type="button" class="row" data-acc-add><span class="mid"><span class="t">+ Добавить счёт или банк</span></span></button>
    </div>

    <h2>Категории</h2>
    <div class="card">
      ${activeCategories().sort((a, b) => a.order - b.order).map((c) => `<button type="button" class="row" data-edit-cat="${esc(c.id)}"><span class="em">${esc(c.emoji || '•')}</span><span class="mid"><span class="t">${esc(c.name)}</span></span><span class="chev">Изменить</span></button>`).join('')}
      <button type="button" class="row" data-cat-add><span class="mid"><span class="t">+ Добавить категорию</span></span></button>
    </div>

    <h2>Резервная копия</h2>
    ${stale ? '<div class="warn">Данные хранятся только в этом телефоне. Сохраните копию, чтобы не потерять их.</div>' : ''}
    <button type="button" class="btn" data-export>Сохранить копию в файл</button>
    <button type="button" class="btn light" data-import>Восстановить из файла</button>
    <p class="hint">${esc(lastText)} Файл удобно класть в «Файлы» или iCloud Drive. Записей в приложении: ${S.tx.length}.</p>
  `;
}

function editRate() {
  openSheet({
    title: 'Курс доллара',
    fields: [{ name: 'rate', label: 'Сколько сомов за 1 доллар', type: 'decimal', value: String(S.settings.usdRate).replace('.', ',') }],
    onSave: async (v) => {
      const r = parseNum(v.rate);
      if (!(r > 0)) return 'Введите число, например 87,5.';
      await setSetting('usdRate', round2(r));
      refresh();
      toast('Курс обновлён. Старые расходы не пересчитываются');
    },
  });
}

function editAccount(id) {
  const a = id ? S.accounts.find((x) => x.id === id) : null;
  openSheet({
    title: a ? 'Счёт' : 'Новый счёт',
    saveLabel: a ? 'Сохранить' : 'Добавить счёт',
    fields: [{ name: 'name', label: 'Название', type: 'text', value: a ? a.name : '', maxlength: 24, placeholder: 'Например, Оптима Банк' }],
    onSave: async (v) => {
      if (!v.name) return 'Введите название счёта.';
      if (activeAccounts().some((x) => x !== a && x.name.toLowerCase() === v.name.toLowerCase())) return 'Счёт с таким названием уже есть.';
      if (a) { a.name = v.name; await dbPut('accounts', a); }
      else {
        const n = { id: uid(), name: v.name, order: Math.max(-1, ...S.accounts.map((x) => x.order)) + 1 };
        await dbPut('accounts', n);
        S.accounts.push(n);
        await setSetting('account', n.id);
      }
      refresh();
    },
    deleteLabel: 'Удалить счёт',
    onDelete: a ? async () => {
      if (activeAccounts().length <= 1) { sheetError('Должен остаться хотя бы один счёт.'); return false; }
      const used = S.tx.some((t) => t.accountId === a.id);
      if (!confirm(used ? `Удалить счёт «${a.name}»? Прошлые расходы по нему останутся в истории.` : `Удалить счёт «${a.name}»?`)) return false;
      if (used) { a.archived = true; await dbPut('accounts', a); }
      else { await dbDel('accounts', a.id); S.accounts = S.accounts.filter((x) => x !== a); }
      if (S.settings.account === a.id) await setSetting('account', activeAccounts()[0].id);
      refresh();
    } : null,
  });
}

function editCategory(id) {
  const c = id ? S.categories.find((x) => x.id === id) : null;
  openSheet({
    title: c ? 'Категория' : 'Новая категория',
    saveLabel: c ? 'Сохранить' : 'Добавить категорию',
    fields: [
      { name: 'name', label: 'Название', type: 'text', value: c ? c.name : '', maxlength: 20, placeholder: 'Например, Бензин' },
      { name: 'emoji', label: 'Значок (эмодзи)', type: 'text', value: c ? c.emoji : '', maxlength: 8, placeholder: '⛽' },
    ],
    onSave: async (v) => {
      if (!v.name) return 'Введите название категории.';
      if (activeCategories().some((x) => x !== c && x.name.toLowerCase() === v.name.toLowerCase())) return 'Такая категория уже есть.';
      if (c) { c.name = v.name; c.emoji = v.emoji; await dbPut('categories', c); }
      else {
        const n = { id: uid(), name: v.name, emoji: v.emoji, order: Math.max(-1, ...S.categories.map((x) => x.order)) + 1 };
        await dbPut('categories', n);
        S.categories.push(n);
      }
      refresh();
    },
    deleteLabel: 'Удалить категорию',
    onDelete: c ? async () => {
      if (activeCategories().length <= 1) { sheetError('Должна остаться хотя бы одна категория.'); return false; }
      const used = S.tx.some((t) => t.categoryId === c.id);
      if (!confirm(used ? `Удалить категорию «${c.name}»? Прошлые расходы по ней останутся в истории.` : `Удалить категорию «${c.name}»?`)) return false;
      if (used) { c.archived = true; await dbPut('categories', c); }
      else { await dbDel('categories', c.id); S.categories = S.categories.filter((x) => x !== c); }
      refresh();
    } : null,
  });
}

/* ================= резервная копия ================= */
async function exportBackup() {
  const data = {
    app: 'expense-tracker', version: 1, exportedAt: new Date().toISOString(),
    settings: { usdRate: S.settings.usdRate },
    accounts: S.accounts, categories: S.categories, tx: S.tx,
  };
  const name = 'rashody-' + todayStr() + '.json';
  const json = JSON.stringify(data, null, 1);
  let done = false;
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      done = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  if (!done) {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  await setSetting('lastBackup', Date.now());
  renderSettings();
  toast('Копия сохранена: ' + name);
}

function validBackup(d) {
  const okTx = (t) => t && typeof t.id === 'string' && typeof t.amount === 'number' && t.amount > 0 &&
    typeof t.amountKgs === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && (t.currency === 'KGS' || t.currency === 'USD');
  const okNamed = (x) => x && typeof x.id === 'string' && typeof x.name === 'string';
  return d && d.app === 'expense-tracker' && Array.isArray(d.tx) && Array.isArray(d.accounts) && Array.isArray(d.categories) &&
    d.accounts.length > 0 && d.categories.length > 0 && d.tx.every(okTx) && d.accounts.every(okNamed) && d.categories.every(okNamed);
}

async function importBackup(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { d = null; }
  if (!validBackup(d)) { toast('Это не файл копии этого приложения'); return; }
  const msg = `В файле ${plural(d.tx.length, ['расход', 'расхода', 'расходов'])}. ` +
    (S.tx.length ? `Сейчас в приложении ${S.tx.length}. Текущие данные будут заменены данными из файла. Продолжить?` : 'Восстановить?');
  if (!confirm(msg)) return;
  const rate = d.settings && d.settings.usdRate > 0 ? d.settings.usdRate : S.settings.usdRate;
  await dbTx(STORES, 'readwrite', (t) => {
    for (const s of ['tx', 'accounts', 'categories']) {
      const os = t.objectStore(s);
      os.clear();
      d[s].forEach((x, i) => os.put(s === 'tx' ? Object.assign({ ts: 0, rate: 1, note: '' }, x) : Object.assign({ order: i }, x)));
    }
    t.objectStore('settings').put({ key: 'usdRate', value: rate });
    t.objectStore('settings').put({ key: 'lastBackup', value: Date.now() });
  });
  await load();
  refresh();
  toast('Данные восстановлены');
}

/* ================= навигация и события ================= */
function refresh() {
  renderAdd();
  if (S.tab === 'list') renderList();
  if (S.tab === 'stats') renderStats();
  if (S.tab === 'settings') renderSettings();
}
function showTab(tab) {
  S.tab = tab;
  for (const name of ['add', 'list', 'stats', 'settings']) $('view-' + name).hidden = name !== tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'list') S.listLimit = 150;
  if (tab === 'stats') S.cursor = todayStr();
  refresh();
  if (tab !== 'add') $('view-' + tab).scrollTop = 0;
}

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});
$('keypad').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (b) pressKey(b.dataset.k);
});
/* удержание «стереть» очищает сумму целиком */
let holdTimer = 0;
$('keypad').addEventListener('pointerdown', (e) => {
  if (e.target.closest('[data-k="back"]')) holdTimer = setTimeout(() => { S.input = ''; renderAmount(); }, 500);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('keypad').addEventListener(ev, () => clearTimeout(holdTimer));

$('cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (b) saveQuick(b.dataset.cat);
});
$('accounts').addEventListener('click', async (e) => {
  if (e.target.closest('[data-acc-add]')) return editAccount(null);
  const b = e.target.closest('[data-acc]');
  if (b) { await setSetting('account', b.dataset.acc); renderAdd(); }
});
$('currency').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cur]');
  if (b) { await setSetting('currency', b.dataset.cur); renderAdd(); }
});
$('rate-line').addEventListener('click', editRate);
$('date-input').addEventListener('change', (e) => {
  const v = e.target.value;
  S.date = v && v <= todayStr() ? v : todayStr();
  renderAdd();
});
$('note').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

$('view-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-tx]');
  if (row) return editTx(row.dataset.tx);
  if (e.target.closest('[data-more]')) { S.listLimit += 300; renderList(); }
});
$('view-stats').addEventListener('click', (e) => {
  const p = e.target.closest('[data-period]');
  if (p) { S.period = p.dataset.period; S.cursor = todayStr(); return renderStats(); }
  const s = e.target.closest('[data-shift]');
  if (s && !s.disabled) shiftCursor(Number(s.dataset.shift));
});
$('view-settings').addEventListener('click', (e) => {
  const t = e.target;
  let m;
  if (t.closest('[data-rate]')) editRate();
  else if (t.closest('[data-acc-add]')) editAccount(null);
  else if ((m = t.closest('[data-edit-acc]'))) editAccount(m.dataset.editAcc);
  else if (t.closest('[data-cat-add]')) editCategory(null);
  else if ((m = t.closest('[data-edit-cat]'))) editCategory(m.dataset.editCat);
  else if (t.closest('[data-export]')) exportBackup();
  else if (t.closest('[data-import]')) $('import-file').click();
});
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await importBackup(f);
});

/* при возврате в приложение на следующий день дата снова «сегодня» */
let lastSeenDay = todayStr();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (todayStr() !== lastSeenDay) { lastSeenDay = todayStr(); S.date = lastSeenDay; }
  refresh();
});

(async function start() {
  try {
    await load();
  } catch (e) {
    document.body.innerHTML = '<div class="empty"><b>Не удалось открыть хранилище</b>Если включён «Частный доступ» в Safari, выключите его и откройте приложение снова.</div>';
    return;
  }
  showTab('add');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
