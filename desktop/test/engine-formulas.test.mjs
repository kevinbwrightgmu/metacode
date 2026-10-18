// The formula language and the functions: parsing with Excel's precedence,
// coercion and error rules, and each function against the values Excel gives
// (reliability functions against the website's tested module).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as E from '../src/shared/engine/index.js';

const require = createRequire(import.meta.url);
globalThis.ReliabilityStats = require('../../public/js/reliability-stats.js');

/** A workbook with values placed from a grid ({ A1: …, B2: … }) and one formula evaluated in Z100 */
function sheetWith(cells) {
  const wb = E.newWorkbook();
  const s = wb.activeSheet;
  const entries = Object.entries(cells || {}).map(([a1, v]) => { const p = E.parseA1(a1); return { r: p.r, c: p.c, input: String(v) }; });
  E.ops.setInputs(wb, s, entries);
  return { wb, s, calc: f => { E.ops.setInputs(wb, s, [{ r: 99, c: 25, input: f }]); return wb.valueAt(s, 99, 25); } };
}
const close = (a, b, eps = 1e-9) => assert.ok(typeof a === 'number' && Math.abs(a - b) < eps, 'expected ' + b + ', got ' + a);
const errCode = v => (v instanceof E.CellError ? v.code : 'not an error: ' + JSON.stringify(v));

test('addresses: columns, cells and ranges both ways, with Excel\'s limits', () => {
  for (const [c, n] of [[0, 'A'], [25, 'Z'], [26, 'AA'], [701, 'ZZ'], [702, 'AAA'], [16383, 'XFD']]) { assert.equal(E.colName(c), n); assert.equal(E.colIndex(n), c); }
  assert.equal(E.colIndex('XFE'), -1);
  assert.deepEqual(E.parseA1('$B$3'), { r: 2, c: 1 });
  assert.equal(E.parseA1('A0'), null);
  assert.equal(E.parseA1('A1048577'), null);
  assert.deepEqual(E.parseRange('C5:A1'), { r1: 0, c1: 0, r2: 4, c2: 2 });
  assert.deepEqual(E.parseRange('B:D'), { r1: 0, c1: 1, r2: E.MAX_ROWS - 1, c2: 3 });
  assert.equal(E.rangeA1(E.parseRange('B:D')), 'B:D');
  assert.equal(E.rangeA1(E.parseRange('3:7')), '3:7');
  assert.equal(E.sheetRef('Sheet1'), 'Sheet1');
  assert.equal(E.sheetRef("Bob's data"), "'Bob''s data'");
  assert.equal(E.sheetRef('A1'), "'A1'", 'a name that looks like a cell is quoted');
});

test('parsing: Excel\'s precedence, references, functions and syntax errors', () => {
  const { calc } = sheetWith();
  assert.equal(calc('=-2^2'), 4, 'negation binds tighter than ^ (as in Excel)');
  assert.equal(calc('=2^3^2'), 64, '^ is left-associative');
  assert.equal(calc('=1+2*3'), 7);
  assert.equal(calc('=(1+2)*3'), 9);
  assert.equal(calc('="a"&1+1'), 'a2', '& comes after +');
  assert.equal(calc('=1<2=TRUE'), true);
  assert.equal(calc('=50%'), 0.5);
  assert.equal(calc('=10%*10'), 1);
  assert.equal(calc('="He said ""hi"""'), 'He said "hi"');
  assert.equal(calc('=1E3+.5'), 1000.5);
  assert.equal(calc('=  1 +   2 '), 3, 'spaces are fine');
  assert.equal(calc('=LOG10(1000)'), 3, 'LOG10 is a function, not cell LOG10');
  assert.equal(calc('=SUM({1,2;3,4})'), 10, 'array constants');
  assert.equal(calc('=STDEV.S(1,2,3,4)'), Math.sqrt(5 / 3));
  assert.equal(errCode(calc('=1+')), '#NAME?', 'a broken formula shows an error, not a crash');
  assert.equal(errCode(calc('=SUM(1,2')), '#NAME?');
  assert.equal(errCode(calc('=NOSUCHFN(1)')), '#NAME?');
  assert.equal(errCode(calc('=foo')), '#NAME?');
  assert.equal(errCode(calc('=#N/A')), '#N/A');
  const tree = E.parse("='My sheet'!$A$1:B2+Sheet2!C:C");
  assert.equal(tree.type, 'binary');
  assert.deepEqual(E.refsOf(tree).map(r => [r.sheet, r.kind]), [['My sheet', 'range'], ['Sheet2', 'cols']]);
  assert.throws(() => E.parse('="unclosed'), E.FormulaSyntaxError);
});

test('coercion and errors: text numbers count in arithmetic, blanks are 0, errors propagate', () => {
  const { calc } = sheetWith({ A1: '5', A2: "'7", A3: 'abc', A4: 'TRUE' });
  assert.equal(calc('=A1+A2'), 12, 'text that looks like a number');
  assert.equal(calc('=A1+A9'), 5, 'an empty cell is 0');
  assert.equal(calc('=A9'), 0, 'a formula pointing at an empty cell shows 0');
  assert.equal(calc('=A9&"x"'), 'x');
  assert.equal(errCode(calc('=A3+1')), '#VALUE!');
  assert.equal(calc('=A4+1'), 2);
  assert.equal(errCode(calc('=1/0')), '#DIV/0!');
  assert.equal(errCode(calc('=SUM(A1,1/0)')), '#DIV/0!', 'errors propagate through functions');
  assert.equal(calc('=SUM(A1:A4)'), 5, 'ranges skip text and booleans in SUM');
  assert.equal(calc('="10"*2'), 20);
  assert.equal(errCode(calc('=A1:A3')), '#VALUE!', 'a range as a single value outside its rows (Excel\'s implicit intersection)');
});

test('math', () => {
  const { calc } = sheetWith({ A1: 1, A2: 2, A3: 3, A4: 4, B1: -2.5, B2: 2.675 });
  assert.equal(calc('=SUM(A1:A4)'), 10);
  assert.equal(calc('=PRODUCT(A1:A4)'), 24);
  assert.equal(calc('=ROUND(B2,2)'), 2.68, 'half away from zero, without float noise');
  assert.equal(calc('=ROUND(B1,0)'), -3);
  assert.equal(calc('=ROUND(1234.5678,-2)'), 1200);
  assert.equal(calc('=ROUNDUP(3.2,0)'), 4);
  assert.equal(calc('=ROUNDDOWN(-3.7,0)'), -3);
  assert.equal(calc('=INT(-3.2)'), -4);
  assert.equal(calc('=TRUNC(-3.7)'), -3);
  assert.equal(calc('=MOD(-3,2)'), 1, 'MOD takes the sign of the divisor');
  assert.equal(calc('=MOD(3,-2)'), -1);
  assert.equal(errCode(calc('=MOD(1,0)')), '#DIV/0!');
  assert.equal(calc('=POWER(2,10)'), 1024);
  assert.equal(errCode(calc('=SQRT(-1)')), '#NUM!');
  close(calc('=LN(EXP(2))'), 2);
  assert.equal(calc('=LOG(8,2)'), 3);
  assert.equal(calc('=ABS(B1)'), 2.5);
  assert.equal(calc('=CEILING(2.1,0.5)'), 2.5);
  assert.equal(calc('=FLOOR(2.9,0.5)'), 2.5);
  assert.equal(calc('=MROUND(10,3)'), 9);
  assert.equal(calc('=FACT(5)'), 120);
  assert.equal(calc('=COMBIN(5,2)'), 10);
  assert.equal(calc('=SUMSQ(A1:A3)'), 14);
  assert.equal(calc('=SUMPRODUCT(A1:A2,A3:A4)'), 1 * 3 + 2 * 4);
  assert.equal(errCode(calc('=SUMPRODUCT(A1:A2,A1:A3)')), '#VALUE!');
  assert.equal(calc('=EVEN(3)'), 4);
  assert.equal(calc('=ODD(4)'), 5);
  assert.equal(calc('=SIGN(-7)'), -1);
  const r = calc('=RAND()'); assert.ok(r >= 0 && r < 1);
  const rb = calc('=RANDBETWEEN(1,6)'); assert.ok(Number.isInteger(rb) && rb >= 1 && rb <= 6);
});

test('statistics', () => {
  const { calc } = sheetWith({ A1: 2, A2: 4, A3: 4, A4: 4, A5: 5, A6: 5, A7: 7, A8: 9, B1: 'x', B2: '', C1: 1, C2: 2, C3: 3, C4: 4, C5: 5, D1: 2, D2: 4, D3: 6, D4: 8, D5: 10 });
  assert.equal(calc('=AVERAGE(A1:A8)'), 5);
  assert.equal(calc('=COUNT(A1:B8)'), 8);
  assert.equal(calc('=COUNTA(A1:B8)'), 9, 'B1 is text');
  assert.equal(calc('=COUNTBLANK(B1:B3)'), 2);
  assert.equal(calc('=MAX(A1:A8)'), 9);
  assert.equal(calc('=MIN(A1:A8)'), 2);
  assert.equal(calc('=MIN(B1:B2)'), 0, 'no numbers → 0');
  assert.equal(errCode(calc('=AVERAGE(B1:B2)')), '#DIV/0!');
  assert.equal(calc('=MEDIAN(A1:A8)'), 4.5);
  assert.equal(calc('=MODE(A1:A8)'), 4);
  assert.equal(calc('=STDEV.P(A1:A8)'), 2, 'the textbook population example');
  close(calc('=STDEV.S(A1:A8)'), Math.sqrt(32 / 7));
  assert.equal(calc('=VAR.P(A1:A8)'), 4);
  assert.equal(calc('=LARGE(A1:A8,2)'), 7);
  assert.equal(calc('=SMALL(A1:A8,2)'), 4);
  assert.equal(calc('=RANK(7,A1:A8)'), 2);
  assert.equal(calc('=RANK(4,A1:A8,1)'), 2);
  assert.equal(calc('=RANK.AVG(4,A1:A8,1)'), 3);
  assert.equal(calc('=PERCENTILE(A1:A8,0.5)'), 4.5);
  assert.equal(calc('=QUARTILE(C1:C5,1)'), 2);
  assert.equal(calc('=CORREL(C1:C5,D1:D5)'), 1);
  assert.equal(calc('=SLOPE(D1:D5,C1:C5)'), 2);
  assert.equal(calc('=INTERCEPT(D1:D5,C1:C5)'), 0);
  close(calc('=GEOMEAN(C1:C3)'), Math.cbrt(6));
  assert.equal(calc('=COVARIANCE.P(C1:C5,D1:D5)'), 4);
  assert.equal(calc('=COVARIANCE.S(C1:C5,D1:D5)'), 5);
});

test('conditional aggregates: COUNTIF and friends with Excel\'s criteria', () => {
  const { calc } = sheetWith({ A1: 'apple', A2: 'banana', A3: 'apple pie', A4: 'Apple', A5: '', B1: 10, B2: 20, B3: 30, B4: 40, B5: 50, C1: 'east', C2: 'west', C3: 'east', C4: 'west', C5: 'east' });
  assert.equal(calc('=COUNTIF(A1:A5,"apple")'), 2, 'case-insensitive');
  assert.equal(calc('=COUNTIF(A1:A5,"apple*")'), 3, 'wildcards');
  assert.equal(calc('=COUNTIF(A1:A5,"?anana")'), 1);
  assert.equal(calc('=COUNTIF(B1:B5,">25")'), 3);
  assert.equal(calc('=COUNTIF(B1:B5,"<>20")'), 4);
  assert.equal(calc('=COUNTIF(B1:B5,30)'), 1);
  assert.equal(calc('=COUNTIF(A1:A6,"")'), 2, 'blanks count for ""');
  assert.equal(calc('=COUNTIF(A1:A5,"<>")'), 4);
  assert.equal(calc('=SUMIF(C1:C5,"east",B1:B5)'), 90);
  assert.equal(calc('=SUMIF(B1:B5,">=30")'), 120);
  assert.equal(calc('=SUMIFS(B1:B5,C1:C5,"east",B1:B5,">15")'), 80);
  assert.equal(calc('=COUNTIFS(C1:C5,"west",B1:B5,">25")'), 1);
  assert.equal(calc('=AVERAGEIF(C1:C5,"west",B1:B5)'), 30);
  assert.equal(calc('=AVERAGEIFS(B1:B5,C1:C5,"east")'), 30);
  assert.equal(calc('=MAXIFS(B1:B5,C1:C5,"east")'), 50);
  assert.equal(calc('=MINIFS(B1:B5,C1:C5,"west")'), 20);
  assert.equal(errCode(calc('=SUMIFS(B1:B5,C1:C4,"east")')), '#VALUE!');
});

test('logic', () => {
  const { calc } = sheetWith({ A1: 5 });
  assert.equal(calc('=IF(A1>3,"big","small")'), 'big');
  assert.equal(calc('=IF(A1>9,"big")'), false);
  assert.equal(errCode(calc('=IF(A1>3,1/0,0)')), '#DIV/0!');
  assert.equal(calc('=IF(A1<3,1/0,"safe")'), 'safe', 'only the chosen branch is evaluated');
  assert.equal(calc('=IFS(A1<3,"low",A1<7,"mid",TRUE,"high")'), 'mid');
  assert.equal(errCode(calc('=IFS(A1>100,1)')), '#N/A');
  assert.equal(calc('=IFERROR(1/0,"oops")'), 'oops');
  assert.equal(calc('=IFNA(MATCH(99,A1:A1,0),"none")'), 'none');
  assert.equal(calc('=AND(TRUE,A1>1)'), true);
  assert.equal(calc('=OR(FALSE,A1>10)'), false);
  assert.equal(calc('=XOR(TRUE,TRUE,TRUE)'), true);
  assert.equal(calc('=NOT(A1=5)'), false);
  assert.equal(calc('=SWITCH(A1,1,"one",5,"five","other")'), 'five');
  assert.equal(calc('=SWITCH(A1,1,"one","other")'), 'other');
  assert.equal(calc('=TRUE()'), true);
});

test('text', () => {
  const { calc } = sheetWith({ A1: 'Hello World', A2: '  too   many  spaces ', A3: 'a', A4: '', A5: 'c' });
  assert.equal(calc('=LEFT(A1,5)'), 'Hello');
  assert.equal(calc('=RIGHT(A1,5)'), 'World');
  assert.equal(calc('=MID(A1,7,3)'), 'Wor');
  assert.equal(calc('=LEN(A1)'), 11);
  assert.equal(calc('=UPPER(A1)'), 'HELLO WORLD');
  assert.equal(calc('=LOWER(A1)'), 'hello world');
  assert.equal(calc('=PROPER("hello wORLD")'), 'Hello World');
  assert.equal(calc('=TRIM(A2)'), 'too many spaces');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c');
  assert.equal(calc('=REPLACE("abcdef",2,3,"X")'), 'aXef');
  assert.equal(calc('=FIND("o",A1)'), 5);
  assert.equal(errCode(calc('=FIND("O",A1)')), '#VALUE!', 'FIND is case-sensitive');
  assert.equal(calc('=SEARCH("w?r",A1)'), 7, 'SEARCH: any case, wildcards');
  assert.equal(calc('=CONCATENATE("a",1,TRUE)'), 'a1TRUE');
  assert.equal(calc('=CONCAT(A3:A5)'), 'ac');
  assert.equal(calc('=TEXTJOIN(", ",TRUE,A3:A5)'), 'a, c');
  assert.equal(calc('=TEXTJOIN(", ",FALSE,A3:A5)'), 'a, , c');
  assert.equal(calc('=TEXT(1234.5,"#,##0.00")'), '1,234.50');
  assert.equal(calc('=TEXT(DATE(2024,3,5),"yyyy-mm-dd")'), '2024-03-05');
  assert.equal(calc('=TEXT(0.256,"0.0%")'), '25.6%');
  assert.equal(calc('=VALUE("1,234.5")'), 1234.5);
  assert.equal(calc('=VALUE("12%")'), 0.12);
  assert.equal(calc('=REPT("ab",3)'), 'ababab');
  assert.equal(calc('=EXACT("a","A")'), false);
  assert.equal(calc('=CHAR(65)&CODE("a")'), 'A97');
  assert.equal(calc('=TEXTBEFORE("a@b.com","@")'), 'a');
  assert.equal(calc('=TEXTAFTER("a@b.com","@")'), 'b.com');
  assert.equal(calc('=T(A1)&N(5)'), 'Hello World5');
});

test('dates and times, in Excel\'s 1900 date system', () => {
  const { calc } = sheetWith({ A1: '2024-03-05', A2: '2024-12-31', A3: '14:30' });
  assert.equal(calc('=DATE(2024,3,5)'), 45356, 'the same serial number as Excel');
  assert.equal(calc('=DATE(1900,1,1)'), 1);
  assert.equal(calc('=DATE(1900,3,1)'), 61, 'after Excel\'s phantom 29 Feb 1900');
  assert.equal(calc('=DATE(2024,14,1)'), calc('=DATE(2025,2,1)'), 'months overflow into years');
  assert.equal(calc('=A1'), 45356, 'typed dates become serials');
  assert.equal(calc('=YEAR(A1)&"-"&MONTH(A1)&"-"&DAY(A1)'), '2024-3-5');
  assert.equal(calc('=WEEKDAY(A1)'), 3, 'Tuesday (Sunday = 1)');
  assert.equal(calc('=WEEKDAY(A1,2)'), 2, 'Monday = 1');
  assert.equal(calc('=HOUR(A3)*60+MINUTE(A3)'), 870);
  assert.equal(calc('=EDATE(DATE(2024,1,31),1)'), calc('=DATE(2024,2,29)'), 'end of month is kept');
  assert.equal(calc('=EOMONTH(A1,0)'), calc('=DATE(2024,3,31)'));
  assert.equal(calc('=DAYS(A2,A1)'), 301);
  assert.equal(calc('=DATEDIF(DATE(2020,5,15),DATE(2024,3,5),"Y")'), 3);
  assert.equal(calc('=DATEDIF(DATE(2020,5,15),DATE(2024,3,5),"M")'), 45);
  assert.equal(calc('=DATEDIF(DATE(2020,5,15),DATE(2024,3,5),"MD")'), 19);
  assert.equal(calc('=DATEVALUE("2024-03-05")'), 45356);
  assert.equal(calc('=TIME(12,0,0)'), 0.5);
  assert.equal(calc('=NETWORKDAYS(DATE(2024,3,4),DATE(2024,3,10))'), 5);
  assert.equal(calc('=WORKDAY(DATE(2024,3,8),1)'), calc('=DATE(2024,3,11)'));
  assert.equal(calc('=WEEKNUM(DATE(2024,1,7))'), 2);
  const today = calc('=TODAY()');
  const d = new Date();
  assert.equal(calc('=YEAR(TODAY())'), d.getFullYear());
  assert.ok(Number.isInteger(today));
});

test('lookups', () => {
  const { calc } = sheetWith({ A1: 'id', B1: 'name', C1: 'score', A2: 101, B2: 'Ann', C2: 88, A3: 102, B3: 'Bob', C3: 92, A4: 103, B4: 'Cy', C4: 75,
    E1: 0, F1: 'F', E2: 60, F2: 'D', E3: 70, F3: 'C', E4: 80, F4: 'B', E5: 90, F5: 'A' });
  assert.equal(calc('=VLOOKUP(102,A2:C4,2,FALSE)'), 'Bob');
  assert.equal(errCode(calc('=VLOOKUP(999,A2:C4,2,FALSE)')), '#N/A');
  assert.equal(calc('=VLOOKUP(85,E1:F5,2)'), 'B', 'approximate: the largest value ≤ the lookup');
  assert.equal(errCode(calc('=VLOOKUP(102,A2:C4,5,FALSE)')), '#REF!');
  assert.equal(calc('=VLOOKUP("bob",B2:C4,2,FALSE)'), 92, 'text is matched in any case');
  assert.equal(calc('=VLOOKUP("B*",B2:C4,2,FALSE)'), 92, 'with wildcards');
  assert.equal(calc('=HLOOKUP("score",A1:C4,3,FALSE)'), 92);
  assert.equal(calc('=INDEX(A2:C4,2,3)'), 92);
  assert.equal(calc('=INDEX(B2:B4,3)'), 'Cy');
  assert.equal(errCode(calc('=INDEX(A2:C4,9,1)')), '#REF!');
  assert.equal(calc('=MATCH(103,A2:A4,0)'), 3);
  assert.equal(calc('=MATCH(85,E1:E5,1)'), 4);
  assert.equal(calc('=INDEX(C2:C4,MATCH("Cy",B2:B4,0))'), 75, 'INDEX/MATCH');
  assert.equal(calc('=XLOOKUP("Bob",B2:B4,C2:C4)'), 92);
  assert.equal(calc('=XLOOKUP("Zed",B2:B4,C2:C4,"none")'), 'none');
  assert.equal(calc('=XLOOKUP(85,E1:E5,F1:F5,,-1)'), 'B', 'next smaller');
  assert.equal(calc('=XLOOKUP(85,E1:E5,F1:F5,,1)'), 'A', 'next larger');
  assert.equal(calc('=CHOOSE(2,"a","b","c")'), 'b');
  assert.equal(calc('=ROW(C3)+COLUMN(C3)'), 6);
  assert.equal(calc('=ROWS(A1:C4)*COLUMNS(A1:C4)'), 12);
  assert.equal(calc('=ROW()'), 100, 'the formula\'s own row');
});

test('information functions', () => {
  const { calc } = sheetWith({ A1: 1, A2: 'x', A3: 'TRUE' });
  assert.equal(calc('=ISBLANK(A9)'), true);
  assert.equal(calc('=ISNUMBER(A1)'), true);
  assert.equal(calc('=ISTEXT(A2)'), true);
  assert.equal(calc('=ISLOGICAL(A3)'), true);
  assert.equal(calc('=ISERROR(1/0)'), true);
  assert.equal(calc('=ISERR(NA())'), false);
  assert.equal(calc('=ISNA(NA())'), true);
  assert.equal(calc('=ISEVEN(4)&ISODD(3)'), 'TRUETRUE');
  assert.equal(calc('=ERROR.TYPE(1/0)'), 2);
  assert.equal(calc('=TYPE("x")'), 2);
});

test('MetaCode\'s reliability functions agree with the website\'s Reliability page (published examples)', () => {
  // Cohen's κ, 50-unit yes/no example: κ = 0.40, agreement 0.70
  const a = Array(20).fill('y').concat(Array(5).fill('y'), Array(10).fill('n'), Array(15).fill('n'));
  const b = Array(20).fill('y').concat(Array(5).fill('n'), Array(10).fill('y'), Array(15).fill('n'));
  const cells = {};
  a.forEach((v, i) => { cells['A' + (i + 1)] = v; cells['B' + (i + 1)] = b[i]; });
  // 5-point ordinal example (scikit-learn): κ 0.368421, linear 0.663551, quadratic 0.856574
  const A = [1, 2, 3, 4, 5, 3, 2, 4, 5, 1, 3, 2], B = [1, 3, 3, 5, 4, 3, 1, 4, 5, 2, 2, 2];
  A.forEach((v, i) => { cells['D' + (i + 1)] = v; cells['E' + (i + 1)] = B[i]; });
  // Krippendorff's 4-coder example with missing values: nominal .743, interval .849
  const N = '';
  const coders = [[1, 2, 3, 3, 2, 1, 4, 1, 2, N, N, N], [1, 2, 3, 3, 2, 2, 4, 1, 2, 5, N, 3], [N, 3, 3, 3, 2, 3, 4, 2, 2, 5, 1, N], [1, 2, 3, 3, 2, 4, 4, 1, 2, 5, 1, N]];
  coders.forEach((col, j) => col.forEach((v, u) => { if (v !== '') cells[E.colName(6 + j) + (u + 1)] = v; }));
  const { calc } = sheetWith(cells);
  close(calc('=COHENKAPPA(A1:A50,B1:B50)'), 0.4);
  close(calc('=PERCENTAGREEMENT(A1:A50,B1:B50)'), 0.7);
  close(calc('=COHENKAPPA(D1:D12,E1:E12)'), 0.368421, 1e-5);
  close(calc('=WEIGHTEDKAPPA(D1:D12,E1:E12)'), 0.663551, 1e-5);
  close(calc('=WEIGHTEDKAPPA(D1:D12,E1:E12,"quadratic")'), 0.856574, 1e-5);
  close(calc('=KRIPPENDORFF(G1:J12)'), 0.743421, 1e-5);
  close(calc('=KRIPPENDORFF(G1:J12,"ordinal")'), 0.815388, 1e-5);
  close(calc('=KRIPPENDORFF(G1:J12,"interval")'), 0.849107, 1e-5);
  const undefinedK = calc('=COHENKAPPA(A1:A3,A1:A3)');
  assert.equal(errCode(undefinedK), '#N/A');
  assert.match(undefinedK.detail, /single category/, 'says why it can\'t be computed');
  assert.equal(errCode(calc('=COHENKAPPA(A1:A3,B1:B4)')), '#VALUE!');
});

test('number formats in the grid and TEXT()', () => {
  const f = (v, code) => E.formatValue(v, code).text;
  assert.equal(f(1234.567, '#,##0.00'), '1,234.57');
  assert.equal(f(-1234.5, '$#,##0.00;($#,##0.00)'), '($1,234.50)');
  assert.equal(E.formatValue(-5, '0;[Red]-0').color, '#FF0000');
  assert.equal(f(0.1234, '0.0%'), '12.3%');
  assert.equal(f(123456, '0.00E+00'), '1.23E+05');
  assert.equal(f(1234567, '0.0,,"M"'), '1.2M');
  assert.equal(f(3.5, '# ?/?'), '3 1/2');
  assert.equal(f(45356.6, 'dddd d mmm yyyy h:mm AM/PM'), 'Tuesday 5 Mar 2024 2:24 PM');
  assert.equal(f(1.5, '[h]:mm'), '36:00');
  assert.equal(f('abc', '"Item: "@'), 'Item: abc');
  assert.equal(f(1 / 3, 'General'), '0.333333333');
  assert.equal(f(123456789012, 'General'), '1.23457E+11');
  assert.equal(f(true, '0.00'), 'TRUE');
  assert.equal(E.isDateFormat('d-mmm-yy'), true);
  assert.equal(E.isDateFormat('#,##0'), false);
  assert.equal(E.changeDecimals('0.00', 1), '0.000');
  assert.equal(E.changeDecimals('#,##0.00', -2), '#,##0');
});

test('typed input: numbers, percents, money, dates, times, booleans and text', () => {
  const p = s => E.parseInput(s);
  assert.deepEqual(p('42'), { kind: 'value', v: 42 });
  assert.deepEqual(p('-3.5'), { kind: 'value', v: -3.5 });
  assert.deepEqual(p('12%'), { kind: 'value', v: 0.12, numFmt: '0%' });
  assert.deepEqual(p('12.5%'), { kind: 'value', v: 0.125, numFmt: '0.0%' });
  assert.deepEqual(p('$1,234.50'), { kind: 'value', v: 1234.5, numFmt: '$#,##0.00' });
  assert.deepEqual(p('1,234'), { kind: 'value', v: 1234, numFmt: '#,##0' });
  assert.deepEqual(p('(500)'), { kind: 'value', v: -500 });
  assert.deepEqual(p('2024-03-05'), { kind: 'value', v: 45356, numFmt: 'yyyy-mm-dd' });
  assert.deepEqual(p('3/5/2024'), { kind: 'value', v: 45356, numFmt: 'yyyy-mm-dd' });
  assert.equal(p('14:30').v, 14.5 / 24);
  assert.deepEqual(p('true'), { kind: 'value', v: true });
  assert.deepEqual(p("'00123"), { kind: 'value', v: '00123' }, 'a leading apostrophe keeps text');
  assert.deepEqual(p('00123'), { kind: 'value', v: 123 });
  assert.deepEqual(p('hello'), { kind: 'value', v: 'hello' });
  assert.deepEqual(p('1.2.3'), { kind: 'value', v: '1.2.3' });
  assert.deepEqual(p('=A1'), { kind: 'formula', f: '=A1' });
  assert.deepEqual(p('='), { kind: 'value', v: '=' });
  assert.deepEqual(p(''), { kind: 'blank' });
});
