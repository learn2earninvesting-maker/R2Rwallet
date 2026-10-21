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
    let m = String(s || '').replace(/\s+/g, ' ').trim();
    if (/^(upi|neft|imps|rtgs|bil|pos|ach)[\/\-]/i.test(m)) m = cleanRef(m) || m;
    if (/^atm[\/\-]/i.test(m)) m = 'ATM Withdrawal';
    if (/^int\.?\s*pd\b|^interest\b|credit interest/i.test(m)) m = 'Interest credit';
    m = m.replace(/\b\d{9,}\b/g, '').replace(/\s{2,}/g, ' ').replace(/[\/\-.,\s]+$/, '').trim();
    return m.length > 45 ? m.slice(0, 45).trim() : m;
  }

  /** Rebuild visual lines from pdf.js text items. Wide gaps become double spaces (column breaks). */
  async function extractLines(pdfjsLib, data, password) {
    const doc = await pdfjsLib.getDocument({ data, password, isEvalSupported: false }).promise;
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const rows = [];
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const x = it.transform[4], y = it.transform[5];
        let r = rows.find(r => Math.abs(r.y - y) < 2.5);
        if (!r) { r = { y, items: [] }; rows.push(r); }
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
      });
      page.cleanup();
    }
    await doc.destroy();
    return lines;
  }

  /** Turn statement lines into transactions. */
  function parseStatement(lines) {
    const text = lines.join('\n');
    // Account statements have withdrawal/deposit/balance columns; check them first, because
    // an account statement can mention "credit card" in a bill-payment line.
    const head = lines.slice(0, 40).join('\n');
    const isAccount = /withdrawals?|deposits?|savings\s+account|current\s+account|statement\s+of\s+account|debit\s+credit\s+balance/i.test(head);
    const isCard = !isAccount && /credit\s*card|card\s*(?:no|number)|minimum\s+amount\s+due|total\s+dues/i.test(text);
    const kind = isCard ? 'card' : 'account';
    const last4 = detectLast4(text);
    const rows = [];
    let prevBal = null, lastRow = null, skipped = 0, opening = null, closing = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (/opening balance|balance b\/f|brought forward/i.test(line)) {
        const a = [...line.matchAll(AMT_RE)]; if (a.length) { prevBal = num(a[a.length - 1][1]); if (opening === null) opening = prevBal; }
        lastRow = null; continue;
      }
      if (/closing balance|balance c\/f|carried forward/i.test(line)) {
        const a = [...line.matchAll(AMT_RE)]; if (a.length) closing = num(a[a.length - 1][1]);
        lastRow = null; continue;
      }
      const dm = DATE_RE.exec(line);
      if (!dm) {
        // a wrapped description line belongs to the row above
        if (lastRow && !SKIP_RE.test(line) && ![...line.matchAll(AMT_RE)].length && line.length < 60 && lastRow.extra < 2) {
          lastRow.raw += ' ' + line; lastRow.extra++;
        }
        continue;
      }
      if (SKIP_RE.test(line)) { lastRow = null; continue; }
      const date = toISO(dm);
      if (!date) { skipped++; continue; }

      let rest = line.slice(dm[0].length);
      const second = SECOND_DATE_RE.exec(rest); if (second) rest = rest.slice(second[0].length);
      const amts = [...rest.matchAll(AMT_RE)];
      if (!amts.length) { skipped++; lastRow = null; continue; }

      const desc = rest.slice(0, amts[0].index).replace(/\s{2,}\S{0,12}\s*$/, m => /\d{5,}/.test(m) ? '' : m).trim();
      if (!/[a-z]{2,}/i.test(desc)) { skipped++; lastRow = null; continue; }

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
        if (prevBal !== null && bal !== null) {
          if (Math.abs(prevBal + amount - bal) < 0.6) dir = 'C';
          else if (Math.abs(prevBal - amount - bal) < 0.6) dir = 'D';
        }
        if (!dir && suffix) dir = /^c/i.test(suffix) ? 'C' : 'D';
        if (!dir) dir = CREDIT_WORDS.test(desc) ? 'C' : 'D';
        if (bal !== null) prevBal = bal;
      }
      if (!(amount > 0)) { skipped++; continue; }
      lastRow = { d: date, raw: desc, a: Math.round(amount * 100) / 100, dir, extra: 0 };
      rows.push(lastRow);
    }

    const out = rows.map(r => ({ d: r.d, m: cleanDesc(r.raw) || 'Statement entry', raw: r.raw.slice(0, 120), a: r.a, dir: r.dir }));
    const debits = out.filter(r => r.dir === 'D').reduce((s, r) => s + r.a, 0);
    const credits = out.filter(r => r.dir === 'C').reduce((s, r) => s + r.a, 0);
    // Self-check for account statements: opening + money in − money out should equal closing.
    let check = 'unknown';
    if (kind === 'account' && opening !== null && closing !== null)
      check = Math.abs(opening + credits - debits - closing) < 1 ? 'balanced' : 'mismatch';
    return { kind, last4, rows: out, skipped, check, opening, closing,
      debits: Math.round(debits * 100) / 100, credits: Math.round(credits * 100) / 100 };
  }

  async function readStatement(pdfjsLib, data, password) {
    const lines = await extractLines(pdfjsLib, data, password);
    return Object.assign(parseStatement(lines), { lineCount: lines.length });
  }

  root.R2RStatement = { extractLines, parseStatement, readStatement, detectLast4 };
})(typeof window !== 'undefined' ? window : globalThis);
