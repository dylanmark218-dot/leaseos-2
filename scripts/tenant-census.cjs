/**
 * The tenant ownership census behind docs/TENANT_OWNERSHIP_AUDIT.md.
 *
 * Parses drizzle/schema.ts by brace-matching rather than by regex: a regex over
 * `mysqlTable("x", {...})` silently missed 25 of the 412 tables, because 16 close
 * with an index block (`}, (t) => ({...}))`) and the rest vary. An undercount here
 * reads as "fewer tables carry an owner than really do", which is the wrong
 * direction to be wrong in.
 *
 * Usage: node scripts/tenant-census.cjs
 */
const fs = require('fs');
const s = fs.readFileSync('drizzle/schema.ts', 'utf8');
const cols = ['tenantId','orgRef','bookOrgRef','organizationId','organisationId','companyId','contractorOrgRef','ownerOrgRef','subjectOrgRef'];
const found = {}; cols.forEach(c => found[c] = []);
const tables = [];
// Find every mysqlTable("name", then brace-match the column object.
const re = /mysqlTable\(\s*"(\w+)"\s*,\s*\{/g;
let m;
while ((m = re.exec(s))) {
  const name = m[1];
  let i = re.lastIndex - 1, depth = 0, end = -1;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = s.slice(m.index, end);
  tables.push(name);
  for (const c of cols) {
    const line = body.split('\n').find(l => new RegExp('^\\s*' + c + ':').test(l));
    if (line) found[c].push({ table: name, notNull: line.includes('.notNull()') });
  }
}
console.log('tables parsed:', tables.length);
console.log('unique names  :', new Set(tables).size);
for (const c of cols) {
  const f = found[c];
  if (!f.length) { console.log(`\n${c}: NONE`); continue; }
  console.log(`\n${c}: ${f.length} (notNull ${f.filter(x=>x.notNull).length} / nullable ${f.filter(x=>!x.notNull).length})`);
  console.log('  ' + f.map(x => x.table + (x.notNull ? '*' : '')).join(', '));
}
const owned = new Set(); for (const c of cols) found[c].forEach(x => owned.add(x.table));
console.log(`\nDIRECT ownership column: ${owned.size} / ${tables.length}`);
console.log(`NO direct ownership column: ${tables.length - owned.size}`);
fs.writeFileSync('/tmp/leaseos-tenant-census.json', JSON.stringify({tables, found}, null, 1));
