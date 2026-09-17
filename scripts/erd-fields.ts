/** Documentation-only annotations. Schema generators remain authoritative for structure. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
type Description = { description: string; required: string };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = 'docs/diagrams';
const descriptions = JSON.parse(readFileSync(resolve(root, directory, 'field-descriptions.json'), 'utf8')) as Record<string, Record<string, Description>>;
export function fieldDescription(entity: string, name: string): Description {
  const value = descriptions[entity]?.[name];
  if (!value || !value.description.trim() || /[\n"|]/.test(value.description)) throw new Error(`Missing or unsafe description: ${entity}.${name}`);
  if (!['Yes', 'No', 'Conditional', 'Unspecified'].includes(value.required)) throw new Error(`Invalid required indicator: ${entity}.${name}`);
  return value;
}
export function annotateErd(source: string): string {
  let entity: string | undefined;
  return source.split('\n').map(line => {
    const start = line.match(/^\s*(\w+)(?:\["[^"]+"\])?\s*\{\s*$/);
    if (start) { entity = start[1]; return line; }
    if (line.trim() === '}') { entity = undefined; return line; }
    if (!entity || !line.trim() || line.trim().startsWith('%%')) return line;
    const field = line.match(/^(\s*)(\S+)\s+(\w+)(?:\s+((?:PK|FK|UK)(?:,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?\s*$/);
    if (!field) throw new Error(`Unsupported ERD field: ${line}`);
    const value = fieldDescription(entity, field[3]);
    // Explicit source nullability wins, and metadata drift fails instead of silently changing it.
    const old = field[5] ?? '';
    if (/\bPK\b/.test(field[4] ?? '') && value.required !== 'Yes') throw new Error(`Primary key must be required: ${entity}.${field[3]}`);
    const required = old.startsWith('required iff') ? 'Conditional' : /\bnullable\b/.test(old) ? 'No' : (/^(?:required)(?:;|$)/.test(old) || /; required$/.test(old)) || /\bPK\b/.test(field[4] ?? '') ? 'Yes' : undefined;
    if (!old.includes(' | Required: ') && required && required !== value.required) throw new Error(`Requiredness drift: ${entity}.${field[3]}`);
    return `${field[1]}${field[2]} ${field[3]}${field[4] ? ' ' + field[4] : ''} "${value.description} | Required: ${value.required}"`;
  }).join('\n');
}

// Standalone refresh/check for hand-maintained Mermaid sources.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...files] = process.argv.slice(2);
  if (!['--write', '--check'].includes(mode) || !files.length) throw new Error('Use --write or --check followed by ERD paths.');
  for (const file of files) {
    const path = resolve(root, file);
    const source = readFileSync(path, 'utf8');
    const output = annotateErd(source);
    if (mode === '--write') writeFileSync(path, output);
    else if (output !== source) throw new Error(`Stale descriptions: ${file}`);
  }
}
