// CSV import/export helpers: parsing, type inference, DDL/INSERT generation,
// and the export writer.
import { parseCSV, parseTSV, inferCsvTable, toCSV } from '../src/csv.js';

let fail = 0;
const ck = (n, c, e) => { if (c) console.log('ok:', n); else { fail++; console.log('FAIL:', n, e ?? ''); } };

// ---- parseCSV ----
ck('simple rows', JSON.stringify(parseCSV('a,b\n1,2\n')) === '[["a","b"],["1","2"]]', JSON.stringify(parseCSV('a,b\n1,2\n')));
ck('quoted commas and "" escapes',
  JSON.stringify(parseCSV('name,note\n"Doe, John","said ""hi"""\n')) === '[["name","note"],["Doe, John","said \\"hi\\""]]',
  JSON.stringify(parseCSV('name,note\n"Doe, John","said ""hi"""\n')));
ck('newline inside quotes', parseCSV('a\n"x\ny"\n')[1][0] === 'x\ny');
ck('CRLF handled', JSON.stringify(parseCSV('a,b\r\n1,2\r\n')) === '[["a","b"],["1","2"]]');
ck('empty trailing cells kept', parseCSV('a,b\n1,\n')[1].length === 2);

// ---- parseTSV (the spreadsheet clipboard) ----
ck('TSV rows and cells', JSON.stringify(parseTSV('a\tb\n1\t2\n')) === '[["a","b"],["1","2"]]', JSON.stringify(parseTSV('a\tb\n1\t2\n')));
ck('TSV keeps commas plain', parseTSV('x,y\tz\n')[0][0] === 'x,y');
ck('TSV quoted newline cell', parseTSV('"two\nlines"\tb\n')[0][0] === 'two\nlines');

// ---- inferCsvTable ----
const t1 = inferCsvTable('people.csv', parseCSV('id,name,salary,joined\n1,Anna,4200.50,2025-01-03\n2,Ben,3900,2025-02-14\n'));
ck('unique int first column becomes the PK', t1.ddl.includes('PRIMARY KEY(`id`)') && !t1.ddl.includes('AUTO_INCREMENT'), t1.ddl);
ck('salary inferred DECIMAL', /`salary` DECIMAL\(\d+,2\)/.test(t1.ddl), t1.ddl);
ck('joined inferred DATE', t1.ddl.includes('`joined` DATE'), t1.ddl);
ck('insert quotes text, bare numbers', t1.inserts[0].includes("(1, 'Anna', 4200.50, '2025-01-03')"), t1.inserts[0]);

const t2 = inferCsvTable('cities', parseCSV('city,pop\nZurich,400000\nZurich,400000\n'));
ck('no unique key → synthetic auto-increment id', t2.ddl.includes('`id` INT UNSIGNED NOT NULL AUTO_INCREMENT'), t2.ddl);

const t3 = inferCsvTable('x', parseCSV('a,a,weird name!\n1,2,3\n'));
ck('headers deduped and sanitized', t3.columns[0] !== t3.columns[1] && t3.columns[2] === 'weird_name', t3.columns.join(','));

const big = 'n\n' + Array.from({ length: 450 }, (_, i) => String(i)).join('\n') + '\n';
ck('rows chunked at 200 per INSERT', inferCsvTable('big', parseCSV(big)).inserts.length === 3);

ck('empty cell → NULL', inferCsvTable('e', parseCSV('a,b\n1,\n2,x\n')).inserts[0].includes('(1, NULL)'));
ck('too-few-rows returns null', inferCsvTable('nope', parseCSV('a,b\n')) === null);

// ---- toCSV ----
const out = toCSV(['id', 'note'], [['1', 'plain'], ['2', 'has, comma'], ['3', 'has "q"'], ['4', null]]);
ck('export quotes only when needed',
  out.includes('2,"has, comma"') && out.includes('3,"has ""q"""') && out.includes('1,plain'), out);
ck('null exports as empty', out.split('\r\n')[4] === '4,', JSON.stringify(out.split('\r\n')[4]));
ck('round-trip: parse(toCSV) = original',
  JSON.stringify(parseCSV(out).slice(1)) === JSON.stringify([['1', 'plain'], ['2', 'has, comma'], ['3', 'has "q"'], ['4', '']]),
  JSON.stringify(parseCSV(out)));

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
