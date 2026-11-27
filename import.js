'use strict';

/* ================= импорт выписки МБАНК (.xls) =================
   Файл разбирается на устройстве и никуда не отправляется. */

/* ---------- разбор таблицы ---------- */
const MB = {};

MB.num = (s) => {
  const n = parseFloat(String(s == null ? '' : s).replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/* rows — массив строк таблицы, каждая строка — массив ячеек-строк */
MB.parseRows = (rows) => {
  let currency = '';
  let head = -1;
  for (let i = 0; i < rows.length && i < 60; i++) {
    const first = String(rows[i][0] || '').trim();
    const m = first.match(/^Валюта:\s*([A-Z]{3})/i);
    if (m) currency = m[1].toUpperCase();
    if (first === 'Дата' && rows[i].some((c) => String(c).trim() === 'Дебет')) { head = i; break; }
  }
  if (head < 0) throw new Error('В файле не найдена таблица операций. Нужна выписка МБАНК в формате Excel (.xls).');
  const col = (name) => rows[head].findIndex((c) => String(c).trim() === name);
  const cDate = 0, cWho = col('Получатель/Плательщик'), cDeb = col('Дебет'), cCred = col('Кредит'), cOp = col('Операция');
  if (cDeb < 0 || cOp < 0) throw new Error('В таблице нет столбцов «Дебет» и «Операция».');

  const ops = [];
  for (let i = head + 1; i < rows.length; i++) {
    const r = rows[i];
    const m = String(r[cDate] || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
    if (!m) continue;
    ops.push({
      date: `${m[3]}-${m[2]}-${m[1]}`,
      time: m[4] ? `${m[4]}:${m[5]}` : '00:00',
      who: cWho >= 0 ? String(r[cWho] || '').trim() : '',
      debit: MB.num(r[cDeb]),
      credit: cCred >= 0 ? MB.num(r[cCred]) : 0,
      op: String(r[cOp] || '').trim(),
    });
  }
  return { currency: currency || 'KGS', ops };
};

/* ---------- что это за операция ---------- */
MB.clean = (s) => String(s || '')
  .replace(/\\"/g, '"').replace(/""/g, '"')
  .replace(/^["«\s]+|["»\s]+$/g, '')
  .replace(/^(VTS\s+|GTS\*\s*|IP\s+|ИП\s+|OsOO\s+|ОсОО\s+)/i, '')
  .replace(/^["«\s]+|["»\s]+$/g, '')
  .replace(/\s+/g, ' ').trim()
  .replace(/^([^"]*)"([^"]*)$/, '$1$2');

/* возвращает { skip: 'причина' } или { merchant, kind: 'purchase' | 'transfer' | 'fee' } */
MB.describe = (o) => {
  const op = o.op;
  if (!(o.debit > 0)) return { skip: /возврат/i.test(op) ? 'возврат' : 'зачисление' };
  if (/^Перевод между счетами/i.test(op)) return { skip: 'между своими счетами' };
  if (/^Комиссия/i.test(op)) return { merchant: 'Комиссия банка', kind: 'fee' };
  if (/^Перевод по номеру телефона/i.test(op)) return { merchant: 'Перевод: ' + (o.who || 'по номеру телефона'), kind: 'transfer' };

  let m = op.match(/^QR\/(.+?)\/\d{4}-\d{2}-\d{2}[ T]/);
  if (m) return { merchant: MB.clean(m[1]), kind: 'purchase' };

  m = op.match(/^Оплата услуг\. Получатель: (.+?)\.\s+(.*)$/);
  if (m) {
    const to = m[1].trim();
    const third = (m[2].split(' ')[0].split('/')[2] || '').trim();
    if (/^Перевод по QR/i.test(to)) return { merchant: 'Перевод по QR' + (third ? ': ' + third : ''), kind: 'transfer' };
    if (/Тулпар/i.test(to)) return { merchant: 'Тулпар, проезд', kind: 'purchase' };
    if (/^Оплата по QR/i.test(to)) {
      const tail = m[2].replace(/\s+[0-9a-f]{8}-[0-9a-f-]{20,}.*$/i, '');
      const name = (tail.split('/')[2] || '').replace(/\.{3}$/, '').trim();
      return { merchant: MB.clean(name) || to, kind: 'purchase' };
    }
    return { merchant: MB.clean(to), kind: 'purchase' };
  }

  if (op.includes('\\')) {
    const parts = op.split('\\').map((p) => p.trim()).filter(Boolean);
    const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return { merchant: MB.clean(name) || 'Оплата картой', kind: 'purchase' };
  }
  return { merchant: MB.clean(op).slice(0, 60) || 'Операция', kind: 'purchase' };
};

/* ---------- категория по названию продавца ---------- */
MB.RULES = [
  ['Переводы', /^перевод/i],
  ['Транспорт', /taxi|такси|yandex\.?\s?go|тулпар|tulpar|scooter|namba|bakai\s?bus|\bazs\b|газпром|gazprom|бензин|parking|парков/i],
  ['Подписки', /apple\.com|yandex\.?\s?plus|anthropic|claude|openai|chatgpt|netflix|spotify|youtube|google|icloud|telegram/i],
  ['Кафе', /coffee|кофе|kafe|cafe|кафе|pits|pizza|пицц|glovo|yandex\.?\s?eda|чайхана|нават|navat|kfc|burger|бургер|restoran|ресторан|столовая|sushi|суши|lanzhou|karlson|doner|донер|shaurma|шаурма|bakery|пекарн/i],
  ['Здоровье', /apteka|аптека|lekar|pharm|фарм|(^|\s)фм(\s|$)|\bfm\b|neman|неман|clinic|клиник|medcent|медцентр|стомат|dent/i],
  ['Продукты', /globus|глобус|gipermarket|гипермаркет|market|маркет|магазин|narodn|народн|frunze|фрунзе|produkt|продукт|aziya|азия|begemot|sheker|myasn|мясн/i],
  ['Связь', /megacom|мегаком|beeline|билайн|nur\s?telecom|saima|сайма|aknet|акнет|jet\b|интернет/i],
  ['Дом', /коммунал|электр|северэлектро|бишкекгаз|водоканал|тепло|тазалык|аренда|kvartplata/i],
  ['Одежда', /wildberries|lc\s?waikiki|zara|adidas|nike|odezhda|одежда|obuv|обувь/i],
];
MB.NEW_CATEGORIES = { 'Переводы': '🔁', 'Подписки': '🔄' };

MB.key = (merchant) => merchant.toLowerCase().replace(/\s+\d+$/, '').replace(/[^a-zа-яё0-9]+/gi, ' ').trim();

MB.guessCategoryName = (merchant, kind) => {
  if (kind === 'transfer') return 'Переводы';
  if (kind === 'fee') return 'Другое';
  for (const [name, re] of MB.RULES) if (re.test(merchant)) return name;
  return 'Другое';
};

/* короткий устойчивый отпечаток строки выписки, чтобы не импортировать её дважды */
MB.hash = (s) => {
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) + (h2 << 3);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

/* из разобранной выписки — список кандидатов на импорт и сводка пропущенного */
MB.buildItems = (parsed) => {
  const items = [];
  const skipped = {};
  const seen = {};
  for (const o of parsed.ops) {
    const d = MB.describe(o);
    if (d.skip) { skipped[d.skip] = (skipped[d.skip] || 0) + 1; continue; }
    const base = `${o.date} ${o.time}|${o.debit.toFixed(2)}|${o.op}`;
    seen[base] = (seen[base] || 0) + 1;
    items.push({
      date: o.date, time: o.time, amount: o.debit, merchant: d.merchant, kind: d.kind,
      mkey: MB.key(d.merchant), importKey: 'mb' + MB.hash(base) + '#' + seen[base],
    });
  }
  return { currency: parsed.currency, items, skipped };
};

if (typeof module !== 'undefined') module.exports = MB;

/* ================= экран импорта (только в браузере) ================= */
if (typeof document !== 'undefined') (function () {
  let ctx = null; // { currency, items, skipped, already, accountId }

  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.core.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Не удалось загрузить модуль чтения Excel. Откройте приложение один раз с интернетом.'));
      document.head.appendChild(s);
    });
  }

  const catByName = (name) => S.categories.find((c) => !c.archived && c.name.toLowerCase() === name.toLowerCase());

  async function start(file) {
    try {
      toast('Читаю выписку…');
      await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      const built = MB.buildItems(MB.parseRows(rows));
      if (built.currency !== 'KGS' && built.currency !== 'USD') throw new Error('Счёт в валюте ' + built.currency + ' пока не поддерживается, только сом и доллар.');
      prepare(built);
    } catch (e) {
      toast(e && e.message ? e.message : 'Не получилось прочитать файл');
    }
  }

  function prepare(built) {
    const have = new Set(S.tx.map((t) => t.importKey).filter(Boolean));
    const rules = S.settings.merchantRules || {};
    const all = built.items;
    const items = all.filter((it) => !have.has(it.importKey));
    const manual = S.tx.filter((t) => !t.importKey && t.currency === built.currency);
    for (const it of items) {
      const ruled = rules[it.mkey] && S.categories.find((c) => c.id === rules[it.mkey] && !c.archived);
      const guess = MB.guessCategoryName(it.merchant, it.kind);
      const existing = catByName(guess);
      it.cat = ruled ? ruled.id : existing ? existing.id : MB.NEW_CATEGORIES[guess] ? 'new:' + guess : (catByName('Другое') || activeCategories()[0]).id;
      it.dup = manual.some((t) => t.date === it.date && Math.abs(t.amount - it.amount) < 0.005);
      it.on = !it.dup;
    }
    const mb = activeAccounts().find((a) => /м\s?банк|mbank/i.test(a.name));
    ctx = {
      currency: built.currency, items, skipped: built.skipped, already: all.length - items.length,
      accountId: (mb || accById(S.settings.account) || activeAccounts()[0]).id,
    };
    if (!items.length) {
      ctx = null;
      toast(all.length ? 'Все расходы из этой выписки уже импортированы' : 'В выписке нет списаний');
      return;
    }
    render();
    $('toast').hidden = true;
    $('import-view').hidden = false;
    $('import-list').scrollTop = 0;
  }

  function catOptions(selected) {
    const cats = activeCategories().sort((a, b) => a.order - b.order);
    const extra = Object.keys(MB.NEW_CATEGORIES).filter((n) => !catByName(n));
    return cats.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc((c.emoji ? c.emoji + ' ' : '') + c.name)}</option>`).join('') +
      extra.map((n) => `<option value="new:${esc(n)}"${'new:' + n === selected ? ' selected' : ''}>${esc(MB.NEW_CATEGORIES[n] + ' ' + n)} (новая)</option>`).join('');
  }

  function render() {
    const sk = Object.entries(ctx.skipped).map(([k, n]) => `${k}: ${n}`);
    if (ctx.already) sk.unshift('уже импортировано: ' + ctx.already);
    $('import-info').textContent = `Найдено ${plural(ctx.items.length, ['расход', 'расхода', 'расходов'])}.` + (sk.length ? ' Пропущено: ' + sk.join(', ') + '.' : '');
    $('import-account').innerHTML = activeAccounts().map((a) => `<option value="${esc(a.id)}"${a.id === ctx.accountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
    $('import-list').innerHTML = ctx.items.map((it, i) => {
      const d = it.date.slice(8, 10) + '.' + it.date.slice(5, 7);
      return `<div class="imp-row${it.on ? '' : ' off'}" data-i="${i}">
        <label class="imp-check"><input type="checkbox" data-i="${i}"${it.on ? ' checked' : ''} aria-label="Импортировать ${esc(it.merchant)}"><i></i></label>
        <div class="mid"><span class="t">${esc(it.merchant)}</span><span class="s">${d}, ${it.time}${it.dup ? ', <b>возможно, уже введён вручную</b>' : ''}</span></div>
        <div class="sum">${money(it.amount, ctx.currency)}</div>
        <select data-i="${i}" aria-label="Категория">${catOptions(it.cat)}</select>
      </div>`;
    }).join('');
    renderFooter();
  }

  function renderFooter() {
    const on = ctx.items.filter((it) => it.on);
    const sum = on.reduce((a, it) => a + it.amount, 0);
    const btn = $('import-save');
    btn.disabled = !on.length;
    btn.textContent = on.length ? `Импортировать ${on.length} на ${money(sum, ctx.currency)}` : 'Ничего не выбрано';
    $('import-toggle').textContent = on.length === ctx.items.length ? 'Снять все' : 'Выбрать все';
  }

  function close() { $('import-view').hidden = true; ctx = null; }

  async function save() {
    const on = ctx.items.filter((it) => it.on);
    if (!on.length) return;
    const btn = $('import-save');
    btn.disabled = true;
    try {
      /* новые категории создаются, только если реально выбраны */
      const created = {};
      const newCats = [];
      let order = Math.max(-1, ...S.categories.map((c) => c.order));
      for (const it of ctx.items) {
        if (!String(it.cat).startsWith('new:')) continue;
        const name = it.cat.slice(4);
        if (!created[name] && it.on) {
          const c = { id: uid(), name, emoji: MB.NEW_CATEGORIES[name] || '', order: ++order };
          created[name] = c.id;
          newCats.push(c);
        }
      }
      const rate = ctx.currency === 'USD' ? S.settings.usdRate : 1;
      const rules = Object.assign({}, S.settings.merchantRules || {});
      const txs = on.map((it) => {
        const categoryId = String(it.cat).startsWith('new:') ? created[it.cat.slice(4)] : it.cat;
        if (it.kind === 'purchase') rules[it.mkey] = categoryId;
        const [y, m, d] = it.date.split('-').map(Number);
        const [hh, mm] = it.time.split(':').map(Number);
        return {
          id: uid(), amount: round2(it.amount), currency: ctx.currency, rate, amountKgs: round2(it.amount * rate),
          categoryId, accountId: ctx.accountId, date: it.date, ts: new Date(y, m - 1, d, hh, mm).getTime(),
          note: it.merchant, importKey: it.importKey,
        };
      });
      await dbTx(['tx', 'categories', 'settings', 'outbox'], 'readwrite', (t) => {
        newCats.forEach((c) => { t.objectStore('categories').put(c); mark(t, 'categories', c.id); });
        txs.forEach((x) => { t.objectStore('tx').put(x); mark(t, 'tx', x.id); });
        t.objectStore('settings').put({ key: 'merchantRules', value: rules });
        mark(t, 'settings', 'merchantRules');
      });
      syncKick();
      S.categories.push(...newCats);
      S.tx.push(...txs);
      S.settings.merchantRules = rules;
      close();
      showTab('list');
      toast('Импортировано: ' + plural(txs.length, ['расход', 'расхода', 'расходов']));
    } catch (e) {
      btn.disabled = false;
      toast('Не сохранилось: ' + (e && e.message || 'ошибка хранилища'));
    }
  }

  $('import-list').addEventListener('change', (e) => {
    const i = Number(e.target.dataset.i);
    const it = ctx && ctx.items[i];
    if (!it) return;
    if (e.target.type === 'checkbox') {
      it.on = e.target.checked;
      e.target.closest('.imp-row').classList.toggle('off', !it.on);
    } else {
      /* та же категория для всех строк этого продавца в выписке */
      const list = $('import-list');
      ctx.items.forEach((x, j) => {
        if (x.mkey !== it.mkey || x.kind !== it.kind) return;
        x.cat = e.target.value;
        const sel = list.querySelector(`select[data-i="${j}"]`);
        if (sel) sel.value = x.cat;
      });
    }
    renderFooter();
  });
  $('import-account').addEventListener('change', (e) => { if (ctx) ctx.accountId = e.target.value; });
  $('import-toggle').addEventListener('click', () => {
    const all = ctx.items.every((it) => it.on);
    ctx.items.forEach((it) => { it.on = !all; });
    render();
  });
  $('import-cancel').addEventListener('click', close);
  $('import-save').addEventListener('click', save);
  $('statement-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) start(f);
  });
})();
