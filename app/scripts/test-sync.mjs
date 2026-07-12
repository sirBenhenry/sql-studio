// Unit tests for the sync plumbing (splitSQL / findCurrentDb / helpers).
import { splitSQL, findCurrentDb, isDbAgnostic, journalEntry } from '../src/sync.js';

let fail = 0;
const ck = (name, cond, extra) => {
  if (cond) console.log('ok:', name);
  else { fail++; console.log('FAIL:', name, extra ?? ''); }
};
const eq = (name, got, want) => ck(name, JSON.stringify(got) === JSON.stringify(want),
  '\n  GOT:  ' + JSON.stringify(got) + '\n  WANT: ' + JSON.stringify(want));

// --- splitSQL ---
eq('two simple statements',
  splitSQL('CREATE DATABASE x; USE x;'),
  ['CREATE DATABASE x', 'USE x']);

eq('semicolon inside string is not a split',
  splitSQL("INSERT INTO t VALUES ('a;b');INSERT INTO t VALUES ('c')"),
  ["INSERT INTO t VALUES ('a;b')", "INSERT INTO t VALUES ('c')"]);

eq('escaped quote in string',
  splitSQL("INSERT INTO t VALUES ('it\\'s; fine');"),
  ["INSERT INTO t VALUES ('it\\'s; fine')"]);

eq('doubled-quote escape',
  splitSQL("INSERT INTO t VALUES ('it''s; ok');"),
  ["INSERT INTO t VALUES ('it''s; ok')"]);

eq('line comments removed',
  splitSQL('-- header comment\nSELECT 1; -- trailing\nSELECT 2;'),
  ['SELECT 1', 'SELECT 2']);

eq('block comment removed',
  splitSQL('SELECT /* not ; a split */ 1;'),
  ['SELECT   1']);

eq('backtick identifiers survive',
  splitSQL('CREATE TABLE `weird;name` (id INT);'),
  ['CREATE TABLE `weird;name` (id INT)']);

eq('multiline create table',
  splitSQL('CREATE TABLE a (\n id INT,\n name VARCHAR(10)\n);\nINSERT INTO a VALUES (1, "x");'),
  ['CREATE TABLE a (\n id INT,\n name VARCHAR(10)\n)', 'INSERT INTO a VALUES (1, "x")']);

eq('no trailing semicolon still yields statement',
  splitSQL('SELECT 1'),
  ['SELECT 1']);

eq('comment-only script is empty',
  splitSQL('-- nothing here\n# nor here\n/* or here */'),
  []);

// --- findCurrentDb ---
ck('current db from CREATE DATABASE', findCurrentDb('CREATE DATABASE library; USE library;') === 'library');
ck('later USE wins', findCurrentDb('CREATE DATABASE a; USE a; USE b;') === 'b');
ck('none → null', findCurrentDb('SELECT 1;') === null);
ck('IF NOT EXISTS variant', findCurrentDb('CREATE DATABASE IF NOT EXISTS `shop`;') === 'shop');

// --- isDbAgnostic ---
ck('CREATE DATABASE is agnostic', isDbAgnostic('CREATE DATABASE x'));
ck('USE is agnostic', isDbAgnostic('use x'));
ck('SELECT is not', !isDbAgnostic('SELECT * FROM t'));

// --- journalEntry ---
const je = journalEntry('builder: alter', ['ALTER TABLE a ADD b INT']);
ck('journal has @applied stamp', /^\n-- @applied \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(builder: alter\)\nALTER TABLE a ADD b INT;\n$/.test(je), JSON.stringify(je));

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
process.exit(fail ? 1 : 0);
