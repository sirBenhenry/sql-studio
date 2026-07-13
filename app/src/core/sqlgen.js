/* AUTO-EXTRACTED from sql-studio.html (script block 2) — DO NOT EDIT HERE.
   Edit the lite tool, then re-run: node scripts/extract-core.mjs
   Drift is caught by: npm run test:core */

/* ============================================================
   sqlgen.js — turns the builder state into SQL.
   Produces "segments": { t: text, c: cssClass, p: partId }
   so the UI can syntax-highlight AND hover-link every piece
   back to its sentence chip.
   ============================================================ */

(function () {
  'use strict';

  /* Operators: how they read in the sentence and how they compile. */
  const OPS = {
    eq:       { sql: '=',  phrase: 'is',               kind: 'scalar' },
    neq:      { sql: '<>', phrase: 'is not',           kind: 'scalar' },
    gt:       { sql: '>',  phrase: 'is greater than',  kind: 'scalar' },
    lt:       { sql: '<',  phrase: 'is less than',     kind: 'scalar' },
    gte:      { sql: '>=', phrase: 'is at least',      kind: 'scalar' },
    lte:      { sql: '<=', phrase: 'is at most',       kind: 'scalar' },
    contains: { phrase: 'contains',     kind: 'like', tpl: v => '%' + v + '%' },
    starts:   { phrase: 'starts with',  kind: 'like', tpl: v => v + '%' },
    ends:     { phrase: 'ends with',    kind: 'like', tpl: v => '%' + v },
    lenIs:    { phrase: 'has exactly … letters', kind: 'plen' },
    nthIs:    { phrase: 'has letter nr. … from the START =', kind: 'pnth' },
    nthLastIs:{ phrase: 'has letter nr. … from the END =', kind: 'pnthlast' },
    between:  { phrase: 'is between',   kind: 'between' },
    in:       { phrase: 'is one of',    kind: 'set', not: false },
    nin:      { phrase: 'is none of',   kind: 'set', not: true },
    isnull:   { sql: 'IS NULL',     phrase: 'is empty',      kind: 'null' },
    notnull:  { sql: 'IS NOT NULL', phrase: 'is not empty',  kind: 'null' }
  };

  const AGG_FNS = {
    COUNT:   { phrase: 'the number of' },
    COUNT_D: { phrase: 'the number of different' },
    SUM:     { phrase: 'the total' },
    AVG:     { phrase: 'the average' },
    MIN:     { phrase: 'the lowest' },
    MAX:     { phrase: 'the highest' }
  };

  /* aggregate call — COUNT_D is the pseudo-fn for COUNT(DISTINCT col) */
  function pushAggFn(push, fn, colText, p) {
    if (fn === 'COUNT_D') {
      push('COUNT', 'f', p); push('(', '', p);
      push('DISTINCT', 'k', p); push(' ', '', p);
      push(colText, 'i', p); push(')', '', p);
    } else {
      push(fn, 'f', p); push('(', '', p); push(colText, 'i', p); push(')', '', p);
    }
  }

  /* formula-column templates: exercise phrases → SQL expressions */
  const CALCS = {
    length:   { label: 'the number of letters in …', params: [] },
    sqrt:     { label: 'the square root of …', params: [] },
    round:    { label: 'rounded to … decimals', params: ['n'] },
    abs:      { label: 'the absolute value of …', params: [] },
    upper:    { label: '… in UPPERCASE', params: [] },
    lower:    { label: '… in lowercase', params: [] },
    trim:     { label: '… without surrounding spaces', params: [] },
    replace:  { label: 'replace text inside …', params: ['find', 'repl'] },
    concat:   { label: 'combine two columns into one', params: ['sep', 'col2'] },
    month:    { label: 'the month name of …', params: [] },
    yearOf:   { label: 'the year of …', params: [] },
    monthOf:  { label: 'the month number of …', params: [] },
    dayOf:    { label: 'the day of …', params: [] },
    datediff: { label: 'the days between two dates', params: ['col2'] },
    firstn:   { label: 'the first … letters of …', params: ['n'] },
    before:   { label: 'the part of … before a character', params: ['ch'] },
    after:    { label: 'the part of … after a character', params: ['ch'] },
    initials: { label: 'the initials of two columns', params: ['col2'] },
    vat:      { label: 'the …% tax included in …', params: ['n', 'round5'] },
    math:     { label: 'a calculation ( + − × ÷ )', params: ['mop', 'n'] }
  };

  function calcAlias(it) {
    if (it.alias) return it.alias.trim().replace(/\W+/g, '_');
    switch (it.fn) {
      case 'sqrt': return 'sqrt_' + it.col;
      case 'round': return 'rounded_' + it.col;
      case 'abs': return 'abs_' + it.col;
      case 'upper': return 'upper_' + it.col;
      case 'lower': return 'lower_' + it.col;
      case 'trim': return 'trimmed_' + it.col;
      case 'replace': return it.col + '_replaced';
      case 'concat': return 'combined';
      case 'month': return 'month_name';
      case 'yearOf': return 'year_' + it.col;
      case 'monthOf': return 'month_' + it.col;
      case 'dayOf': return 'day_' + it.col;
      case 'datediff': return 'days_between';
      case 'length': return 'letters_in_' + it.col;
      case 'firstn': return 'first_letters';
      case 'before': return it.col + '_part1';
      case 'after': return it.col + '_part2';
      case 'initials': return 'initials';
      case 'vat': return 'vat';
      case 'math': return 'calculated_' + it.col;
      default: return 'calc';
    }
  }

  function isNumericLiteral(v) {
    return /^-?\d+(\.\d+)?$/.test(String(v).trim());
  }

  function escStr(v) {
    // backslashes are escapes in MySQL's default sql_mode — 'C:\tmp' would
    // store a TAB without the doubling
    return String(v).replace(/\\/g, '\\\\').replace(/'/g, "''");
  }

  function aggAlias(item) {
    if (item.fn === 'COUNT' && item.col === '*') return 'amount';
    if (item.fn === 'COUNT_D') return 'distinct_' + item.col;
    return item.fn.toLowerCase() + '_' + item.col;
  }

  /* ---------- segment generation ---------- */

  function generateSegments(Q, schema) {
    const segs = [];
    const push = (t, c, p) => segs.push({ t, c: c || '', p: p || null });

    if (!Q.from) {
      push('-- Pick a table in step 2 to start building…', 'c');
      return segs;
    }

    const multi = Q.joins.length > 0;
    const qn = (table, col) => (multi ? table + '.' + col : col);

    function colInfo(table, col) {
      const t = schema.byName[table];
      return t ? t.columns.find(c => c.name === col) : null;
    }

    /* formula column: expression + AS alias */
    function pushCalc(it, p) {
      const col = qn(it.table, it.col);
      const fnCall = (name, argsFn) => {
        push(name, 'f', p); push('(', '', p); argsFn(); push(')', '', p);
      };
      switch (it.fn) {
        case 'sqrt': fnCall('SQRT', () => push(col, 'i', p)); break;
        case 'month': fnCall('MONTHNAME', () => push(col, 'i', p)); break;
        case 'length': fnCall('CHAR_LENGTH', () => push(col, 'i', p)); break;
        case 'firstn':
          fnCall('LEFT', () => {
            push(col, 'i', p); push(', ', '', p);
            push(String(Math.max(1, parseInt(it.n, 10) || 1)), 'n', p);
          });
          break;
        case 'before':
        case 'after':
          fnCall('SUBSTRING_INDEX', () => {
            push(col, 'i', p); push(', ', '', p);
            push("'" + escStr(it.ch || '@') + "'", 's', p); push(', ', '', p);
            push(it.fn === 'before' ? '1' : '-1', 'n', p);
          });
          break;
        case 'initials':
          fnCall('CONCAT', () => {
            fnCall('LEFT', () => { push(col, 'i', p); push(', ', '', p); push('1', 'n', p); });
            push(', ', '', p);
            fnCall('LEFT', () => { push(qn(it.table2, it.col2), 'i', p); push(', ', '', p); push('1', 'n', p); });
          });
          break;
        case 'vat': {
          const rate = Number(it.n) || 8;
          if (it.round5) {
            fnCall('ROUND', () => {
              push(col, 'i', p);
              push(' / ', '', p); push(String(100 + rate), 'n', p);
              push(' * ', '', p); push(String(rate), 'n', p);
              push(' * ', '', p); push('20', 'n', p);
            });
            push(' / ', '', p); push('20', 'n', p);
          } else {
            fnCall('ROUND', () => {
              push(col, 'i', p);
              push(' / ', '', p); push(String(100 + rate), 'n', p);
              push(' * ', '', p); push(String(rate), 'n', p);
              push(', ', '', p); push('2', 'n', p);
            });
          }
          break;
        }
        case 'math': {
          const sym = { plus: '+', minus: '-', times: '*', div: '/' }[it.mop] || '*';
          push(col, 'i', p); push(' ' + sym + ' ', '', p); push(String(it.n ?? 1), 'n', p);
          break;
        }
        case 'round':
          fnCall('ROUND', () => {
            push(col, 'i', p); push(', ', '', p);
            push(String(parseInt(it.n, 10) >= 0 ? parseInt(it.n, 10) : 2), 'n', p);
          });
          break;
        case 'abs': fnCall('ABS', () => push(col, 'i', p)); break;
        case 'upper': fnCall('UPPER', () => push(col, 'i', p)); break;
        case 'lower': fnCall('LOWER', () => push(col, 'i', p)); break;
        case 'trim': fnCall('TRIM', () => push(col, 'i', p)); break;
        case 'replace':
          fnCall('REPLACE', () => {
            push(col, 'i', p); push(', ', '', p);
            push("'" + escStr(it.find ?? '') + "'", 's', p); push(', ', '', p);
            push("'" + escStr(it.repl ?? '') + "'", 's', p);
          });
          break;
        case 'concat':
          fnCall('CONCAT', () => {
            push(col, 'i', p); push(', ', '', p);
            push("'" + escStr(it.sep ?? ' ') + "'", 's', p); push(', ', '', p);
            push(qn(it.table2, it.col2), 'i', p);
          });
          break;
        case 'yearOf': fnCall('YEAR', () => push(col, 'i', p)); break;
        case 'monthOf': fnCall('MONTH', () => push(col, 'i', p)); break;
        case 'dayOf': fnCall('DAY', () => push(col, 'i', p)); break;
        case 'datediff':
          fnCall('DATEDIFF', () => {
            push(col, 'i', p); push(', ', '', p);
            push(qn(it.table2, it.col2), 'i', p);
          });
          break;
      }
      push(' ', '', p); push('AS', 'k', p); push(' ', '', p); push(calcAlias(it), 'i', p);
    }

    /* value segment, quoted or not depending on column type */
    function pushVal(v, info, p) {
      const s = String(v).trim();
      if (info && info.boolean && /^(true|false)$/i.test(s)) {
        push(s.toUpperCase(), 'k', p);
        return;
      }
      const numericCtx = info ? info.numeric : isNumericLiteral(v);
      if (numericCtx && isNumericLiteral(v)) push(s, 'n', p);
      else push("'" + escStr(v) + "'", 's', p);
    }

    /* subquery: (SELECT [FN(]col[)] FROM table [WHERE col op val])
       Correlated form (sub.cSame): the filter compares against the SAME
       column of the outer row — e.g. "the average price of its own genre":
       (SELECT AVG(x.price) FROM book x WHERE x.fk_genre_id = book.fk_genre_id).
       The sub table gets an alias so it can safely be the outer table too. */
    function pushSub(sub, p, outerTable) {
      const correlated = !!(sub.hasCond && sub.cSame && sub.cCol && outerTable);
      const al = correlated ? 'x' : null;
      const q = c => (al ? al + '.' + c : c);
      push('(', '', p);
      push('SELECT', 'k', p);
      push(' ', '', p);
      if (sub.fn) {
        pushAggFn(push, sub.fn, q(sub.col), p);
      } else {
        push(q(sub.col), 'i', p);
      }
      push(' ', '', p);
      push('FROM', 'k', p);
      push(' ', '', p);
      push(sub.table, 'i', p);
      if (al) { push(' ', '', p); push(al, 'i', p); }
      if (sub.hasCond && sub.cCol && (sub.cOp || correlated)) {
        push(' ', '', p);
        push('WHERE', 'k', p);
        push(' ', '', p);
        push(q(sub.cCol), 'i', p);
        if (correlated) {
          push(' = ', 'k', p);
          push(outerTable + '.' + sub.cCol, 'i', p);
        } else {
          pushCore(sub.cOp, { v1: sub.cVal, v2: sub.cVal2 }, colInfo(sub.table, sub.cCol), p);
        }
      }
      push(')', '', p);
    }

    /* the operator + right-hand side of a condition on a plain value */
    function pushCore(opKey, vals, info, p) {
      const op = OPS[opKey];
      if (!op) return;
      if (op.kind === 'null') {
        push(' ', '', p); push(op.sql, 'k', p);
      } else if (op.kind === 'like') {
        push(' ', '', p); push('LIKE', 'k', p); push(' ', '', p);
        push("'" + escStr(op.tpl(vals.v1 ?? '')) + "'", 's', p);
      } else if (op.kind === 'between') {
        push(' ', '', p); push('BETWEEN', 'k', p); push(' ', '', p);
        pushVal(vals.v1 ?? '', info, p);
        push(' ', '', p); push('AND', 'k', p); push(' ', '', p);
        pushVal(vals.v2 ?? '', info, p);
      } else if (op.kind === 'plen') {
        const n = Math.max(1, parseInt(vals.v1, 10) || 1);
        push(' ', '', p); push('LIKE', 'k', p); push(' ', '', p);
        push("'" + '_'.repeat(n) + "'", 's', p);
      } else if (op.kind === 'pnth' || op.kind === 'pnthlast') {
        const n = Math.max(1, parseInt(vals.v1, 10) || 1);
        const letter = escStr(vals.v2 ?? '');
        push(' ', '', p); push('LIKE', 'k', p); push(' ', '', p);
        if (op.kind === 'pnth') push("'" + '_'.repeat(n - 1) + letter + "%'", 's', p);
        else push("'%" + letter + '_'.repeat(n - 1) + "'", 's', p);
      } else if (op.kind === 'set') {
        push(' ', '', p);
        if (op.not) { push('NOT', 'k', p); push(' ', '', p); }
        push('IN', 'k', p); push(' (', '', p);
        const items = String(vals.v1 ?? '').split(',').map(s => s.trim()).filter(Boolean);
        items.forEach((it, i) => { if (i) push(', ', '', p); pushVal(it, info, p); });
        push(')', '', p);
      } else { // scalar
        push(' ' + op.sql + ' ', 'k', p);
        pushVal(vals.v1 ?? '', info, p);
      }
    }

    /* ----- SELECT ----- */
    push('SELECT', 'k', 'select-head');
    push(' ');
    if (Q.distinct) { push('DISTINCT', 'k', 'distinct'); push(' '); }

    const items = Q.select.length ? Q.select : [{ kind: 'all' }];
    items.forEach((it, i) => {
      if (i) push(', ');
      const p = Q.select.length ? 'select-' + i : 'select-head';
      if (it.kind === 'all') {
        push('*', 'i', p);
      } else if (it.kind === 'col') {
        push(qn(it.table, it.col), 'i', p);
      } else if (it.kind === 'calc') {
        pushCalc(it, p);
      } else { // agg
        pushAggFn(push, it.fn, it.col === '*' ? '*' : qn(it.table, it.col), p);
        push(' ', '', p);
        push('AS', 'k', p);
        push(' ', '', p);
        push(aggAlias(it), 'i', p);
      }
    });

    /* ----- FROM ----- */
    push('\n');
    push('FROM', 'k', 'from');
    push(' ');
    push(Q.from, 'i', 'from');

    /* ----- JOINs ----- */
    Q.joins.forEach((j, i) => {
      const p = 'join-' + i;
      push('\n');
      if (j.type === 'LEFT') { push('LEFT JOIN', 'k', p); }
      else { push('JOIN', 'k', p); }
      push(' ', '', p);
      push(j.table, 'i', p);
      push(' ', '', p);
      push('ON', 'k', p);
      push(' ', '', p);
      push(j.baseTable + '.' + j.baseCol, 'i', p);
      push(' = ', 'k', p);
      push(j.table + '.' + j.joinCol, 'i', p);
    });

    /* ----- WHERE ----- */
    if (Q.where.length) {
      push('\n');
      push('WHERE', 'k', 'where-head');
      Q.where.forEach((w, i) => {
        const p = 'where-' + i;
        if (i) {
          push('\n  ');
          push(w.conj || 'AND', 'k', 'conj-' + i);
        }
        push(' ', '', p);
        push(qn(w.table, w.col), 'i', p);
        const op = OPS[w.op];
        const info = colInfo(w.table, w.col);
        if (w.src === 'lookup' && w.lookup) {
          // FK-by-name: col IN (SELECT ret FROM ref WHERE human = val …)
          push(' ', '', p);
          push('IN', 'k', p); push(' ', '', p);
          pushLookup(push, w.lookup, schema, p);
        } else if (op.kind === 'scalar' && w.src === 'column') {
          push(' ' + op.sql + ' ', 'k', p);
          push(qn(w.cmpTable, w.cmpCol), 'i', p);
        } else if (op.kind === 'scalar' && w.src === 'sub') {
          push(' ' + op.sql + ' ', 'k', p);
          pushSub(w.sub, p, w.table);
        } else if (op.kind === 'set' && w.src === 'sub') {
          push(' ', '', p);
          if (op.not) { push('NOT', 'k', p); push(' ', '', p); }
          push('IN', 'k', p); push(' ', '', p);
          pushSub(w.sub, p, w.table);
        } else {
          pushCore(w.op, { v1: w.v1, v2: w.v2 }, info, p);
        }
      });
    }

    /* ----- GROUP BY ----- */
    if (Q.groupBy.length) {
      push('\n');
      push('GROUP BY', 'k', 'group-head');
      push(' ');
      Q.groupBy.forEach((g, i) => {
        if (i) push(', ');
        push(qn(g.table, g.col), 'i', 'group-' + i);
      });
    }

    /* ----- HAVING ----- */
    if (Q.having.length) {
      push('\n');
      push('HAVING', 'k', 'having-head');
      Q.having.forEach((h, i) => {
        const p = 'having-' + i;
        if (i) {
          push('\n  ');
          push(h.conj || 'AND', 'k', 'hconj-' + i);
        }
        push(' ', '', p);
        pushAggFn(push, h.fn, h.col ? qn(h.col.table, h.col.col) : '*', p);
        const op = OPS[h.op] || OPS.gte;
        push(' ' + op.sql + ' ', 'k', p);
        if (h.src === 'sub' && h.sub) {
          pushSub(h.sub, p, h.col ? h.col.table : null);
        } else if (isNumericLiteral(h.value)) {
          push(String(h.value).trim(), 'n', p);
        } else {
          push("'" + escStr(h.value ?? '') + "'", 's', p);
        }
      });
    }

    /* ----- ORDER BY ----- */
    if (Q.orderBy.length) {
      push('\n');
      push('ORDER BY', 'k', 'order-head');
      push(' ');
      Q.orderBy.forEach((o, i) => {
        const p = 'order-' + i;
        if (i) push(', ');
        if (o.kind === 'agg') push(aggAlias(o), 'i', p);
        else push(qn(o.table, o.col), 'i', p);
        if (o.dir === 'DESC') { push(' ', '', p); push('DESC', 'k', p); }
      });
    }

    /* ----- LIMIT ----- */
    if (Q.limit && Q.limit.n) {
      push('\n');
      push('LIMIT', 'k', 'limit');
      push(' ', '', 'limit');
      push(String(Q.limit.n), 'n', 'limit');
      if (Q.limit.offset) {
        push(' ', '', 'limit');
        push('OFFSET', 'k', 'limit');
        push(' ', '', 'limit');
        push(String(Q.limit.offset), 'n', 'limit');
      }
    }

    push(';');
    return segs;
  }

  function segmentsToText(segs) {
    return segs.map(s => s.t).join('');
  }

  function renderSegments(container, segs) {
    container.textContent = '';
    for (const s of segs) {
      if (!s.c && !s.p) {
        container.appendChild(document.createTextNode(s.t));
      } else {
        const span = document.createElement('span');
        span.textContent = s.t;
        if (s.c) span.className = s.c;
        if (s.p) span.setAttribute('data-part', s.p);
        container.appendChild(span);
      }
    }
  }

  /* ---------- static syntax highlighter for the reference ---------- */

  const KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT ORDER GROUP BY HAVING AS DISTINCT LIMIT OFFSET ' +
    'JOIN LEFT RIGHT INNER OUTER ON BETWEEN IN LIKE IS NULL ASC DESC UNION EXISTS ANY ALL ' +
    'CASE WHEN THEN ELSE END').split(' '));
  const FUNCS = new Set('COUNT SUM AVG MIN MAX ROUND CONCAT UPPER LOWER NOW YEAR MONTH DAY'.split(' '));

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightStatic(text) {
    const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][\w$]*\b)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(text)) !== null) {
      out += escHtml(text.slice(last, m.index));
      if (m[1]) out += '<span class="c">' + escHtml(m[1]) + '</span>';
      else if (m[2]) out += '<span class="s">' + escHtml(m[2]) + '</span>';
      else if (m[3]) out += '<span class="n">' + escHtml(m[3]) + '</span>';
      else {
        const w = m[4], up = w.toUpperCase();
        if (KEYWORDS.has(up)) out += '<span class="k">' + escHtml(w) + '</span>';
        else if (FUNCS.has(up)) out += '<span class="f">' + escHtml(w) + '</span>';
        else out += escHtml(w);
      }
      last = re.lastIndex;
    }
    out += escHtml(text.slice(last));
    return out;
  }

  /* ============================================================
     CREATE-mode generation.
     C = { boiler, dbName, tables: [ { name, cols: [
       { name, type, args, uns, nn, ai, pk, uq, def,
         fk: { t: tableIndex, c: colIndex, onUpdate, onDelete } | null } ] } ] }
     Tables are emitted in dependency order (referenced tables first).
     Circular references fall back to ALTER TABLE at the end.
     ============================================================ */

  function cleanName(n, fallback) {
    n = String(n || '').trim().replace(/\s+/g, '_').replace(/[^\w$]/g, '');
    return n || fallback;
  }

  function generateCreateSegments(C, existing) {
    const segs = [];
    const push = (t, c, p) => segs.push({ t, c: c || '', p: p || null });
    const existByName = (existing && existing.byName) || {};

    const tables = (C.tables || []).map((t, i) => ({
      idx: i,
      name: cleanName(t.name, 'table_' + (i + 1)),
      cols: t.cols || []
    }));
    const byIdx = {};
    tables.forEach(t => { byIdx[t.idx] = t; });

    /* split an existing column's parsed type "DECIMAL(6,2)" into name + args */
    function splitType(typeStr) {
      const s = String(typeStr || 'INT');
      const mm = s.match(/^([a-zA-Z]+)(?:\(([^)]*)\))?/);
      return { type: mm ? mm[1].toUpperCase() : 'INT', args: mm && mm[2] ? mm[2] : '' };
    }

    /* resolve a fk (internal by index, or external to a loaded table) to a
       normalized target {name, refCol, type, args, uns} — or null if unresolved */
    function resolveFk(fk) {
      if (!fk) return null;
      if (fk.ext) {
        const et = existByName[fk.ext];
        if (!et) return null;
        const ec = et.columns.find(x => x.name === fk.extCol) || et.columns.find(x => x.pk) || et.columns[0];
        const st = splitType(ec && ec.type);
        return { name: fk.ext, refCol: (ec && ec.name) || 'id', type: st.type, args: st.args, uns: !!(ec && ec.unsigned) };
      }
      const target = byIdx[fk.t];
      if (!target) return null;
      const rc = target.cols[fk.c];
      return { name: target.name, refCol: rc ? cleanName(rc.name, 'column_' + (fk.c + 1)) : 'id', type: rc && rc.type, args: rc && rc.args, uns: rc && rc.uns };
    }

    if (C.boiler) {
      const db = cleanName(C.dbName, 'my_database');
      const bp = 'boiler';
      push('DROP DATABASE IF EXISTS', 'k', bp); push(' ', '', bp); push(db, 'i', bp); push(';\n', '', bp);
      push('CREATE DATABASE', 'k', bp); push(' ', '', bp); push(db, 'i', bp); push(';\n', '', bp);
      push('USE', 'k', bp); push(' ', '', bp); push(db, 'i', bp); push(';\n', '', bp);
      if (tables.length) push('\n');
    }

    if (!tables.length) {
      push('-- Add a table to start designing…', 'c');
      return segs;
    }

    const colName = (t, j) => cleanName(t.cols[j] && t.cols[j].name, 'column_' + (j + 1));

    /* dependency order: a table waits until every table it references is emitted */
    const emitted = new Set();
    const order = [];
    const remaining = tables.slice();
    let progress = true;
    while (remaining.length && progress) {
      progress = false;
      for (let i = 0; i < remaining.length; i++) {
        const t = remaining[i];
        const deps = t.cols
          .filter(c => c.fk && !c.fk.ext && byIdx[c.fk.t] && c.fk.t !== t.idx)
          .map(c => c.fk.t);
        if (deps.every(d => emitted.has(d))) {
          order.push({ t, deferred: [] });
          emitted.add(t.idx);
          remaining.splice(i, 1);
          i--;
          progress = true;
        }
      }
    }
    /* leftovers form a reference circle: create them anyway,
       move the impossible keys to ALTER TABLE afterwards */
    const alters = [];
    for (const t of remaining) {
      const deferred = t.cols.filter(c =>
        c.fk && !c.fk.ext && byIdx[c.fk.t] && c.fk.t !== t.idx && !emitted.has(c.fk.t));
      order.push({ t, deferred });
      emitted.add(t.idx);
      deferred.forEach(c => alters.push({ t, c }));
    }

    function pushDefault(d, p) {
      d = String(d).trim();
      if (SQL_FUNC_RE.test(d)) push(d.toUpperCase(), 'f', p);
      else if (/^-?\d+(\.\d+)?$/.test(d)) push(d, 'n', p);
      else if (/^(TRUE|FALSE|NULL)$/i.test(d)) push(d.toUpperCase(), 'k', p);
      else push("'" + d.replace(/'/g, "''") + "'", 's', p);
    }

    function pushColDef(t, c, j, p) {
      push(' ', '', p);
      push(colName(t, j), 'i', p);
      /* a resolved FK column must match its referenced column exactly
         (type + args + UNSIGNED), or MariaDB throws errno 150. Always
         derive from the target so it can't drift out of sync. */
      let effType = c.type, effArgs = c.args, effUns = c.uns;
      const rf = resolveFk(c.fk);
      if (rf) { effType = rf.type; effArgs = rf.args; effUns = rf.uns; }
      let type = (effType || 'INT').toUpperCase();
      const args = String(effArgs || '').trim();
      if (args) type += '(' + args + ')';
      push(' ' + type, 'k', p);
      if (effUns) push(' UNSIGNED', 'k', p);
      if (c.nn) push(' NOT NULL', 'k', p);
      if (c.uq) push(' UNIQUE', 'k', p);
      if (c.ai) push(' AUTO_INCREMENT', 'k', p);
      if ((c.def ?? '') !== '' && String(c.def).trim() !== '') {
        push(' ', '', p); push('DEFAULT', 'k', p); push(' ', '', p);
        pushDefault(c.def, p);
      }
      // allowed range → CHECK constraint (MySQL 8.0.16+ / MariaDB 10.2+)
      const hasMin = (c.chkMin ?? '') !== '' && String(c.chkMin).trim() !== '';
      const hasMax = (c.chkMax ?? '') !== '' && String(c.chkMax).trim() !== '';
      if (hasMin || hasMax) {
        push(' ', '', p); push('CHECK', 'k', p); push(' (', '', p);
        push(colName(t, j), 'i', p);
        if (hasMin && hasMax) {
          push(' ', '', p); push('BETWEEN', 'k', p); push(' ', '', p);
          pushDefault(String(c.chkMin).trim(), p);
          push(' ', '', p); push('AND', 'k', p); push(' ', '', p);
          pushDefault(String(c.chkMax).trim(), p);
        } else if (hasMin) {
          push(' >= ', 'k', p); pushDefault(String(c.chkMin).trim(), p);
        } else {
          push(' <= ', 'k', p); pushDefault(String(c.chkMax).trim(), p);
        }
        push(')', '', p);
      }
    }

    function pushFk(t, c, j, p) {
      const rf = resolveFk(c.fk);
      if (!rf) return;
      push('FOREIGN KEY', 'k', p); push('(', '', p);
      push(colName(t, j), 'i', p); push(')', '', p);
      push(' ', '', p); push('REFERENCES', 'k', p); push(' ', '', p);
      push(rf.name, 'i', p); push('(', '', p); push(rf.refCol, 'i', p); push(')', '', p);
      if (c.fk.onUpdate) push(' ON UPDATE ' + c.fk.onUpdate, 'k', p);
      if (c.fk.onDelete) push(' ON DELETE ' + c.fk.onDelete, 'k', p);
    }

    order.forEach(({ t, deferred }, oi) => {
      if (oi) push('\n');
      const tp = 'ctable-' + t.idx;
      t.cols.forEach((c, j) => {
        if (c.isFk && !c.fk) {
          push('-- ⚠ ' + colName(t, j) + ' is marked as FK but references nothing yet\n', 'c', 'ccol-' + t.idx + '-' + j);
        }
      });
      push('CREATE TABLE', 'k', tp); push(' ', '', tp); push(t.name, 'i', tp); push(' (', '', tp); push('\n');

      const emitters = [];
      t.cols.forEach((c, j) => emitters.push(() => pushColDef(t, c, j, 'ccol-' + t.idx + '-' + j)));

      const pks = t.cols.map((c, j) => ({ c, j })).filter(x => x.c.pk);
      if (pks.length) {
        emitters.push(() => {
          push(' ', '', tp); push('PRIMARY KEY', 'k', tp); push('(', '', tp);
          pks.forEach((x, k) => { if (k) push(', ', '', tp); push(colName(t, x.j), 'i', tp); });
          push(')', '', tp);
        });
      }
      t.cols.forEach((c, j) => {
        if (!c.fk || !resolveFk(c.fk) || deferred.includes(c)) return;
        emitters.push(() => { push(' ', '', 'ccol-' + t.idx + '-' + j); pushFk(t, c, j, 'ccol-' + t.idx + '-' + j); });
      });

      emitters.forEach((f, k) => { if (k) push(',\n'); f(); });
      push('\n);\n');
    });

    if (alters.length) {
      push('\n');
      push('-- these tables reference each other in a circle,\n', 'c');
      push('-- so the conflicting keys are added afterwards:\n', 'c');
      alters.forEach(({ t, c }) => {
        const j = t.cols.indexOf(c);
        const p = 'ccol-' + t.idx + '-' + j;
        push('ALTER TABLE', 'k', p); push(' ', '', p); push(t.name, 'i', p);
        push(' ', '', p); push('ADD', 'k', p); push(' ', '', p);
        pushFk(t, c, j, p);
        push(';\n', '', p);
      });
    }

    return segs;
  }

  /* ============================================================
     UPDATE / DELETE / ALTER generation (operate on a loaded schema).
     Reuse OPS + escStr + isNumericLiteral.
     ============================================================ */

  function colInfoOf(schema, table, col) {
    const t = schema && schema.byName && schema.byName[table];
    return t ? t.columns.find(c => c.name === col) : null;
  }

  // date/time (and a few common) SQL functions that must stay unquoted
  const SQL_FUNC_RE = /^(NOW\(\)|CURRENT_TIMESTAMP|CURDATE\(\)|CURRENT_DATE|CURTIME\(\)|CURRENT_TIME|LOCALTIMESTAMP|LOCALTIME|UUID\(\))$/i;

  function pushLiteral(push, v, info, p) {
    const s = String(v == null ? '' : v).trim();
    if (info && info.boolean && /^(true|false)$/i.test(s)) { push(s.toUpperCase(), 'k', p); return; }
    if (/^null$/i.test(s)) { push('NULL', 'k', p); return; }
    if (SQL_FUNC_RE.test(s)) { push(s.toUpperCase(), 'f', p); return; }
    const numericCtx = info ? info.numeric : isNumericLiteral(s);
    if (numericCtx && isNumericLiteral(s)) push(s, 'n', p);
    else push("'" + escStr(s) + "'", 's', p);
  }

  /* operator + right-hand side for one WHERE condition */
  function pushOp(push, opKey, vals, info, p) {
    const op = OPS[opKey];
    if (!op) return;
    if (op.kind === 'null') {
      push(' ', '', p); push(op.sql, 'k', p);
    } else if (op.kind === 'like') {
      push(' ', '', p); push('LIKE', 'k', p); push(' ', '', p);
      push("'" + escStr(op.tpl(vals.v1 ?? '')) + "'", 's', p);
    } else if (op.kind === 'between') {
      push(' ', '', p); push('BETWEEN', 'k', p); push(' ', '', p);
      pushLiteral(push, vals.v1, info, p);
      push(' ', '', p); push('AND', 'k', p); push(' ', '', p);
      pushLiteral(push, vals.v2, info, p);
    } else if (op.kind === 'set') {
      push(' ', '', p);
      if (op.not) { push('NOT', 'k', p); push(' ', '', p); }
      push('IN', 'k', p); push(' (', '', p);
      String(vals.v1 ?? '').split(',').map(s => s.trim()).filter(Boolean)
        .forEach((it, i) => { if (i) push(', ', '', p); pushLiteral(push, it, info, p); });
      push(')', '', p);
    } else { // scalar comparison
      push(' ' + op.sql + ' ', 'k', p);
      pushLiteral(push, vals.v1, info, p);
    }
  }

  /* shared WHERE clause: where = [{conj, col, op, v1, v2}]
     or FK-by-name: {conj, col, lookup:{table,ret,matches}, not?} */
  function pushWhere(push, where, schema, table, prefix) {
    if (!where || !where.length) return;
    push('\n');
    push('WHERE', 'k', prefix + '-where');
    where.forEach((w, i) => {
      const p = prefix + '-where-' + i;
      if (i) { push('\n  '); push((w.conj || 'AND'), 'k', p); }
      push(' ', '', p);
      push(w.col, 'i', p);
      if (w.lookup) {
        // fk_col IN (SELECT ret FROM ref WHERE human = val …)
        push(' ', '', p);
        if (w.not) { push('NOT', 'k', p); push(' ', '', p); }
        push('IN', 'k', p); push(' ', '', p);
        pushLookup(push, w.lookup, schema, p, table);
      } else if (w.sub) {
        // col <op> (SELECT AVG(col) FROM table …) — scalar comparison
        const op = OPS[w.op] && OPS[w.op].sql ? OPS[w.op] : OPS.eq;
        push(' ' + op.sql + ' ', 'k', p);
        pushMiniQuery(push, w.sub, schema, p);
      } else {
        pushOp(push, w.op, { v1: w.v1, v2: w.v2 }, colInfoOf(schema, table, w.col), p);
      }
    });
  }

  /* FK-by-name lookup → (SELECT ret FROM table WHERE col = val [AND …]).
     lk = { table, ret, matches:[{col,val}] }. Used for INSERT values and
     conditions so you can reference a row by a human column, not its id.
     targetTable: the table the surrounding INSERT/UPDATE/DELETE modifies —
     MySQL (error 1093) forbids reading it in a subquery, so a lookup into
     the same table is wrapped in a derived table, which materializes it. */
  function pushLookup(push, lk, schema, p, targetTable) {
    const ret = lk.ret || 'id';
    const clash = !!targetTable && lk.table === targetTable;
    push('(', '', p); push('SELECT', 'k', p); push(' ', '', p);
    push(ret, 'i', p); push(' ', '', p);
    push('FROM', 'k', p); push(' ', '', p);
    if (clash) {
      push('(', '', p); push('SELECT', 'k', p); push(' ', '', p);
      push(ret, 'i', p); push(' ', '', p);
      push('FROM', 'k', p); push(' ', '', p);
    }
    push(lk.table, 'i', p);
    const ms = (lk.matches || []).filter(m => m && m.col && String(m.val ?? '').trim() !== '');
    if (ms.length) {
      push(' ', '', p); push('WHERE', 'k', p);
      ms.forEach((m, i) => {
        if (i) { push(' ', '', p); push('AND', 'k', p); }
        push(' ', '', p); push(m.col, 'i', p); push(' = ', 'k', p);
        pushLiteral(push, m.val, colInfoOf(schema, lk.table, m.col), p);
      });
    }
    if (clash) {
      push(')', '', p); push(' ', '', p);
      push('AS', 'k', p); push(' ', '', p); push('_lookup', 'i', p);
    }
    push(')', '', p);
  }

  /* mini-query for DML conditions: sub = {table, fn, col, hasCond, cCol, cOp, cVal}
     → (SELECT [FN(]col[)] FROM table [WHERE cCol op cVal]) */
  function pushMiniQuery(push, sub, schema, p) {
    push('(', '', p); push('SELECT', 'k', p); push(' ', '', p);
    if (sub.fn) pushAggFn(push, sub.fn, sub.col, p);
    else push(sub.col, 'i', p);
    push(' ', '', p); push('FROM', 'k', p); push(' ', '', p); push(sub.table, 'i', p);
    if (sub.hasCond && sub.cCol && sub.cOp) {
      push(' ', '', p); push('WHERE', 'k', p); push(' ', '', p); push(sub.cCol, 'i', p);
      pushOp(push, sub.cOp, { v1: sub.cVal, v2: sub.cVal2 }, colInfoOf(schema, sub.table, sub.cCol), p);
    }
    push(')', '', p);
  }

  /* INSERT — I = { table, cols:[names], rows:[ {colName: value | {lookup}} ] } */
  function generateInsertSegments(I, schema) {
    const segs = [];
    const push = (t, c, p) => segs.push({ t, c: c || '', p: p || null });
    if (!I.table) { push('-- Pick a table to insert into…', 'c'); return segs; }
    const cols = (I.cols || []).filter(Boolean);
    push('INSERT INTO', 'k', 'ins-head'); push(' '); push(I.table, 'i', 'ins-table');
    if (cols.length) {
      push(' (', '');
      cols.forEach((c, i) => { if (i) push(', '); push(c, 'i', 'ins-col-' + i); });
      push(')', '');
    }
    push('\n'); push('VALUES', 'k', 'ins-head');
    const rows = (I.rows && I.rows.length) ? I.rows : [{}];
    rows.forEach((r, ri) => {
      const p = 'ins-row-' + ri;
      if (ri) push(',', '', p);
      push('\n  (', '', p);
      cols.forEach((c, ci) => {
        if (ci) push(', ', '', p);
        const raw = r ? r[c] : '';
        if (raw && typeof raw === 'object' && raw.lookup) pushLookup(push, raw.lookup, schema, p, I.table);
        else if (raw == null || String(raw).trim() === '') push('DEFAULT', 'k', p);
        else pushLiteral(push, raw, colInfoOf(schema, I.table, c), p);
      });
      push(')', '', p);
    });
    push(';');
    return segs;
  }

  function generateDeleteSegments(D, schema) {
    const segs = [];
    const push = (t, c, p) => segs.push({ t, c: c || '', p: p || null });
    if (!D.table) { push('-- Pick a table to delete from…', 'c'); return segs; }
    push('DELETE', 'k', 'del-head'); push(' '); push('FROM', 'k', 'del-head'); push(' ');
    push(D.table, 'i', 'del-from');
    pushWhere(push, D.where, schema, D.table, 'del');
    push(';');
    if (!D.where || !D.where.length) {
      push('\n');
      push('-- ⚠ no condition: this deletes EVERY row in ' + D.table + '!', 'c');
    }
    return segs;
  }

  function generateUpdateSegments(U, schema) {
    const segs = [];
    const push = (t, c, p) => segs.push({ t, c: c || '', p: p || null });
    if (!U.table) { push('-- Pick a table to update…', 'c'); return segs; }
    push('UPDATE', 'k', 'upd-head'); push(' '); push(U.table, 'i', 'upd-table');
    push('\n');
    push('SET', 'k', 'upd-set-head');
    const sets = (U.sets || []).filter(s => s.col);
    if (!sets.length) {
      push(' ', ''); push('…', 'c', 'upd-set-head');
    } else {
      sets.forEach((s, i) => {
        const p = 'upd-set-' + i;
        if (i) push(',', '', p);
        push('\n  ', '', p);
        push(s.col, 'i', p);
        push(' = ', 'k', p);
        const info = colInfoOf(schema, U.table, s.col);
        if (s.mode === 'expr') push(String(s.value ?? '').trim() || 'NULL', 'i', p);
        else pushLiteral(push, s.value, info, p);
      });
    }
    pushWhere(push, U.where, schema, U.table, 'upd');
    push(';');
    if (!U.where || !U.where.length) {
      push('\n');
      push('-- ⚠ no condition: this updates EVERY row in ' + U.table + '!', 'c');
    }
    return segs;
  }

  /* ALTER — A = { table, ops:[ {kind, ...} ] }; one statement per op */
  function alterColDefSegs(push, c, p) {
    let type = (c.type || 'INT').toUpperCase();
    const args = String(c.args || '').trim();
    if (args) type += '(' + args + ')';
    push(' ' + type, 'k', p);
    if (c.uns) push(' UNSIGNED', 'k', p);
    if (c.nn) push(' NOT NULL', 'k', p);
    if (c.uq) push(' UNIQUE', 'k', p);
    if (c.ai) push(' AUTO_INCREMENT', 'k', p);
    if ((c.def ?? '') !== '' && String(c.def).trim() !== '') {
      push(' ', '', p); push('DEFAULT', 'k', p); push(' ', '', p);
      const d = String(c.def).trim();
      if (SQL_FUNC_RE.test(d)) push(d.toUpperCase(), 'f', p);
      else if (/^-?\d+(\.\d+)?$/.test(d)) push(d, 'n', p);
      else if (/^(TRUE|FALSE|NULL)$/i.test(d)) push(d.toUpperCase(), 'k', p);
      else push("'" + escStr(d) + "'", 's', p);
    }
  }

  function generateAlterSegments(A, schema) {
    const segs = [];
    const push = (t, c, p) => segs.push({ t, c: c || '', p: p || null });
    if (!A.table) { push('-- Pick a table to change…', 'c'); return segs; }
    const ops = A.ops || [];
    if (!ops.length) { push('-- No changes yet — edit the table on the left;\n-- the SQL here is the before → after difference.', 'c'); return segs; }

    ops.forEach((op, i) => {
      const p = 'alt-' + i;
      if (i) push('\n');
      push('ALTER TABLE', 'k', p); push(' ', '', p); push(A.table, 'i', p); push(' ', '', p);
      switch (op.kind) {
        case 'add':
          push('ADD', 'k', p); push(' ', '', p); push(cleanName(op.name, 'new_column'), 'i', p);
          alterColDefSegs(push, op, p);
          break;
        case 'drop':
          push('DROP COLUMN', 'k', p); push(' ', '', p); push(op.name || '?', 'i', p);
          break;
        case 'modify':
          push('MODIFY', 'k', p); push(' ', '', p); push(op.name || '?', 'i', p);
          alterColDefSegs(push, op, p);
          break;
        case 'rename':
          push('CHANGE', 'k', p); push(' ', '', p); push(op.name || '?', 'i', p); push(' ', '', p);
          push(cleanName(op.newName, 'new_name'), 'i', p);
          alterColDefSegs(push, op, p);
          break;
        case 'renameTable':
          push('RENAME TO', 'k', p); push(' ', '', p); push(cleanName(op.newName, 'new_table'), 'i', p);
          break;
        case 'addfk': {
          push('ADD FOREIGN KEY', 'k', p); push('(', '', p); push(op.col || '?', 'i', p); push(')', '', p);
          push(' ', '', p); push('REFERENCES', 'k', p); push(' ', '', p);
          push(op.refTable || '?', 'i', p); push('(', '', p); push(op.refCol || 'id', 'i', p); push(')', '', p);
          if (op.onUpdate) push(' ON UPDATE ' + op.onUpdate, 'k', p);
          if (op.onDelete) push(' ON DELETE ' + op.onDelete, 'k', p);
          break;
        }
        case 'dropfk':
          push('DROP FOREIGN KEY', 'k', p); push(' ', '', p); push(op.constraint || 'constraint_name', 'i', p);
          break;
        default:
          push('-- (unknown change)', 'c', p);
      }
      push(';', '', p);
    });
    return segs;
  }

  window.SqlGen = {
    OPS, AGG_FNS, CALCS, aggAlias, calcAlias, cleanName,
    generateSegments, generateCreateSegments,
    generateInsertSegments, generateUpdateSegments, generateDeleteSegments, generateAlterSegments,
    segmentsToText, renderSegments, highlightStatic
  };
})();

