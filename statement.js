/* R2R Money — statement reader.
 * Opens a (password-protected) bank or credit-card statement PDF on the user's own device,
 * rebuilds its text lines and pulls out the transactions. Nothing here talks to any server.
 */
(function (root) {
  'use strict';

  const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
  const DATE_RE = new RegExp(
    '^(?:\\d{1,4}\\s+)?' +                                         // optional serial number
    '(?:(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{2,4})' +        // 15/09/2026, 15-09-26
    '|(\\d{1,2})[\\s\\-]?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\\s\\-,]*(\\d{2,4}))' + // 15 Sep 2026, 15-Sep-26
    '(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[ap]m\\b)?)?', 'i');
  const SECOND_DATE_RE = /^\s*(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}[\s\-]?(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\s\-,]*\d{2,4})/i;
  const AMT_RE = /(?:₹|rs\.?|inr)?\s*((?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})(?:\s*(cr|dr|c|d)\b)?/gi;
  const SKIP_RE = /opening balance|closing balance|previous (?:statement )?balance|total (?:amount )?dues?|minimum (?:amount )?due|payment due|credit limit|available (?:credit|cash)|cash limit|statement (?:date|period)|reward|points|grand total|^\s*total\b|page \d+ of|brought forward|carried forward|b\/f|c\/f/i;
  const CREDIT_WORDS = /\b(salary|refund|reversal|reversed|cashback|int\.?\s*pd|interest|by transfer|neft cr|imps cr|credit interest|dividend|payment received|thank you)\b/i;

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(m) {
    let d, mo, y;
    if (m[1]) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else { d = +m[4]; mo = MON[m[5].toLowerCase().slice(0, m[5].toLowerCase().startsWith('sept') ? 4 : 3)] || MON[m[5].toLowerCase().slice(0,3)]; y = +m[6]; }
    if (y < 100) y += 2000;
    if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2000 && y <= 2100)) return null;
    return y + '-' + pad(mo) + '-' + pad(d);
  }
  const num = s => parseFloat(String(s).replace(/,/g, ''));

  function detectLast4(text) {
    const m = /[x*•]{2,}\s*(\d{4})\b/i.exec(text) ||
      /(?:card\s*(?:no|number)\.?|a\/c\s*(?:no\.?)?|account\s*(?:no\.?|number)?)\s*[:\-]?\s*(?:\d{4}\s+)?(?:[x*•]+\s*)*(\d{4})\b/i.exec(text);
    return m ? m[1] : '';
  }

  function cleanRef(s) {
    const parts = String(s).split(/[\/\-|]/).map(p => p.trim()).filter(Boolean);
    const skip = /^(upi|p2m|p2a|neft|imps|rtgs|mb|ib|pos|ecom|ref|txn|ach|nach|cr|dr|na|bil|onl|atm|cash wdl)$/i;
    for (const p of parts) {
      if (skip.test(p)) continue;
      if (/^[a-z0-9]{0,4}\d{5,}$/i.test(p)) continue;
      if (/[a-z]{3,}/i.test(p)) return p;
    }
    return '';
  }
  function cleanDesc(s) {
    let m = String(s || '').replace(/\s+/g, ' ').trim()
      .replace(/\b(mobile banking|net banking|internet banking|branch|imobile)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (/\bw\.?\s*tax\.?\s*pd\b|\btds\b/i.test(m)) return 'TDS on interest';
    if (/\bint\.?\s*pd\b/i.test(m)) return 'Interest credit';
    // ICICI style: the payee's name is printed above the reference ("UBER INDIA UPI/UBER INDIA/...")
    const pre = /^(.*?[a-z].*?)\s+(?:upi|neft|imps|rtgs|mmt|bil|ach|nach|inf|pos)\//i.exec(m);
    if (pre && !/[\/@]/.test(pre[1])) m = pre[1];
    if (/^(upi|neft|imps|rtgs|bil|pos|ach|mmt)[\/\-]/i.test(m)) m = cleanRef(m) || m;
    if (/^atm[\/\-]/i.test(m)) m = 'ATM Withdrawal';
    if (/^int\.?\s*pd\b|^interest\b|credit interest/i.test(m)) m = 'Interest credit';
    m = m.replace(/\b\d{9,}\b/g, '').replace(/\s{2,}/g, ' ').replace(/[\/\-.,\s]+$/, '').trim();
    return m.length > 45 ? m.slice(0, 45).trim() : m;
  }

  /** Rebuild visual lines from pdf.js text items. Wide gaps become double spaces (column breaks). */
  async function extractLines(pdfjsLib, data, password) {
    const doc = await pdfjsLib.getDocument({ data, password, isEvalSupported: false }).promise;
    const lines = [], pos = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const x = it.transform[4], y = it.transform[5];
        let r = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!r) { r = { y, items: [], h: Math.abs(it.transform[3]) || it.height || 10 }; rows.push(r); }
        r.items.push({ x, w: it.width || 0, s: it.str });
      });
      rows.sort((a, b) => b.y - a.y).forEach(r => {
        r.items.sort((a, b) => a.x - b.x);
        let out = '', end = null;
        r.items.forEach(i => {
          if (end !== null) { const gap = i.x - end; out += gap > 12 ? '  ' : gap > 1 ? ' ' : ''; }
          out += i.s; end = i.x + i.w;
        });
        lines.push(out.replace(/[ \t]+$/, ''));
        pos.push({ p, y: r.y, h: r.h || 10 });
      });
      page.cleanup();
    }
    await doc.destroy();
    lines.pos = pos;
    return lines;
  }

  /** Turn statement lines into transactions. */
  // A new account section, e.g. ICICI "Statement of transactions in Savings Account XXXXXXXX5386 ..."
  const SECTION_RE = /(?:statement of (?:transactions|account)|transactions?\s+(?:in|for)|account\s+statement).{0,60}?(?:account|a\/c)\b.{0,25}?[x*•]{2,}\s*(\d{3,4})\b/i;
  const HEADER_RE = /\b(date|txn date|value date)\b.*\b(particulars|narration|description|details|remarks)\b|\b(particulars|narration|description)\b.*\b(withdrawals?|deposits?|debit|credit|balance)\b/i;
  const OPEN_ROW_RE = /^\W*(b\/f|bal(?:ance)?\s*b\/f|opening\s+balance|brought\s+forward)\b/i;

  function parseStatement(lines) {
    const pos = Array.isArray(lines.pos) && lines.pos.length === lines.length ? lines.pos : null;
    const text = lines.join('\n');
    // Account statements have withdrawal/deposit/balance columns; check them first, because
    // an account statement can mention "credit card" in a bill-payment line.
    const head = lines.slice(0, 60).join('\n');
    const isAccount = /withdrawals?|deposits?|savings\s+account|current\s+account|statement\s+of\s+account|debit\s+credit\s+balance/i.test(head);
    const isCard = !isAccount && /credit\s*card|card\s*(?:no|number)|minimum\s+amount\s+due|total\s+dues/i.test(text);
    const kind = isCard ? 'card' : 'account';
    const docLast4 = detectLast4(text);

    const sections = [];
    let sec = null;
    const newSection = (last4) => { sec = { last4: last4 || docLast4, opening: null, closing: null, closingFixed: false, prevBal: null, rows: [] }; sections.push(sec); };
    newSection(docLast4);

    // items: in reading order, either a transaction row, a loose text line, or a barrier
    const items = [];
    let skipped = 0;
    const barrier = () => items.push({ t: 'bar' });

    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const at = pos ? pos[i] : null;

      const sm = SECTION_RE.exec(line);
      if (sm) {
        // A heading for a second account starts a fresh section (first heading just names the first one).
        if (sec.rows.length || sec.opening !== null) newSection(sm[1]); else sec.last4 = sm[1];
        barrier(); return;
      }
      if (/cumulative/i.test(line)) { barrier(); return; }           // e.g. ICICI TDS summary
      if (HEADER_RE.test(line) && ![...line.matchAll(AMT_RE)].length) { barrier(); return; }

      if (/opening balance|balance b\/f|brought forward/i.test(line) && !DATE_RE.test(line)) {
        const a = [...line.matchAll(AMT_RE)];
        if (a.length) { sec.prevBal = num(a[a.length - 1][1]); if (sec.opening === null) sec.opening = sec.prevBal; }
        barrier(); return;
      }
      if (/closing balance|balance c\/f|carried forward/i.test(line)) {
        const a = [...line.matchAll(AMT_RE)]; if (a.length) { sec.closing = num(a[a.length - 1][1]); sec.closingFixed = true; }
        barrier(); return;
      }
      // "Total:" rows may be per-page subtotals (ICICI); the last one carries the closing balance.
      if (/^\s*(?:grand\s+|page\s+|sub\s*)?total\b/i.test(line)) {
        const a = [...line.matchAll(AMT_RE)].map(x => num(x[1]));
        if (kind === 'account' && a.length >= 3 && !sec.closingFixed) sec.closing = a[a.length - 1];
        barrier(); return;
      }

      const dm = DATE_RE.exec(line);
      if (!dm) {
        const hasAmt = [...line.matchAll(AMT_RE)].length > 0;
        if (!hasAmt && !SKIP_RE.test(line) && line.length < 130 && /[a-z0-9]/i.test(line)) items.push({ t: 'loose', s: line, at, sec });
        else barrier();
        return;
      }
      const date = toISO(dm);
      if (!date) { skipped++; barrier(); return; }
      let rest = line.slice(dm[0].length);
      const second = SECOND_DATE_RE.exec(rest); if (second) rest = rest.slice(second[0].length);

      // Opening balance row with a date, e.g. "01-09-2026  B/F  67,768.60"
      if (OPEN_ROW_RE.test(rest.trim())) {
        const a = [...rest.matchAll(AMT_RE)];
        if (a.length) { sec.prevBal = num(a[a.length - 1][1]); if (sec.opening === null) sec.opening = sec.prevBal; }
        barrier(); return;
      }
      if (SKIP_RE.test(line)) { barrier(); return; }
      const amts = [...rest.matchAll(AMT_RE)];
      if (!amts.length) { skipped++; barrier(); return; }

      // Text before the first amount. It may be empty when the bank prints the description
      // on lines above and below the date (ICICI); those lines are attached further down.
      let desc = rest.slice(0, amts[0].index).replace(/\s{2,}\S{0,12}\s*$/, m => /\d{5,}/.test(m) ? '' : m).trim();
      if (!/[a-z]{2,}/i.test(desc)) desc = '';

      let amount, dir;
      if (kind === 'card') {
        const a = amts[amts.length - 1];
        amount = num(a[1]);
        dir = (a[2] && /^c/i.test(a[2])) || /\bcr\b/i.test(rest.slice(a.index)) ? 'C' : 'D';
      } else {
        const vals = amts.map(a => num(a[1]));
        const bal = vals.length >= 2 ? vals[vals.length - 1] : null;
        const cands = vals.length >= 2 ? vals.slice(0, -1).filter(v => v > 0) : vals;
        amount = cands[cands.length - 1];
        const suffix = amts[vals.length >= 2 ? amts.length - 2 : 0][2];
        if (sec.prevBal !== null && bal !== null) {
          if (Math.abs(sec.prevBal + amount - bal) < 0.6) dir = 'C';
          else if (Math.abs(sec.prevBal - amount - bal) < 0.6) dir = 'D';
        }
        if (!dir && suffix) dir = /^c/i.test(suffix) ? 'C' : 'D';
        if (!dir) dir = CREDIT_WORDS.test(desc) ? 'C' : 'D';
        if (bal !== null) sec.prevBal = bal;
      }
      if (!(amount > 0)) { skipped++; barrier(); return; }
      const row = { d: date, own: desc, above: [], below: [], a: Math.round(amount * 100) / 100, dir, at, sec };
      sec.rows.push(row);
      items.push({ t: 'row', row });
    });

    // Attach each loose text line to the transaction it belongs to.
    items.forEach((it, k) => {
      if (it.t !== 'loose') return;
      let prev = null, next = null;
      for (let j = k - 1; j >= 0; j--) { if (items[j].t === 'bar') break; if (items[j].t === 'row') { prev = items[j].row; break; } }
      for (let j = k + 1; j < items.length; j++) { if (items[j].t === 'bar') break; if (items[j].t === 'row') { next = items[j].row; break; } }
      if (prev && prev.sec !== it.sec) prev = null;
      if (next && next.sec !== it.sec) next = null;
      let target = null;
      if (pos && it.at) {
        // Nearest row on the same page, by vertical distance (ties go to the row above).
        const lim = 3.5 * (it.at.h || 10);
        const dist = r => (r && r.at && r.at.p === it.at.p) ? Math.abs(r.at.y - it.at.y) : Infinity;
        const dp = dist(prev), dn = dist(next);
        if (Math.min(dp, dn) <= lim) target = dn < dp - 0.5 ? next : prev;
      } else if (prev && prev.below.length < 2) {
        target = prev;                       // no positions: old rule, wrapped line belongs to the row above
      }
      if (!target) return;
      if (target === next) target.above.push(it.s); else target.below.push(it.s);
    });

    const rows = [];
    sections.forEach(sc => sc.rows.forEach(r => {
      const raw = [...r.above, r.own, ...r.below].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      rows.push({ d: r.d, m: cleanDesc(raw) || 'Statement entry', raw: raw.slice(0, 160), a: r.a, dir: r.dir, l4: sc.last4 || '' });
    }));

    const sum = (list, dir) => Math.round(list.filter(r => r.dir === dir).reduce((s, r) => s + r.a, 0) * 100) / 100;
    const secOut = sections.filter(sc => sc.rows.length).map(sc => {
      const debits = Math.round(sc.rows.filter(r => r.dir === 'D').reduce((s, r) => s + r.a, 0) * 100) / 100;
      const credits = Math.round(sc.rows.filter(r => r.dir === 'C').reduce((s, r) => s + r.a, 0) * 100) / 100;
      // Self-check: opening + money in − money out = closing (and the bank's own totals, when printed).
      let check = 'unknown';
      if (kind === 'account' && sc.opening !== null && sc.closing !== null) {
        check = Math.abs(sc.opening + credits - debits - sc.closing) < 1 ? 'balanced' : 'mismatch';
      }
      return { last4: sc.last4 || '', count: sc.rows.length, debits, credits, opening: sc.opening, closing: sc.closing, check };
    });
    // The rows array keeps section order; give each section its own slice.
    let at = 0;
    secOut.forEach(sc => { sc.rows = rows.slice(at, at + sc.count); at += sc.count; });

    const checks = secOut.map(s => s.check);
    const check = checks.includes('mismatch') ? 'mismatch' : (checks.length && checks.every(c => c === 'balanced')) ? 'balanced' : 'unknown';
    // Account holder's name (e.g. "MR.MANUEL LAWRENCE PINTO"), so transfers to your own accounts can be recognised.
    let holder = '';
    for (const l of lines.slice(0, 40)) {
      const h = /^\s*(?:mr|mrs|ms|miss|dr|smt|shri)\.?\s*([a-z][a-z .]{4,60}?)\s*$/i.exec(l);
      if (h && h[1].trim().split(/\s+/).length >= 2) { holder = h[1].replace(/\s+/g, ' ').trim(); break; }
    }
    return { kind, holder, last4: (secOut[0] && secOut[0].last4) || docLast4, rows, sections: secOut, skipped, check,
      opening: secOut[0] ? secOut[0].opening : null, closing: secOut[0] ? secOut[0].closing : null,
      debits: sum(rows, 'D'), credits: sum(rows, 'C') };
  }

  async function readStatement(pdfjsLib, data, password) {
    const lines = await extractLines(pdfjsLib, data, password);
    return Object.assign(parseStatement(lines), { lineCount: lines.length });
  }

  root.R2RStatement = { extractLines, parseStatement, readStatement, detectLast4, cleanDesc };
})(typeof window !== 'undefined' ? window : globalThis);
