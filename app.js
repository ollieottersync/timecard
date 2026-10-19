'use strict';
/*
 * Delta Pay Audit — personal, local-first pay reconciliation engine + UI.
 *
 * All parsing/reconciliation logic lives in the PayAudit namespace and is
 * environment-agnostic: it runs in the browser (UI at the bottom of this
 * file) and under Node (validation harness). No network calls are made.
 * Documents are stored only in browser localStorage by the UI layer.
 *
 * Rules implemented (verified against real Jan–Mar 2026 documents):
 *  - Time-card summary buckets replicate the deterministic re-bucketing
 *    verified against Widget Crew output (see project brief).
 *  - PWA 3.G.1 advance = 1/2 x reserve guarantee x base rate, where the
 *    guarantee = ALV - 2:00, floored at 72:00, capped at 80:00.
 *  - Reroute pay postings per SRH: L.4 premium posts inside the rotation
 *    (PAS "REROUTE CREDIT", aggregated on the card as ASTERISK PAY);
 *    L.8 posts as an ADJ-RRPY adjustment. Anything whose composition
 *    cannot be derived from the documents is flagged, never guessed.
 */
const PayAudit = (() => {

  /* ---------------- time / money helpers ---------------- */

  // '84:38' or '-9:21' -> minutes (int) or null
  function hmToMin(s) {
    if (s === null || s === undefined) return null;
    s = String(s).trim();
    if (!s) return null;
    let neg = false;
    if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
    const m = s.match(/^(\d+):(\d{2})$/);
    if (!m) return null;
    const v = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    return neg ? -v : v;
  }
  // minutes -> '84:38' / '-9:21'
  function minToHM(min) {
    if (min === null || min === undefined || isNaN(min)) return '—';
    const neg = min < 0;
    const a = Math.abs(Math.round(min));
    return (neg ? '-' : '') + Math.floor(a / 60) + ':' + String(a % 60).padStart(2, '0');
  }
  // iCrew rotation displays use H.MM ('34.46' = 34h 46m) -> minutes
  function dotToMin(s) {
    if (s === null || s === undefined) return null;
    const m = String(s).trim().match(/^(\d+)\.(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  // '$ 55,245.67' / '-$3,700.07' / '2044.84' -> number or null
  function moneyToNum(s) {
    if (s === null || s === undefined) return null;
    const v = parseFloat(String(s).replace(/[$,\s]/g, ''));
    return isNaN(v) ? null : v;
  }
  function fmtMoney(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    const neg = v < 0;
    return (neg ? '-$' : '$') + Math.abs(v).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function round2(v) { return Math.round(v * 100) / 100; }

  /* ---------------- dates ---------------- */
  const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  // '01JAN26' -> {y, m, d}
  function parseDLDate(s) {
    const m = String(s).trim().match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m || !MONTHS[m[2]]) return null;
    return { y: 2000 + parseInt(m[3], 10), m: MONTHS[m[2]], d: parseInt(m[1], 10) };
  }
  // 'March 1, 2026' -> {y, m, d}
  function parseLongDate(s) {
    const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (!m) return null;
    const mi = MONTH_NAMES.indexOf(m[1]);
    if (mi < 0) return null;
    return { y: parseInt(m[3], 10), m: mi + 1, d: parseInt(m[2], 10) };
  }
  // '01/30/2026' -> {y, m, d}
  function parseUSDate(s) {
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return { y: parseInt(m[3], 10), m: parseInt(m[1], 10), d: parseInt(m[2], 10) };
  }
  function iso(dt) {
    return dt.y + '-' + String(dt.m).padStart(2, '0') + '-' + String(dt.d).padStart(2, '0');
  }
  function addDays(dt, n) {
    const t = new Date(Date.UTC(dt.y, dt.m - 1, dt.d) + n * 86400000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  // Delta bid months are named for the month the period mostly covers;
  // period start + 15 days lands in the bid month for all observed periods.
  function bidMonthOf(dt) {
    const t = addDays(dt, 15);
    return t.y + '-' + String(t.m).padStart(2, '0');
  }
  function bidMonthLabel(bm) {
    const p = String(bm).split('-');
    return MONTH_NAMES[parseInt(p[1], 10) - 1] + ' ' + p[0];
  }

  /* ---------------- CSV ---------------- */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    const s = String(text).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /* ---------------- document type detection ---------------- */
  function detectType(text) {
    const t = String(text || '');
    if (/Pilot Activity Statement/i.test(t) ||
        (/Pay Period:\s*,\s*\d{4}\s+[A-Z]{3}/.test(t) && /TOTAL AMOUNT PAID/.test(t))) return 'pas';
    if (/DISPLAY PILOT PAY STATEMENT/.test(t)) return 'statement';
    if (/MONTHLY TIME DATA/.test(t) && /BID PERIOD:/.test(t)) return 'timecard';
    if (/ROTATION DISPLAY/.test(t)) return 'rotation';
    if (/Check Date:/.test(t) && /Semi-Monthly/.test(t) && /Emp ID:/.test(t)) return 'stub';
    return 'unknown';
  }

  /* ---------------- iCrew time card ----------------
   * Line-item columns are fixed-width, values right-aligned:
   *   BLOCK ends ~col 30, SKED ~40, PAY ~50, CREDIT ~60, ADDTL PAY ONLY ~69.
   * Tokens are assigned to a column by their end offset in the raw line.
   */
  function colOf(endIdx) {
    if (endIdx <= 32) return 'block';
    if (endIdx <= 42) return 'sked';
    if (endIdx <= 52) return 'pay';
    if (endIdx <= 62) return 'credit';
    return 'addtl';
  }

  function parseTimecard(text) {
    const lines = String(text).split('\n');
    const card = { type: 'timecard', lines: [] };
    let m = text.match(/BID PERIOD:\s*(\d{2}[A-Z]{3}\d{2})\s*-\s*(\d{2}[A-Z]{3}\d{2})/);
    if (m) {
      card.periodStart = parseDLDate(m[1]);
      card.periodEnd = parseDLDate(m[2]);
      card.bidMonth = bidMonthOf(card.periodStart);
    }
    m = text.match(/BID PERIOD:[^\n]*?([A-Z]{3}\s\d{3}\s[A-Z])\b/);
    if (m) card.category = m[1];
    m = text.match(/TEMP IN BANK\s+BANK ADJ\s+IN BANK\s+ALV\s*\n\s*(\d+:\d+)\s+(\d+:\d+)\s+(\d+:\d+)\s+(\d+:\d+)/);
    if (m) {
      card.tempInBank = hmToMin(m[1]); card.bankAdj = hmToMin(m[2]);
      card.inBank = hmToMin(m[3]); card.alv = hmToMin(m[4]);
    }
    // --- line items ---
    let inItems = false;
    for (const raw of lines) {
      if (/DATE\s+DES\s+NBR/.test(raw)) { inItems = true; continue; }
      if (inItems && /^\s*RES\s+OTHER/.test(raw)) inItems = false;
      if (!inItems) continue;
      const lm = raw.match(/^\s*(\d{2}[A-Z]{3})\s+(REG|RES)\s+(\S+)\s*(.*)$/);
      if (!lm) continue;
      const item = { date: lm[1], des: lm[2], rot: lm[3], block: null, sked: null, pay: null, credit: null, addtl: null, trans: false };
      const restStart = raw.length - lm[4].length;
      const tokRe = /\S+/g; let tm;
      const rest = lm[4];
      while ((tm = tokRe.exec(rest)) !== null) {
        const end = restStart + tm.index + tm[0].length;
        const col = colOf(end);
        if (tm[0] === 'TRANS') { item.trans = true; if (col === 'sked' || col === 'pay') item[col] = 'TRANS'; continue; }
        const v = hmToMin(tm[0]);
        if (v !== null) item[col] = v;
      }
      card.lines.push(item);
    }
    // --- footer credit row ---
    m = text.match(/(\d+:\d+)\s*\+\s*(\d+:\d+)\s*\+\s*(\d+:\d+)\s*=\s*(\d+:\d+)\s*-\s*(\d+:\d+)\s*\+\s*(\d+:\d+)\s*=\s*(\d+:\d+)\s+(\d+:\d+)/);
    if (m) {
      card.footer = {
        credit: hmToMin(m[1]), resGuar: hmToMin(m[2]), otherGuar: hmToMin(m[3]),
        subTtlCredit: hmToMin(m[4]), paybackNegBank: hmToMin(m[5]),
        bankOptAwd: hmToMin(m[6]), ttlCredit: hmToMin(m[7]), bankOptLimit: hmToMin(m[8])
      };
    }
    // --- bank award block (values line follows the two header lines) ---
    for (let i = 0; i < lines.length - 2; i++) {
      if (/BANK DEP/.test(lines[i]) && /AWARD/.test(lines[i + 1])) {
        const vm = lines[i + 2].match(/^\s*(\d+:\d+)\s+(\d+:\d+)\s+(\d+:\d+)\s+(\d+:\d+)\s*$/);
        if (vm) {
          card.bankDepAward = hmToMin(vm[1]);
          card.ttlBankOptsAward = hmToMin(vm[2]);
          card.gslipCredit = hmToMin(vm[3]);
          card.outBank = hmToMin(vm[4]);
        }
        break;
      }
    }
    // --- slip / premium footer pays ---
    const grab = (re) => { const g = text.match(re); return g ? hmToMin(g[1]) : null; };
    card.gsPay = grab(/G\/SLIP PAY :\s*(\d+:\d+)/);
    card.iaqPay = grab(/IA\/Q-SLIP PAY:\s*(\d+:\d+)/);
    card.resAssignPay = grab(/RES ASSIGN-G\/Q SLIP PAY:\s*(\d+:\d+)/);
    card.asteriskPay = grab(/ASTERISK PAY:\s*(\d+:\d+)/);
    card.resLookBack = grab(/RES LOOK BACK GUAR\s*:\s*(\d+:\d+)/);
    card.ssPay = grab(/S\/SLIP PAY :\s*(\d+:\d+)/);
    card.pbsPrPay = grab(/PBS\/PR PAY :\s*(\d+:\d+)/);
    // --- bank deposit request row (request vs award) ---
    m = text.match(/BANK DEPOSIT\s+(\d+:\d+)\s+(\d+:\d+)/);
    if (m) card.bankRequest = { requested: hmToMin(m[1]), awarded: hmToMin(m[2]) };
    // --- vacation bank ---
    m = text.match(/VAC TIME IN\s+VAC DAYS IN\s+VAC PAYOFF\s+VAC TIME OUT\s+VAC DAYS OUT\s*\n\s*(\d+:\d+)\s+(\d+)\s+(\d+:\d+)\s+(\d+:\d+)\s+(\d+)/);
    if (m) {
      card.vacIn = { time: hmToMin(m[1]), days: parseInt(m[2], 10) };
      card.vacPayoff = hmToMin(m[3]);
      card.vacOut = { time: hmToMin(m[4]), days: parseInt(m[5], 10) };
    }
    // --- distributed training pay lines ---
    card.trainingPay = 0;
    const trRe = /DISTRIBUTED TRNG PAY:\s*(\d+:\d+)/g; let tg;
    while ((tg = trRe.exec(text)) !== null) card.trainingPay += hmToMin(tg[1]);
    card.summary = summarizeCard(card);
    return card;
  }

  /* Bucket rules (verified against Widget Crew summaries, Jan–Mar 2026):
   *  Credit        = card footer CREDIT (line CREDIT column sums to it)
   *  RES Guarantee = card footer RES GUAR
   *  Other Guar.   = card footer OTHER GUAR
   *  Pay No Credit = PAY TIME of lines with no CREDIT entry (RRPY adjustments,
   *                  SCC short calls, pay-without-credit rotation lines)
   *  Pay Only      = ADDTL PAY ONLY column total (EDP/SIT/CARVE-type add-ons)
   *  Reroute       = footer ASTERISK PAY (the card's aggregate reroute-pay line)
   *  GS Pay        = footer G/SLIP PAY + IA/Q-SLIP PAY
   *  SS Pay        = footer S/SLIP PAY
   *  Vacation      = PAY of VAC lines
   *  Training      = DISTRIBUTED TRNG PAY footer notes
   *  Subtotal = sum of buckets; Total = Subtotal - Bank Deposit Award
   */
  function summarizeCard(card) {
    const f = card.footer || {};
    let lineCredit = 0, pnc = 0, payOnly = 0, vacation = 0;
    for (const it of card.lines) {
      if (it.credit !== null && it.credit !== 'TRANS') lineCredit += it.credit;
      if (it.addtl !== null) payOnly += it.addtl;
      if (it.rot === 'VAC') { if (it.pay !== null) vacation += it.pay; }
      else if ((it.credit === null || it.credit === 'TRANS') && it.pay !== null && it.pay !== 'TRANS') pnc += it.pay;
    }
    const s = {
      credit: (f.credit !== undefined && f.credit !== null) ? f.credit : lineCredit,
      lineCredit: lineCredit,
      creditMatchesFooter: (f.credit === undefined || f.credit === null) ? null : (lineCredit === f.credit),
      resGuar: f.resGuar || 0,
      otherGuar: f.otherGuar || 0,
      payNoCredit: pnc,
      payOnly: payOnly,
      rerouteAsterisk: card.asteriskPay || 0,
      gsPay: (card.gsPay || 0) + (card.iaqPay || 0),
      ssPay: card.ssPay || 0,
      vacation: vacation,
      training: card.trainingPay || 0,
      pbsPr: card.pbsPrPay || 0,
      bankDeposit: card.bankDepAward || 0
    };
    s.subtotal = s.credit + s.resGuar + s.otherGuar + s.payNoCredit + s.payOnly +
      s.rerouteAsterisk + s.gsPay + s.ssPay + s.vacation + s.training + s.pbsPr;
    s.total = s.subtotal - s.bankDeposit;
    return s;
  }

  /* ---------------- iCrew pay statement ---------------- */
  function parseStatement(text) {
    const lines = String(text).split('\n');
    const st = { type: 'statement', lines: [] };
    let m = text.match(/STMT PAY PD:\s*(\d{2}[A-Z]{3}\d{2})/);
    if (m) { st.periodStart = parseDLDate(m[1]); st.bidMonth = bidMonthOf(st.periodStart); }
    m = text.match(/IN BANK:\s+(\d+:\d+)/);
    st.inBank = m ? hmToMin(m[1]) : null;
    m = text.match(/PAY\/CRD:\s+(\d+:\d+)/);
    st.payCrd = m ? hmToMin(m[1]) : null;
    m = text.match(/PAY\/CRD PAY: \$\s*([\d,]+\.\d{2})/);
    st.payCrdPay = m ? moneyToNum(m[1]) : null;
    m = text.match(/CUR C\/O RATE:\s+([\d.]+)/);
    st.curCoRate = m ? parseFloat(m[1]) : null;
    // dated log lines:  08JAN 4549SS 22 10:23    0:35 ... $ 8,928.48
    for (const raw of lines) {
      const lm = raw.match(/^\s*(\d{2}[A-Z]{3})\s+([A-Z0-9*]+)\s+\*?\s*(\d{2})\s+(.*?)\$\s*([\d,]+\.\d{2})\s*$/);
      if (lm) {
        const hmToks = lm[4].match(/\d+:\d{2}/g) || [];
        st.lines.push({
          date: lm[1], id: lm[2], code: lm[3],
          fltHrs: hmToks.length ? hmToMin(hmToks[0]) : null,
          crdHrs: hmToks.length > 1 ? hmToMin(hmToks[1]) : null,
          totalPay: moneyToNum(lm[5])
        });
      }
    }
    const lineWith = (re) => { for (const raw of lines) { if (re.test(raw)) return raw; } return null; };
    let ln = lineWith(/SUB TOTALS/);
    if (ln) { const a = ln.match(/\$\s*([\d,]+\.\d{2})/); st.subTotalsPay = a ? moneyToNum(a[1]) : null; }
    ln = lineWith(/BANK DEPOSIT/);
    if (ln) {
      const hm = ln.match(/\+\s*(\d+:\d+)/);
      const a = ln.match(/-\s*\$\s*([\d,]+\.\d{2})/);
      st.bankDeposit = { hrs: hm ? hmToMin(hm[1]) : null, amount: a ? -moneyToNum(a[1]) : null };
    }
    m = text.match(/DIST TRNG PAY:\s*(\d+:\d+)\s*@\s*([\d.]+).*?\$\s*([\d,]+\.\d{2})/);
    if (m) st.distTrng = { hrs: hmToMin(m[1]), ratePerMin: parseFloat(m[2]), amount: moneyToNum(m[3]) };
    m = text.match(/ADVANCE PAY\s*-\s*\$\s*([\d,]+\.\d{2})/);
    st.advance = m ? moneyToNum(m[1]) : null; // null = no advance line on statement
    m = text.match(/^\s*GROSS PAY\s+\$\s*([\d,]+\.\d{2})/m);
    st.grossPay = m ? moneyToNum(m[1]) : null;
    m = text.match(/GROSS PAY ADJUSTMENTS\s+\$?\s*([\d,]+\.\d{2})?/);
    st.grossAdj = (m && m[1]) ? moneyToNum(m[1]) : null;
    m = text.match(/TOTAL GROSS PAY\s+\$?\s*([\d,]+\.\d{2})/);
    st.totalGrossPay = m ? moneyToNum(m[1]) : null;
    m = text.match(/^\s*MEAL EXPENSES\s+\$\s*([\d,]+\.\d{2})/m);
    st.mealExpenses = m ? moneyToNum(m[1]) : null;
    m = text.match(/RES GUARANTEE\s+(\d+:\d+)\s+\$\s*([\d,]+\.\d{2})/);
    if (m) st.resGuarantee = { hrs: hmToMin(m[1]), amount: moneyToNum(m[2]) };
    // REMARKS: everything non-blank after the REMARKS header, verbatim
    const ri = lines.findIndex(l => /REMARKS\s*:/.test(l));
    if (ri >= 0) {
      const parts = [];
      for (let i = ri + 1; i < lines.length; i++) {
        if (/END OF DISPLAY/.test(lines[i])) break;
        const t = lines[i].trim();
        if (t) parts.push(t);
      }
      st.remarks = parts.join(' ');
    } else st.remarks = '';
    // Translator definition: TOTAL FLIGHT PAY = gross + advance (advance was deducted inside gross)
    const gross = (st.totalGrossPay !== null && st.totalGrossPay !== undefined) ? st.totalGrossPay : st.grossPay;
    st.grossEffective = gross;
    st.flightPayTotal = (gross === null || gross === undefined) ? null : gross + (st.advance || 0);
    return st;
  }

  /* ---------------- PAS (Pilot Activity Statement, CSV export) ---------------- */
  const EQUIP_TO_CLASS = { '320': 'A320', '319': 'A319', '321': 'A321', '3N1': 'A321 NEO', '3NE': 'A321 NEO', '32Q': 'A321 NEO' };
  function equipClass(equip) {
    if (!equip) return null;
    const e = String(equip).replace(/\*/g, '').trim();
    return EQUIP_TO_CLASS[e] || null;
  }

  function parsePAS(text) {
    const rows = parseCSV(text);
    const pas = { type: 'pas', summaryLines: [], rotations: [], rates: {} };
    // period label + end date
    for (const r of rows.slice(0, 2)) {
      const joined = r.join(',');
      const pm = joined.match(/(\d{4})\s+([A-Z]{3})/);
      if (pm && MONTHS[pm[2]]) pas.bidMonth = pm[1] + '-' + String(MONTHS[pm[2]]).padStart(2, '0');
    }
    const em = text.match(/Period Ending ([A-Za-z]+ \d{1,2}, \d{4})/);
    if (em) pas.periodEnd = parseLongDate(em[1]);
    // pay summary table
    let inSummary = false, curDesc = null;
    for (const r of rows) {
      const c0 = (r[0] || '').trim();
      if (/^Description/.test(c0)) { inSummary = true; continue; }
      if (!inSummary) continue;
      if (c0 === 'TOTAL AMOUNT PAID') {
        pas.totalPaid = { hrs: hmToMin(r[14]), amount: moneyToNum(r[15]) };
        inSummary = false; break;
      }
      if (c0) curDesc = c0;
      const payHrs = hmToMin(r[14]);
      const amt = moneyToNum(r[15]);
      if (payHrs === null && amt === null) continue;
      const line = {
        desc: curDesc, aircraft: (r[6] || '').trim(), blockDom: hmToMin(r[7]), blockIntl: hmToMin(r[8]),
        addlPayHrs: hmToMin(r[9]), deadhead: hmToMin(r[10]), minutesUnder: hmToMin(r[11]),
        tafb: hmToMin(r[12]), payHours: payHrs, amount: amt, note: (r[16] || '').trim()
      };
      pas.summaryLines.push(line);
      if (curDesc === 'SUB TOTAL') pas.subTotal = line;
      if (curDesc === 'PER DIEM') pas.perDiem = line;
      if (curDesc === 'BANK DEPOSIT') pas.bankDeposit = line;
    }
    // rates: 'Pay Rate: A321 NEO-$404.92/hr ; A321-$390.30/hr  A320-$388.27/hr ...'
    const ri = text.indexOf('Pay Rate:');
    if (ri >= 0) {
      const seg = text.slice(ri, ri + 320);
      const rRe = /([A-Z][A-Z0-9 ]*?)-\$(\d+\.\d{2})\/hr/g; let rm;
      while ((rm = rRe.exec(seg)) !== null) pas.rates[rm[1].trim()] = parseFloat(rm[2]);
    }
    const cm = text.match(/Current C\/O Rate: \$(\d+\.\d{2})\/hr/);
    if (cm) pas.coRate = parseFloat(cm[1]);
    // rotation details
    let inRot = false, cur = null;
    for (const r of rows) {
      const c0 = (r[0] || '').trim();
      if (c0 === 'Rotation Details') { inRot = true; continue; }
      if (!inRot) continue;
      if (c0 === 'Notes') break;
      const rotNo = (r[1] || '').trim();
      const flight = (r[3] || '').trim();
      const compVal = (r[17] || '').trim();
      const compLabel = (r[20] || '').trim();
      if (rotNo && flight) {
        cur = { award: c0, rot: rotNo, dup: (r[2] || '').trim(), legs: [], components: [], rotationPayHours: null, tafbCr: null, tafbEx: null };
        pas.rotations.push(cur);
      }
      if (flight && cur) {
        cur.legs.push({
          flight: flight, date: (r[4] || '').trim(), day: (r[5] || '').trim(),
          ship: (r[6] || '').trim(), equip: (r[7] || '').trim(),
          from: (r[8] || '').trim(), to: (r[9] || '').trim(),
          schedBlock: hmToMin(r[14]), actBlock: hmToMin(r[15]), mu: hmToMin(r[16]),
          note: compLabel
        });
      } else if (!flight && cur && compVal && hmToMin(compVal) !== null && compLabel) {
        const comp = { label: compLabel, hrs: hmToMin(compVal) };
        cur.components.push(comp);
        if (compLabel === 'ROTATION PAY HOURS') cur.rotationPayHours = comp.hrs;
        if (compLabel === 'TAFB CR') cur.tafbCr = comp.hrs;
        if (compLabel === 'TAFB EX') cur.tafbEx = comp.hrs;
      }
    }
    // helpers: summed pay-code totals across aircraft rows
    pas.payCodeTotal = (desc) => {
      let hrs = 0, amt = 0, found = false;
      for (const l of pas.summaryLines) {
        if (l.desc === desc) { found = true; hrs += (l.payHours || 0); amt += (l.amount || 0); }
      }
      return found ? { hrs: hrs, amount: round2(amt) } : null;
    };
    // per-rotation component lookup (label prefix match)
    pas.rotationComponent = (rot, labelPrefix) => {
      let total = 0, found = false;
      for (const c of rot.components) {
        if (c.label.indexOf(labelPrefix) === 0) { found = true; total += c.hrs; }
      }
      return found ? total : null;
    };
    return pas;
  }

  /* ---------------- payroll pay stub ----------------
   * Semi-monthly ADP-style stub. Cadence (verified): the end-of-month check
   * pays that bid period's ADVANCE; the mid-month check of the following
   * month pays the prior period's SETTLEMENT.
   * In the Wage Earnings block, Current amounts start around col 53-58 and
   * YTD amounts around col 70-75, so a $ token starting before col 66 on a
   * label line is the Current amount; a line whose only $ starts later is
   * a YTD-only line (no current earnings of that type).
   */
  function parseStub(text) {
    const lines = String(text).split('\n');
    const stub = { type: 'stub' };
    let m = text.match(/Check Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (m) stub.checkDate = parseUSDate(m[1]);
    m = text.match(/Period Begin:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (m) stub.periodBegin = parseUSDate(m[1]);
    m = text.match(/Period End:\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (m) stub.periodEnd = parseUSDate(m[1]);
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const currentOf = (label) => {
      const re = new RegExp('^\\s*' + escRe(label));
      for (const raw of lines) {
        if (!re.test(raw)) continue;
        const amtRe = /\$[\d,]+\.\d{2}/g; let tm;
        while ((tm = amtRe.exec(raw)) !== null) {
          if (tm.index < 66) return moneyToNum(tm[0]);
        }
        return null; // label found but YTD-only
      }
      return null;
    };
    stub.flightAdvance = currentOf('Flight Advance/Pilot');
    stub.fltPay = currentOf('Flt Pay/Pilot');
    stub.layoverMeals = currentOf('Layover Meals');
    stub.profitSharing = currentOf('Profit Sharing');
    stub.cashEarnings = currentOf('Cash Earnings');
    stub.netPay = currentOf('Net Pay');
    // classify + link to a bid month
    if (stub.flightAdvance !== null) {
      stub.kind = 'advance';
      if (stub.periodEnd) stub.bidMonth = stub.periodEnd.y + '-' + String(stub.periodEnd.m).padStart(2, '0');
    } else if (stub.fltPay !== null) {
      stub.kind = 'settlement';
      if (stub.periodBegin) {
        const prev = addDays(stub.periodBegin, -1);
        stub.bidMonth = prev.y + '-' + String(prev.m).padStart(2, '0');
      }
    } else {
      stub.kind = 'other';
      if (stub.periodEnd) stub.bidMonth = stub.periodEnd.y + '-' + String(stub.periodEnd.m).padStart(2, '0');
    }
    return stub;
  }

  /* ---------------- iCrew rotation display ----------------
   * Times in the rotation display are H.MM ('5.16' = 5h16m). A duty period
   * closes at its 'X.XXTL' token. TRP/MCD/ADG are rotation-level rigs that
   * add on top of the sum of duty-period TLs (verified: 4570 and 0625).
   * Total pay = footer TL + SIT + EDP + HOL + CARVE.
   */
  function parseRotation(text) {
    const lines = String(text).split('\n');
    const rot = { type: 'rotation', legs: [], dps: [], rigs: { trp: 0, mcd: 0, adg: 0 } };
    let m = text.match(/(\d{4})(?:-(\d+))?\s+POS-/);
    if (m) { rot.rot = m[1]; rot.dup = m[2] || null; }
    m = text.match(/EFFECTIVE\s+([A-Z]{3})(\d{1,2})/);
    if (m && MONTHS[m[1]]) rot.effective = { month: MONTHS[m[1]], day: parseInt(m[2], 10) };
    let curDP = null;
    const newDP = (day) => ({ startDay: day, legs: [], tl: null, dhd: 0, dty: 0, block: 0 });
    for (const raw of lines) {
      // rotation-level rigs and duty annotations anywhere on the line
      // (but NOT on the REGULAR-/RESERVE- footer line, whose TL/BL/CR/MU
      // values are rotation totals, not a duty period)
      const isFooterLine = /REGULAR-|RESERVE-/.test(raw);
      const annRe = /([\d]+\.[\d]{2})(TL|DTY|DHD|TRP|MCD|ADG)\b/g; let am;
      const anns = [];
      if (!isFooterLine) while ((am = annRe.exec(raw)) !== null) anns.push({ v: dotToMin(am[1]), kind: am[2] });
      // leg line? (optional leading day, optional 'D' deadhead marker)
      let leg = null;
      let lm = raw.match(/^\s*(\d{1,2})\s+(D\s+)?(\d{3,4})\s+([A-Z]{3})\s+(\d{4})\s+([A-Z]{3})\.(\d{4})\s+([\d.]+)(?:\s+([\d.]+))?/);
      if (lm) {
        leg = { day: parseInt(lm[1], 10), dh: !!lm[2], flight: lm[3], from: lm[4], dep: lm[5], to: lm[6], arr: lm[7], blk: dotToMin(lm[8]), mu: lm[9] ? dotToMin(lm[9]) : null };
      } else {
        lm = raw.match(/^\s+(\d{3,4})\s+([A-Z]{3})\s+(\d{4})\s+([A-Z]{3})\.(\d{4})\s+([\d.]+)(?:\s+([\d.]+))?/);
        if (lm) leg = { day: null, dh: false, flight: lm[1], from: lm[2], dep: lm[3], to: lm[4], arr: lm[5], blk: dotToMin(lm[6]), mu: lm[7] ? dotToMin(lm[7]) : null };
      }
      if (leg) {
        if (leg.day !== null) { curDP = newDP(leg.day); rot.dps.push(curDP); }
        if (!curDP) { curDP = newDP(rot.effective ? rot.effective.day : null); rot.dps.push(curDP); }
        if (leg.dh) { curDP.dhd += leg.blk || 0; leg.dhBlock = leg.blk; }
        curDP.legs.push(leg); rot.legs.push(leg);
      }
      for (const a of anns) {
        if (a.kind === 'TL') { if (curDP) { curDP.tl = a.v; } }
        else if (a.kind === 'DHD') { /* leg-level DHD already counted from leg; annotation mirrors it */ }
        else if (a.kind === 'DTY') { if (curDP) curDP.dty = a.v; }
        else if (a.kind === 'TRP') rot.rigs.trp += a.v;
        else if (a.kind === 'MCD') rot.rigs.mcd += a.v;
        else if (a.kind === 'ADG') rot.rigs.adg += a.v;
      }
    }
    m = text.match(/REGULAR-\s*([\d.]+)TL\s+([\d.]+)BL\s+([\d.]+)CR\s+([\d.]+)MU/);
    if (m) rot.footer = { tl: dotToMin(m[1]), bl: dotToMin(m[2]), cr: dotToMin(m[3]), mu: dotToMin(m[4]) };
    m = text.match(/TAFB\s+([\d.]+)CR/);
    if (m) rot.tafbCr = dotToMin(m[1]);
    m = text.match(/TAFB\s+([\d.]+)EX/);
    if (m) rot.tafbEx = dotToMin(m[1]);
    m = text.match(/([\d.]+)\s+HOL\s+([\d.]+)\s+CARVE\s+([\d.]+)\s+SIT\s+([\d.]+)\s+EDP/);
    if (m) { rot.hol = dotToMin(m[1]); rot.carve = dotToMin(m[2]); rot.sit = dotToMin(m[3]); rot.edp = dotToMin(m[4]); }
    const dpTlSum = rot.dps.reduce((a, d) => a + (d.tl || 0), 0);
    rot.computedCredit = dpTlSum + rot.rigs.trp + rot.rigs.mcd + rot.rigs.adg;
    rot.payCredit = (rot.footer && rot.footer.tl !== null && rot.footer.tl !== undefined) ? rot.footer.tl : rot.computedCredit;
    rot.payNoCredit = (rot.sit || 0) + (rot.edp || 0) + (rot.hol || 0) + (rot.carve || 0);
    rot.totalPay = rot.payCredit + rot.payNoCredit;
    rot.blockTotal = rot.legs.reduce((a, l) => a + (l.blk || 0), 0);
    rot.dhdTotal = rot.dps.reduce((a, d) => a + d.dhd, 0);
    return rot;
  }

  /* Assign each duty period to a bid period (by DP start date vs the loaded
   * cards' period ranges); rotation-level rigs follow the last DP.
   * Returns [{bidMonth|'prior'|'next', minutes}] summing to payCredit.
   */
  function splitRotation(rot, periodRanges) {
    if (!rot.effective || !rot.dps.length) return null;
    let yearHint = periodRanges && periodRanges.length ? parseInt(periodRanges[0].start.slice(0, 4), 10) : new Date().getFullYear();
    if (periodRanges && periodRanges.length) {
      // if the effective date in the hinted year falls far outside the loaded
      // period ranges, shift the year toward them (Dec/Jan boundary safety)
      const cand = iso({ y: yearHint, m: rot.effective.month, d: rot.effective.day });
      if (cand > periodRanges[periodRanges.length - 1].end && rot.effective.month >= 7) yearHint--;
      else if (cand < periodRanges[0].start && rot.effective.month <= 6) yearHint++;
    }
    let month = rot.effective.month, year = yearHint, prevDay = null;
    const parts = {};
    const order = [];
    const add = (key, mins) => { if (!(key in parts)) { parts[key] = 0; order.push(key); } parts[key] += mins; };
    const keyFor = (dtIso) => {
      if (periodRanges) {
        for (const pr of periodRanges) if (dtIso >= pr.start && dtIso <= pr.end) return pr.bidMonth;
        if (periodRanges.length && dtIso < periodRanges[0].start) return 'prior';
        if (periodRanges.length && dtIso > periodRanges[periodRanges.length - 1].end) return 'next';
      }
      return dtIso.slice(0, 7);
    };
    let lastKey = null;
    for (const dp of rot.dps) {
      if (prevDay !== null && dp.startDay !== null && dp.startDay < prevDay) {
        month++; if (month > 12) { month = 1; year++; }
      }
      if (dp.startDay !== null) prevDay = dp.startDay;
      const dt = { y: year, m: month, d: dp.startDay || 1 };
      lastKey = keyFor(iso(dt));
      add(lastKey, dp.tl || 0);
    }
    const rigTotal = rot.rigs.trp + rot.rigs.mcd + rot.rigs.adg;
    if (rigTotal && lastKey) add(lastKey, rigTotal);
    return order.map(k => ({ bidMonth: k, minutes: parts[k] }));
  }

  /* ---------------- period assembly ---------------- */
  function buildContext(docs) {
    const ctx = { periods: {}, rotationsByNbr: {}, periodRanges: [] };
    const P = (bm) => {
      if (!ctx.periods[bm]) ctx.periods[bm] = { bidMonth: bm, card: null, statement: null, pas: null, stubs: [], pasRotations: [] };
      return ctx.periods[bm];
    };
    for (const d of docs) {
      if (d.type === 'timecard' && d.bidMonth) {
        const p = P(d.bidMonth); p.card = d;
        ctx.periodRanges.push({ bidMonth: d.bidMonth, start: iso(d.periodStart), end: iso(d.periodEnd) });
      } else if (d.type === 'statement' && d.bidMonth) {
        P(d.bidMonth).statement = d;
      } else if (d.type === 'pas' && d.bidMonth) {
        const p = P(d.bidMonth); p.pas = d; p.pasRotations = d.rotations || [];
      } else if (d.type === 'stub' && d.bidMonth) {
        P(d.bidMonth).stubs.push(d);
      } else if (d.type === 'rotation' && d.rot) {
        ctx.rotationsByNbr[d.rot] = d;
      }
    }
    ctx.periodRanges.sort((a, b) => a.start < b.start ? -1 : 1);
    ctx.sortedMonths = Object.keys(ctx.periods).sort();
    return ctx;
  }

  function baseRateFor(ctx, bm) {
    const order = [bm].concat(ctx.sortedMonths.filter(x => x !== bm));
    for (const k of order) {
      const pas = ctx.periods[k] && ctx.periods[k].pas;
      if (pas && pas.rates && pas.rates['A320']) return pas.rates['A320'];
    }
    return null;
  }
  // PWA 3.G.1: guarantee = ALV - 2:00, floor 72:00, cap 80:00; advance = 1/2 x guarantee x base rate
  function advanceEstimate(card, baseRate) {
    if (!card || card.alv === null || card.alv === undefined || !baseRate) return null;
    const guar = Math.min(80 * 60, Math.max(72 * 60, card.alv - 120));
    return { guaranteeMin: guar, amount: round2(0.5 * (guar / 60) * baseRate) };
  }
  function settlementStubFor(p) { return p.stubs.find(s => s.kind === 'settlement') || null; }
  function stubAdvanceFor(p) {
    for (const s of p.stubs) if (s.kind === 'advance') return s.flightAdvance;
    for (const s of p.stubs) {
      // an end-of-month stub with no Flight Advance line is evidence of a $0 advance
      if (s.kind === 'other' && s.periodEnd && s.periodEnd.d >= 28) return 0;
    }
    return null;
  }

  function subsetSumExists(values, target) {
    const reachable = new Set([0]);
    for (const v of values) {
      for (const s of Array.from(reachable)) reachable.add(s + v);
    }
    return reachable.has(target);
  }

  /* ---------------- reconciliation ----------------
   * Check: {period, status: 'pass'|'warn'|'info'|'skip', title, detail}
   */
  function reconcile(ctx) {
    const checks = [];
    const push = (period, status, title, detail, extra) =>
      checks.push(Object.assign({ period: period, status: status, title: title, detail: detail }, extra || {}));

    for (const bm of ctx.sortedMonths) {
      const p = ctx.periods[bm];
      const L = bidMonthLabel(bm);

      /* (a) PAS total = statement flight pay + per diem */
      if (p.pas && p.statement) {
        const stmt = p.statement;
        const expected = round2((stmt.grossEffective || 0) + (stmt.advance || 0) + (stmt.mealExpenses || 0));
        const actual = p.pas.totalPaid ? p.pas.totalPaid.amount : null;
        if (actual !== null && Math.abs(actual - expected) <= 0.011) {
          push(bm, 'pass', 'PAS total reconciles with pay statement',
            'PAS TOTAL AMOUNT PAID ' + fmtMoney(actual) + ' = statement gross ' + fmtMoney(stmt.grossEffective) +
            ' + advance ' + fmtMoney(stmt.advance || 0) + ' + meal expenses/per diem ' + fmtMoney(stmt.mealExpenses || 0) + '.');
        } else {
          push(bm, 'warn', 'PAS total does NOT reconcile with pay statement',
            'PAS TOTAL AMOUNT PAID ' + fmtMoney(actual) + ' vs statement gross ' + fmtMoney(stmt.grossEffective) +
            ' + advance ' + fmtMoney(stmt.advance || 0) + ' + meals ' + fmtMoney(stmt.mealExpenses || 0) +
            ' = ' + fmtMoney(expected) + '. Difference: ' + fmtMoney(actual === null ? null : round2(actual - expected)) + '.');
        }
      } else if (p.pas || p.statement) {
        push(bm, 'skip', 'PAS ↔ statement reconciliation not run',
          'Load both the PAS and the pay statement for ' + L + ' to verify the PAS total against statement gross + advance + per diem.');
      }

      /* (h) card credit vs statement PAY/CRD */
      if (p.card && p.statement && p.card.footer && p.statement.payCrd !== null) {
        if (p.card.footer.subTtlCredit === p.statement.payCrd) {
          push(bm, 'pass', 'Time card credit matches statement PAY/CRD',
            'Both show ' + minToHM(p.statement.payCrd) + ' of pay/credit for ' + L + '.');
        } else {
          push(bm, 'warn', 'Time card credit differs from statement PAY/CRD',
            'Card subtotal credit ' + minToHM(p.card.footer.subTtlCredit) + ' vs statement PAY/CRD ' +
            minToHM(p.statement.payCrd) + ' — a difference here is how guarantee errors (like a wrong RES GUAR) first surface.');
        }
      }
      if (p.card && p.card.summary && p.card.summary.creditMatchesFooter === false) {
        push(bm, 'warn', 'Card line items do not sum to the card footer credit',
          'Line CREDIT column sums to ' + minToHM(p.card.summary.lineCredit) + ' but the footer prints ' +
          minToHM(p.card.footer.credit) + '. The summary uses the footer figure.');
      }

      /* (b) ASTERISK PAY vs PAS REROUTE PAY, with per-rotation split */
      const pasReroute = p.pas ? p.pas.payCodeTotal('REROUTE PAY') : null;
      const perRot = [];
      if (p.pas) {
        for (const r of p.pasRotations) {
          const rc = p.pas.rotationComponent(r, 'REROUTE CREDIT');
          if (rc !== null && rc !== 0) perRot.push({ rot: r.rot, minutes: rc });
        }
      }
      const perRotSum = perRot.reduce((a, x) => a + x.minutes, 0);
      const cardAst = p.card ? (p.card.asteriskPay || 0) : null;
      if (cardAst !== null && cardAst > 0 && !p.pas) {
        push(bm, 'warn', 'ASTERISK PAY ' + minToHM(cardAst) + ' — composition unknown',
          'The time card aggregates reroute pay under ASTERISK PAY but does not break it down. Load the PAS for ' + L +
          ' to decompose it per rotation before treating any part of it as explained.');
      } else if (pasReroute || perRot.length || (cardAst || 0) > 0) {
        const splitTxt = perRot.map(x => 'rotation ' + x.rot + ': ' + minToHM(x.minutes)).join('; ');
        if (cardAst !== null && pasReroute && perRot.length &&
            cardAst === pasReroute.hrs && perRotSum === pasReroute.hrs) {
          push(bm, 'pass', 'ASTERISK PAY fully explained by PAS reroute pay',
            'Card ASTERISK PAY ' + minToHM(cardAst) + ' = PAS REROUTE PAY ' + minToHM(pasReroute.hrs) +
            ' (' + fmtMoney(pasReroute.amount) + '). Per-rotation split — ' + splitTxt + '.',
            { split: perRot });
        } else {
          push(bm, 'warn', 'Reroute pay figures do not fully agree',
            'Card ASTERISK PAY: ' + (cardAst === null ? 'no card' : minToHM(cardAst)) +
            '; PAS REROUTE PAY summary: ' + (pasReroute ? minToHM(pasReroute.hrs) : '—') +
            '; per-rotation REROUTE CREDIT sum: ' + minToHM(perRotSum) + (splitTxt ? ' (' + splitTxt + ')' : '') + '.');
        }
      }

      /* (c) advance check, PWA 3.G.1 */
      if (p.card) {
        const rate = baseRateFor(ctx, bm);
        const est = advanceEstimate(p.card, rate);
        const stmtAdv = p.statement ? p.statement.advance : null;
        const stubAdv = stubAdvanceFor(p);
        const pureReserve = p.card.summary.credit === 0 && p.card.summary.resGuar > 0;
        if (pureReserve) {
          push(bm, 'info', 'No advance expected (reserve / leave period)',
            'This period shows no regular credit, only a reserve guarantee. The 3.G.1 advance formula is not applied; ' +
            'advance actually drawn: ' + (stubAdv !== null ? fmtMoney(stubAdv) : (stmtAdv !== null ? fmtMoney(stmtAdv) : 'none shown')) + '.');
        } else if (est && (stmtAdv !== null || stubAdv !== null)) {
          const parts = [];
          let ok = true;
          if (stmtAdv !== null) { parts.push('statement advance ' + fmtMoney(stmtAdv)); if (Math.abs(stmtAdv - est.amount) > 0.51) ok = false; }
          if (stubAdv !== null) { parts.push('pay stub advance ' + fmtMoney(stubAdv)); if (Math.abs(stubAdv - est.amount) > 0.51) ok = false; }
          if (stmtAdv !== null && stubAdv !== null && Math.abs(stmtAdv - stubAdv) > 0.011) ok = false;
          push(bm, ok ? 'pass' : 'warn', 'Flight advance matches PWA 3.G.1 formula',
            'Estimate: ½ × guarantee ' + minToHM(est.guaranteeMin) + ' (ALV ' + minToHM(p.card.alv) + ' − 2:00, floor 72 / cap 80) × base rate ' +
            fmtMoney(rate) + '/hr = ' + fmtMoney(est.amount) + '. Actual — ' + parts.join('; ') + '.');
        } else if (est) {
          push(bm, 'info', 'Advance estimate (no actual to compare)',
            'PWA 3.G.1 estimate: ½ × ' + minToHM(est.guaranteeMin) + ' × ' + fmtMoney(rate) + ' = ' + fmtMoney(est.amount) +
            '. Load the pay statement or the end-of-month pay stub to verify what was actually advanced.');
        }
      }

      /* (d) bank cross-checks vs statement / PAS */
      if (p.card) {
        const issues = [];
        if (p.card.inBank !== null && p.card.inBank !== undefined && p.card.outBank !== null && p.card.outBank !== undefined) {
          const expectedOut = p.card.inBank + (p.card.bankDepAward || 0);
          if (expectedOut !== p.card.outBank) issues.push('card math: IN BANK ' + minToHM(p.card.inBank) + ' + deposit award ' + minToHM(p.card.bankDepAward || 0) + ' = ' + minToHM(expectedOut) + ' but OUT BANK prints ' + minToHM(p.card.outBank) + ' (a withdrawal or payback may explain this)');
        }
        if (p.statement && p.statement.bankDeposit && p.statement.bankDeposit.hrs !== null &&
            p.statement.bankDeposit.hrs !== (p.card.bankDepAward || 0)) {
          issues.push('statement BANK DEPOSIT ' + minToHM(p.statement.bankDeposit.hrs) + ' ≠ card deposit award ' + minToHM(p.card.bankDepAward || 0));
        }
        if (p.statement && p.statement.inBank !== null && p.card.inBank !== null && p.statement.inBank !== p.card.inBank) {
          issues.push('statement IN BANK ' + minToHM(p.statement.inBank) + ' ≠ card IN BANK ' + minToHM(p.card.inBank));
        }
        if (p.pas && p.pas.bankDeposit && Math.abs(p.pas.bankDeposit.payHours || 0) !== (p.card.bankDepAward || 0)) {
          issues.push('PAS BANK DEPOSIT ' + minToHM(p.pas.bankDeposit.payHours) + ' ≠ card deposit award ' + minToHM(p.card.bankDepAward || 0));
        }
        if (issues.length) push(bm, 'warn', 'Bank figures disagree across documents', issues.join('; ') + '.');
        else if (p.card.outBank !== null && p.card.outBank !== undefined) {
          push(bm, 'pass', 'Bank figures consistent within ' + L,
            'IN BANK ' + minToHM(p.card.inBank) + ' + deposit award ' + minToHM(p.card.bankDepAward || 0) + ' = OUT BANK ' + minToHM(p.card.outBank) +
            (p.statement || p.pas ? ', and the statement/PAS bank lines agree.' : '.'));
        }
      }

      /* (f) statement remarks — surfaced verbatim, never absorbed into totals */
      if (p.statement && p.statement.remarks) {
        const amtM = p.statement.remarks.match(/\$\s?([\d,]+\.\d{2})/);
        const remarkAmt = amtM ? moneyToNum(amtM[1]) : null;
        push(bm, 'warn', 'Pay statement REMARKS report a correction — read verbatim',
          'Delta\'s own remark on the ' + L + ' statement (shown exactly as printed, not folded into any total): "' +
          p.statement.remarks + '"' + (remarkAmt ? ' Amount named: ' + fmtMoney(remarkAmt) + ' — verify it lands on the paycheck the remark names (see the settlement check below).' : ''),
          { remarks: p.statement.remarks, remarkAmount: remarkAmt });
      }
      /* (f2) settlement stub vs statement gross (+ promised-correction landing) */
      const settle = settlementStubFor(p);
      if (p.statement && settle && settle.fltPay !== null && p.statement.grossEffective !== null) {
        const diff = round2(settle.fltPay - p.statement.grossEffective);
        const mealsOk = (settle.layoverMeals === null || p.statement.mealExpenses === null) ||
          Math.abs(settle.layoverMeals - p.statement.mealExpenses) <= 0.011;
        const remarkAmt = (() => {
          const mm = (p.statement.remarks || '').match(/\$\s?([\d,]+\.\d{2})/);
          return mm ? moneyToNum(mm[1]) : null;
        })();
        if (Math.abs(diff) <= 0.011 && mealsOk) {
          push(bm, 'pass', 'Settlement paycheck matches statement gross',
            'Stub dated ' + (settle.checkDate ? iso(settle.checkDate) : '?') + ': Flt Pay ' + fmtMoney(settle.fltPay) +
            ' = statement gross ' + fmtMoney(p.statement.grossEffective) + (settle.layoverMeals !== null ? '; Layover Meals ' + fmtMoney(settle.layoverMeals) + ' vs statement meal expenses ' + fmtMoney(p.statement.mealExpenses) + '.' : '.'));
        } else if (remarkAmt !== null && Math.abs(diff - remarkAmt) <= 0.011) {
          push(bm, 'pass', 'Settlement paycheck includes the correction promised in the remarks',
            'Stub Flt Pay ' + fmtMoney(settle.fltPay) + ' = statement gross ' + fmtMoney(p.statement.grossEffective) + ' + ' +
            fmtMoney(remarkAmt) + ' correction from the statement remarks. The promised adjustment landed (check dated ' +
            (settle.checkDate ? iso(settle.checkDate) : '?') + ').');
        } else {
          push(bm, 'warn', 'Settlement paycheck differs from statement gross',
            'Stub Flt Pay ' + fmtMoney(settle.fltPay) + ' vs statement gross ' + fmtMoney(p.statement.grossEffective) +
            ' — difference ' + fmtMoney(diff) + ', which no remark on the statement explains.');
        }
      } else if (p.statement && !settle) {
        push(bm, 'skip', 'Settlement paycheck not verified',
          'Load the mid-month settlement pay stub for ' + L + ' (the check that pays this period out) to verify the gross actually landed.');
      }

      /* (g) PAS reroute-credit composition test */
      if (p.pas) {
        for (const r of p.pasRotations) {
          const rc = p.pas.rotationComponent(r, 'REROUTE CREDIT');
          if (rc === null || rc === 0) continue;
          const comp = (lbl) => p.pas.rotationComponent(r, lbl);
          const dhd = r.legs.filter(l => /DH/.test(l.note || '')).reduce((a, l) => a + (l.actBlock || 0), 0);
          const candidates = [];
          const addC = (v) => { if (v !== null && v > 0) candidates.push(v); };
          addC(dhd); addC(comp('FLIGHT TIME PAY')); addC(comp('DUTY PERIOD CREDIT'));
          addC(comp('ROT CREDIT')); addC(comp('AVG DAILY GUAR')); addC(comp('MINIMUM CALENDAR DAY'));
          addC(comp('SIT PAY')); addC(comp('EXTENDED DUTY PERIOD')); addC(comp('GREEN SLIP CREDIT'));
          addC(comp('SILVER SLIP CREDIT'));
          if (!subsetSumExists(candidates, rc)) {
            push(bm, 'warn', 'Rotation ' + r.rot + ' reroute credit ' + minToHM(rc) + ' — composition unknown',
              'The PAS credits rotation ' + r.rot + ' with ' + minToHM(rc) + ' of REROUTE CREDIT, but no combination of its own ' +
              'components (deadhead, ADG, MCD, duty credit, SIT, EDP, flight time, slip credit) sums to that figure. ' +
              'It is money paid, shown here as paid — but its formula cannot be verified from these documents. Payroll holds the breakdown.');
          } else {
            push(bm, 'info', 'Rotation ' + r.rot + ' reroute credit ' + minToHM(rc) + ' decomposes from its components',
              'A combination of rotation ' + r.rot + '\'s deadhead/rig/duty components sums exactly to the ' + minToHM(rc) +
              ' REROUTE CREDIT (for 0625-style reroutes this is the SRH L.4 pattern: rerouted-DP deadhead + that DP\'s ADG/MCD).');
          }
        }
      }
    }

    /* (d2) bank chain across consecutive card periods */
    const cardMonths = ctx.sortedMonths.filter(bm => ctx.periods[bm].card);
    for (let i = 1; i < cardMonths.length; i++) {
      const prev = ctx.periods[cardMonths[i - 1]].card;
      const next = ctx.periods[cardMonths[i]].card;
      if (prev.outBank !== null && prev.outBank !== undefined && next.inBank !== null && next.inBank !== undefined) {
        if (prev.outBank === next.inBank) {
          push('multi', 'pass', 'Bank chain continuous: ' + bidMonthLabel(cardMonths[i - 1]) + ' → ' + bidMonthLabel(cardMonths[i]),
            'OUT BANK ' + minToHM(prev.outBank) + ' carries into the next period\'s IN BANK unchanged.');
        } else {
          push('multi', 'warn', 'Bank chain break: ' + bidMonthLabel(cardMonths[i - 1]) + ' → ' + bidMonthLabel(cardMonths[i]),
            'Prior period OUT BANK ' + minToHM(prev.outBank) + ' but next period IN BANK ' + minToHM(next.inBank) + '.');
        }
      }
    }

    /* (e) spill detection: rotation on two periods' cards */
    const rotPeriods = {};
    for (const bm of ctx.sortedMonths) {
      const card = ctx.periods[bm].card;
      if (!card) continue;
      for (const it of card.lines) {
        if (/^\d{4}$/.test(it.rot)) { // rotation numbers are 4 digits; pay codes (23K, 23M7, 4F1C...) are not
          if (!rotPeriods[it.rot]) rotPeriods[it.rot] = {};
          rotPeriods[it.rot][bm] = it;
        }
      }
    }
    for (const rotNo of Object.keys(rotPeriods)) {
      const bms = Object.keys(rotPeriods[rotNo]).sort();
      if (bms.length < 2) continue;
      const rotText = ctx.rotationsByNbr[rotNo];
      if (rotText) {
        const parts = splitRotation(rotText, ctx.periodRanges);
        const sum = parts ? parts.reduce((a, x) => a + x.minutes, 0) : null;
        const partTxt = parts ? parts.map(x =>
          (x.bidMonth === 'prior' ? 'prior period' : x.bidMonth === 'next' ? 'carryout (next period)' : bidMonthLabel(x.bidMonth)) +
          ' ' + minToHM(x.minutes)).join('; ') : '';
        if (parts && sum === rotText.payCredit) {
          push('multi', 'pass', 'Spill rotation ' + rotNo + ' split automatically across periods',
            'Rotation ' + rotNo + ' appears on the ' + bms.map(bidMonthLabel).join(' and ') + ' cards. Its pay & credit ' +
            minToHM(rotText.payCredit) + ' splits by duty-period start date — ' + partTxt + '. No hand-entry needed.',
            { spill: { rot: rotNo, parts: parts } });
        } else {
          push('multi', 'warn', 'Spill rotation ' + rotNo + ' split does not sum to its total',
            'Computed split (' + partTxt + ') sums to ' + minToHM(sum) + ' vs rotation pay & credit ' + minToHM(rotText.payCredit) + '.');
        }
      } else {
        // fall back to the PAS per-period views
        const views = [];
        for (const bm of bms) {
          const pr = ctx.periods[bm].pasRotations.find(r => r.rot === rotNo);
          if (pr && pr.rotationPayHours !== null) views.push(bidMonthLabel(bm) + ' PAS rotation pay hours ' + minToHM(pr.rotationPayHours));
        }
        push('multi', 'info', 'Spill rotation ' + rotNo + ' spans ' + bms.map(bidMonthLabel).join(' + '),
          'Rotation ' + rotNo + ' appears on two time cards (the later card carries it as a TRANS/spill-in line). ' +
          (views.length ? 'Per-period PAS views — ' + views.join('; ') + '. ' : '') +
          'Load the iCrew rotation display text to compute the exact in-period / carryout credit split automatically.');
      }
    }
    return checks;
  }

  /* ---------------- history totals ---------------- */
  function historyTotals(ctx) {
    const rows = [];
    const totals = { cardTotalMin: 0, pasPaid: 0, stmtFlightPay: 0, profitSharing: 0 };
    const quarters = {};
    for (const bm of ctx.sortedMonths) {
      const p = ctx.periods[bm];
      const row = { bidMonth: bm, cardTotalMin: null, pasPaid: null, stmtFlightPay: null, docs: [] };
      if (p.card) { row.cardTotalMin = p.card.summary.total; totals.cardTotalMin += row.cardTotalMin; row.docs.push('card'); }
      if (p.pas && p.pas.totalPaid) { row.pasPaid = p.pas.totalPaid.amount; totals.pasPaid += row.pasPaid; row.docs.push('PAS'); }
      if (p.statement && p.statement.flightPayTotal !== null) { row.stmtFlightPay = p.statement.flightPayTotal; totals.stmtFlightPay += row.stmtFlightPay; row.docs.push('statement'); }
      if (p.stubs.length) row.docs.push(p.stubs.length + ' stub' + (p.stubs.length > 1 ? 's' : ''));
      for (const s of p.stubs) if (s.profitSharing !== null && s.profitSharing !== undefined) totals.profitSharing += s.profitSharing;
      const q = bm.slice(0, 4) + '-Q' + (Math.floor((parseInt(bm.slice(5, 7), 10) - 1) / 3) + 1);
      if (!quarters[q]) quarters[q] = { pasPaid: 0, stmtFlightPay: 0, cardTotalMin: 0 };
      quarters[q].pasPaid += row.pasPaid || 0;
      quarters[q].stmtFlightPay += row.stmtFlightPay || 0;
      quarters[q].cardTotalMin += row.cardTotalMin || 0;
      rows.push(row);
    }
    return { rows: rows, totals: totals, quarters: quarters };
  }

  /* ---------------- ZIP extraction (DeltaNet downloads arrive as .zip) ----------------
   * Minimal read-only ZIP reader: central-directory based; supports stored
   * (method 0) and deflated (method 8) entries. Decompression uses the
   * platform DecompressionStream, so archives are unpacked locally and
   * never leave the device. Returns [{ name, text }] for every file entry. */
  async function unzipTextFiles(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o) => dv.getUint16(o, true);
    const u32 = (o) => dv.getUint32(o, true);
    // locate the End Of Central Directory record (scan back over its comment)
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 22 - 65536);
    for (let i = bytes.length - 22; i >= floor; i--) {
      if (u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (no end-of-directory record found).');
    const count = u16(eocd + 10);
    let off = u32(eocd + 16);
    const decoder = new TextDecoder('utf-8');
    const out = [];
    for (let n = 0; n < count; n++) {
      if (off + 46 > bytes.length || u32(off) !== 0x02014b50) break;
      const flags = u16(off + 8);
      const method = u16(off + 10);
      const compSize = u32(off + 20);
      const nameLen = u16(off + 28), extraLen = u16(off + 30), commentLen = u16(off + 32);
      const localOff = u32(off + 42);
      const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
      if (flags & 0x1) throw new Error('"' + name + '" is encrypted — unzip the archive first, then load the files inside.');
      const dataStart = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      let raw;
      if (method === 0) {
        raw = comp;
      } else if (method === 8) {
        if (typeof DecompressionStream === 'undefined') {
          throw new Error('This browser cannot unpack ZIP files — unzip the archive first, then load the files inside.');
        }
        const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        raw = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error('"' + name + '" uses an unsupported ZIP compression (method ' + method + ').');
      }
      out.push({ name: name.split('/').pop(), text: decoder.decode(raw) });
    }
    return out;
  }

  return {
    hmToMin, minToHM, dotToMin, moneyToNum, fmtMoney, round2,
    parseCSV, detectType, parseTimecard, summarizeCard, parseStatement,
    parsePAS, parseStub, parseRotation, splitRotation,
    buildContext, reconcile, historyTotals, advanceEstimate, baseRateFor,
    bidMonthLabel, iso, unzipTextFiles
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PayAudit;

/* ================= browser UI ================= */
if (typeof document !== 'undefined') {
  const LS_KEY = 'payaudit.v1.docs';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let docs = [];
  try { docs = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { docs = []; }
  let counter = docs.length;

  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(docs)); } catch (e) { /* storage full/blocked: session-only */ } }

  function parseDoc(d) {
    const type = PayAudit.detectType(d.text);
    try {
      if (type === 'timecard') return PayAudit.parseTimecard(d.text);
      if (type === 'statement') return PayAudit.parseStatement(d.text);
      if (type === 'pas') return PayAudit.parsePAS(d.text);
      if (type === 'stub') return PayAudit.parseStub(d.text);
      if (type === 'rotation') return PayAudit.parseRotation(d.text);
    } catch (e) { return { type: 'unknown', error: String(e) }; }
    return { type: 'unknown' };
  }

  function addText(text, name) {
    text = String(text || '').trim();
    if (!text) return 'Nothing to add — the box was empty.';
    const probe = { text: text };
    const parsed = parseDoc(probe);
    if (parsed.type === 'unknown') {
      return 'Could not recognize that document. Expected an iCrew time card, a PAS CSV, an iCrew pay statement, a pay stub, or a rotation display.';
    }
    docs.push({ id: Date.now() + '-' + (counter++), name: name || ('Pasted ' + parsed.type), text: text });
    save(); render();
    return 'Added ' + typeLabel(parsed) + (parsed.bidMonth ? ' for ' + PayAudit.bidMonthLabel(parsed.bidMonth) : '') + '.';
  }

  function typeLabel(p) {
    return { timecard: 'Time card', statement: 'Pay statement', pas: 'PAS', stub: 'Pay stub', rotation: 'Rotation' }[p.type] || p.type;
  }

  function render() {
    const parsed = docs.map(d => ({ doc: d, parsed: parseDoc(d) }));
    // document list
    $('docList').innerHTML = parsed.map(({ doc, parsed: p }) =>
      '<li><span><span class="tag">' + esc(typeLabel(p)) + '</span>' + esc(doc.name) +
      (p.bidMonth ? ' <span class="mut">' + esc(PayAudit.bidMonthLabel(p.bidMonth)) + '</span>' : '') +
      (p.type === 'rotation' && p.rot ? ' <span class="mut">rotation ' + esc(p.rot) + '</span>' : '') +
      '</span><button class="danger" data-del="' + esc(doc.id) + '" type="button">Remove</button></li>').join('');
    document.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      docs = docs.filter(d => d.id !== b.getAttribute('data-del')); save(); render();
    }));

    const ctx = PayAudit.buildContext(parsed.map(x => x.parsed).filter(p => p.type !== 'unknown'));
    const checks = PayAudit.reconcile(ctx);
    const byPeriod = {};
    for (const c of checks) { (byPeriod[c.period] = byPeriod[c.period] || []).push(c); }

    const bucketRows = [
      ['credit', 'Credit'], ['resGuar', 'RES Guarantee'], ['otherGuar', 'Other Guarantee'],
      ['payNoCredit', 'Pay, No Credit'], ['payOnly', 'Pay Only (addtl)'], ['rerouteAsterisk', 'Reroute Pay (Asterisk)'],
      ['gsPay', 'GS Slip Pay'], ['ssPay', 'SS Slip Pay'], ['vacation', 'Vacation'], ['training', 'Training'], ['pbsPr', 'PBS/PR Pay']
    ];
    const chkIcon = { pass: '✓', warn: '⚠', info: 'ℹ', skip: '·' };
    const chkHtml = (c) =>
      '<div class="chk ' + c.status + '"><span class="ico">' + chkIcon[c.status] + '</span><span class="t">' +
      esc(c.title) + '</span><p>' + esc(c.detail) + '</p></div>';

    let html = '';
    for (const bm of ctx.sortedMonths) {
      const p = ctx.periods[bm];
      const present = [];
      if (p.card) present.push('time card');
      if (p.statement) present.push('pay statement');
      if (p.pas) present.push('PAS');
      if (p.stubs.length) present.push(p.stubs.length + ' pay stub' + (p.stubs.length > 1 ? 's' : ''));
      html += '<section class="card"><h2>' + esc(PayAudit.bidMonthLabel(bm)) + ' bid period</h2>';
      html += '<p class="mut">Documents loaded: ' + esc(present.join(', ') || 'none') + '</p>';

      if (p.card) {
        const s = p.card.summary;
        html += '<h3>Time card summary</h3><table><tr><th>Bucket</th><th>Time</th></tr>';
        for (const [key, label] of bucketRows) {
          if (s[key]) html += '<tr><td>' + label + '</td><td>' + PayAudit.minToHM(s[key]) + '</td></tr>';
        }
        html += '<tr class="subtotal"><td>Subtotal</td><td>' + PayAudit.minToHM(s.subtotal) + '</td></tr>';
        if (s.bankDeposit) html += '<tr><td>Bank Deposit Award</td><td>−' + PayAudit.minToHM(s.bankDeposit) + '</td></tr>';
        html += '<tr class="total"><td>Total</td><td>' + PayAudit.minToHM(s.total) + '</td></tr></table>';
        html += '<p class="mut">Bank: IN ' + PayAudit.minToHM(p.card.inBank) + ' → OUT ' + PayAudit.minToHM(p.card.outBank) +
          ' · ALV ' + PayAudit.minToHM(p.card.alv) + ' · ' + p.card.lines.length + ' line items</p>';
        html += '<details><summary>Line items (' + p.card.lines.length + ')</summary><table><tr><th>Date</th><th>Code</th><th>Block</th><th>Pay</th><th>Credit</th><th>Addtl</th></tr>' +
          p.card.lines.map(it => '<tr><td>' + esc(it.date) + '</td><td>' + esc(it.rot) + (it.trans ? ' (TRANS)' : '') + '</td><td>' +
            PayAudit.minToHM(it.block) + '</td><td>' + (it.pay === 'TRANS' ? 'TRANS' : PayAudit.minToHM(it.pay)) + '</td><td>' +
            PayAudit.minToHM(it.credit) + '</td><td>' + PayAudit.minToHM(it.addtl) + '</td></tr>').join('') + '</table></details>';
      }

      if (p.statement) {
        const st = p.statement;
        html += '<h3>Pay statement</h3><div class="kv">' +
          '<span>PAY/CRD <b>' + PayAudit.minToHM(st.payCrd) + '</b></span>' +
          '<span>Gross <b>' + PayAudit.fmtMoney(st.grossEffective) + '</b></span>' +
          '<span>Advance <b>' + PayAudit.fmtMoney(st.advance || 0) + '</b></span>' +
          '<span>Total flight pay <b>' + PayAudit.fmtMoney(st.flightPayTotal) + '</b></span>' +
          '<span>Meal expenses <b>' + PayAudit.fmtMoney(st.mealExpenses || 0) + '</b></span></div>';
        if (st.remarks) html += '<blockquote class="remarks"><b>Statement remarks (verbatim):</b>\n' + esc(st.remarks) + '</blockquote>';
      }

      if (p.pas) {
        html += '<h3>PAS</h3><div class="kv"><span>TOTAL AMOUNT PAID <b>' + PayAudit.fmtMoney(p.pas.totalPaid ? p.pas.totalPaid.amount : null) +
          '</b></span><span>Rates: ' + Object.keys(p.pas.rates).map(k => esc(k) + ' ' + PayAudit.fmtMoney(p.pas.rates[k]) + '/hr').join(' · ') + '</span></div>';
      }

      const pcs = (byPeriod[bm] || []);
      if (pcs.length) html += '<h3>Checks</h3>' + pcs.map(chkHtml).join('');

      // rotations for this period (from PAS)
      if (p.pasRotations && p.pasRotations.length) {
        html += '<h3>Rotations (from PAS)</h3>';
        for (const r of p.pasRotations) html += pasRotationHtml(p, r);
      }
      // rotation-display texts touching this period
      for (const rotNo of Object.keys(ctx.rotationsByNbr)) {
        const onCard = p.card && p.card.lines.some(it => it.rot === rotNo);
        const inPas = p.pasRotations && p.pasRotations.some(r => r.rot === rotNo);
        if (onCard && !inPas) html += rotationTextHtml(ctx, ctx.rotationsByNbr[rotNo]);
      }
      html += '</section>';
    }

    // cross-period checks
    const multi = byPeriod['multi'] || [];
    // rotation texts not attached to any period
    let orphanRots = '';
    for (const rotNo of Object.keys(ctx.rotationsByNbr)) {
      const attached = ctx.sortedMonths.some(bm => {
        const p = ctx.periods[bm];
        return (p.card && p.card.lines.some(it => it.rot === rotNo)) || (p.pasRotations || []).some(r => r.rot === rotNo);
      });
      if (!attached) orphanRots += rotationTextHtml(ctx, ctx.rotationsByNbr[rotNo]);
    }
    if (multi.length || orphanRots) {
      html += '<section class="card"><h2>Cross-period checks</h2>' + multi.map(chkHtml).join('') + orphanRots + '</section>';
    }
    $('periods').innerHTML = html || '<section class="card"><p class="empty">No documents yet. Add a time card, PAS, pay statement, pay stub, or rotation above to start the audit.</p></section>';

    // history
    const hist = PayAudit.historyTotals(ctx);
    if (hist.rows.length) {
      $('historyCard').hidden = false;
      let hh = '<table><tr><th>Period</th><th>Card total</th><th>Statement flight pay</th><th>PAS paid</th><th>Docs</th></tr>';
      for (const r of hist.rows) {
        hh += '<tr><td>' + esc(PayAudit.bidMonthLabel(r.bidMonth)) + '</td><td>' + PayAudit.minToHM(r.cardTotalMin) + '</td><td>' +
          PayAudit.fmtMoney(r.stmtFlightPay) + '</td><td>' + PayAudit.fmtMoney(r.pasPaid) + '</td><td>' + esc(r.docs.join(', ')) + '</td></tr>';
      }
      hh += '<tr class="total"><td>All loaded periods</td><td>' + PayAudit.minToHM(hist.totals.cardTotalMin) + '</td><td>' +
        PayAudit.fmtMoney(hist.totals.stmtFlightPay) + '</td><td>' + PayAudit.fmtMoney(hist.totals.pasPaid) + '</td><td></td></tr></table>';
      const qs = Object.keys(hist.quarters).sort();
      if (qs.length > 1) {
        hh += '<h3>By calendar quarter</h3><table><tr><th>Quarter</th><th>Statement flight pay</th><th>PAS paid</th></tr>' +
          qs.map(q => '<tr><td>' + esc(q) + '</td><td>' + PayAudit.fmtMoney(hist.quarters[q].stmtFlightPay) + '</td><td>' + PayAudit.fmtMoney(hist.quarters[q].pasPaid) + '</td></tr>').join('') + '</table>';
      }
      if (hist.totals.profitSharing) hh += '<p class="mut">Profit sharing seen on stubs: ' + PayAudit.fmtMoney(hist.totals.profitSharing) + ' (not flight pay; excluded from the columns above).</p>';
      $('historyBody').innerHTML = hh;
    } else $('historyCard').hidden = true;
  }

  function pasRotationHtml(p, r) {
    // equipment classes via PAS ship/equip codes
    const classSet = {};
    for (const l of r.legs) {
      const e = String(l.equip || '').replace(/\*/g, '');
      const map = { '320': 'A320', '319': 'A319', '321': 'A321', '3N1': 'A321 NEO', '3NE': 'A321 NEO' };
      if (map[e]) classSet[map[e]] = true;
    }
    const classNames = Object.keys(classSet);
    let est = '';
    if (classNames.length === 1 && p.pas && p.pas.rates[classNames[0]] && r.rotationPayHours) {
      est = ' · est. value at ' + classNames[0] + ' rate: <b>' +
        PayAudit.fmtMoney(Math.round(r.rotationPayHours / 60 * p.pas.rates[classNames[0]] * 100) / 100) + '</b> (estimate)';
    } else if (classNames.length > 1) est = ' · mixed equipment (' + classNames.join(', ') + ') — priced per leg in the PAS summary';
    const comps = r.components.filter(c => c.label !== 'ROTATION PAY HOURS' && c.label !== 'TAFB CR' && c.label !== 'TAFB EX');
    return '<div class="rot"><h4>Rotation ' + esc(r.rot) + (r.dup ? ' (dup ' + esc(r.dup) + ')' : '') +
      (r.award ? ' · award ' + esc(r.award) : '') + '</h4>' +
      '<div class="kv"><span>Legs <b>' + r.legs.length + '</b></span><span>Rotation pay hours <b>' + PayAudit.minToHM(r.rotationPayHours) +
      '</b></span><span>TAFB <b>' + PayAudit.minToHM(r.tafbEx) + '</b></span>' + est + '</div>' +
      (comps.length ? '<table><tr><th>Component</th><th>Time</th></tr>' +
        comps.map(c => '<tr><td>' + esc(c.label) + '</td><td>' + PayAudit.minToHM(c.hrs) + '</td></tr>').join('') + '</table>' : '') +
      '</div>';
  }

  function rotationTextHtml(ctx, rot) {
    if (!rot || !rot.rot) return '';
    const parts = PayAudit.splitRotation(rot, ctx.periodRanges);
    const partTxt = parts && parts.length > 1 ?
      '<div class="kv"><span>Bid-period split: <b>' + parts.map(x =>
        (x.bidMonth === 'prior' ? 'prior period' : x.bidMonth === 'next' ? 'carryout (next period)' : PayAudit.bidMonthLabel(x.bidMonth)) +
        ' ' + PayAudit.minToHM(x.minutes)).join(' · ') + '</b></span></div>' : '';
    return '<div class="rot"><h4>Rotation ' + esc(rot.rot) + ' (iCrew display)</h4>' +
      '<div class="kv"><span>Pay &amp; credit <b>' + PayAudit.minToHM(rot.payCredit) + '</b></span>' +
      '<span>Pay, no credit <b>' + PayAudit.minToHM(rot.payNoCredit) + '</b> (SIT ' + PayAudit.minToHM(rot.sit || 0) +
      ' · EDP ' + PayAudit.minToHM(rot.edp || 0) + ')</span>' +
      '<span>Total pay <b>' + PayAudit.minToHM(rot.totalPay) + '</b></span>' +
      '<span>Block <b>' + PayAudit.minToHM(rot.blockTotal) + '</b></span>' +
      '<span>Deadhead <b>' + PayAudit.minToHM(rot.dhdTotal) + '</b></span>' +
      '<span>TAFB <b>' + PayAudit.minToHM(rot.tafbEx) + '</b></span></div>' +
      '<table><tr><th>Duty period</th><th>Legs</th><th>DP total (TL)</th></tr>' +
      rot.dps.map(d => '<tr><td>Day ' + esc(d.startDay) + '</td><td>' + d.legs.map(l => esc(l.flight) + ' ' + esc(l.from) + '→' + esc(l.to) + (l.dh ? ' (DH)' : '')).join(', ') +
        '</td><td>' + PayAudit.minToHM(d.tl) + '</td></tr>').join('') + '</table>' + partTxt + '</div>';
  }

  // wire up inputs
  $('addBtn').addEventListener('click', () => { $('addMsg').textContent = addText($('pasteBox').value, 'Pasted document'); $('pasteBox').value = ''; });
  $('clearBtn').addEventListener('click', () => { docs = []; save(); render(); $('addMsg').textContent = 'All documents removed.'; });
  const readFile = async (f) => {
    const buf = await f.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 2));
    const isZip = /\.zip$/i.test(f.name) || (head[0] === 0x50 && head[1] === 0x4b); // 'PK' signature
    if (!isZip) return addText(new TextDecoder().decode(buf), f.name);
    let entries;
    try { entries = await PayAudit.unzipTextFiles(buf); }
    catch (e) { return 'Could not open ' + f.name + ': ' + e.message; }
    const usable = entries.filter(en => /\.(csv|txt|text)$/i.test(en.name) || !/\./.test(en.name));
    if (!usable.length) return 'No text documents found inside ' + f.name + '.';
    let added = 0, failed = 0;
    for (const en of usable) {
      const before = docs.length;
      addText(en.text, en.name);
      if (docs.length > before) added++; else failed++;
    }
    return 'Opened ' + f.name + ': added ' + added + ' document' + (added === 1 ? '' : 's') +
      (failed ? '; ' + failed + ' file' + (failed === 1 ? '' : 's') + ' not recognized' : '') + '.';
  };
  $('fileInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    files.reduce((pr, f) => pr.then(() => readFile(f)), Promise.resolve())
      .then(msg => { if (msg) $('addMsg').textContent = msg; });
    e.target.value = '';
  });
  const dz = $('dropZone');
  const card = $('addCard');
  card.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  card.addEventListener('dragleave', () => dz.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); dz.classList.remove('over');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    files.reduce((pr, f) => pr.then(() => readFile(f)), Promise.resolve())
      .then(msg => { if (msg) $('addMsg').textContent = msg; });
  });
  render();
}
