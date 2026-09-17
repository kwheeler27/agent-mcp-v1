/// <reference lib="dom" />
/** Render Mermaid relationships with five-column entity tables. No schema/database access.
 * Uses an existing Mermaid CLI installation; see docs/diagrams/README.md.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { annotateErd } from './erd-fields.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const cliRoot = process.env.MERMAID_CLI_ROOT || dirname(dirname(require.resolve('@mermaid-js/mermaid-cli')));
const cliRequire = createRequire(resolve(cliRoot, 'package.json'));
const puppeteer = (await import(pathToFileURL(cliRequire.resolve('puppeteer')).href)).default;
const { renderMermaid } = await import(pathToFileURL(resolve(cliRoot, 'src/index.js')).href);
const files = process.argv.slice(2);
if (!files.length) throw new Error('Pass one or more ERD .mmd paths.');
const browser = await puppeteer.launch({ headless: true });
try {
  for (const file of files) {
    const path = resolve(root, file);
    const source = readFileSync(path, 'utf8');
    if (annotateErd(source) !== source) throw new Error(`Stale descriptions in ${file}; regenerate first.`);
    const tables: { id: string; title: string; rows: string[][] }[] = [];
    let table: (typeof tables)[number] | undefined;
    const input = source.split('\n').flatMap(line => {
      const start = line.match(/^\s*(\w+)(?:\["([^"]+)"\])?\s*\{\s*$/);
      if (start) {
        table = { id: start[1]!, title: start[2] || start[1]!, rows: [['Field', 'Description', 'Type', 'PK/FK', 'Required']] };
        tables.push(table);
        // This temporary row reserves header height; it is never written to the source.
        return [line, '    Type Field PK, FK "Description | Required: Unspecified MMMMMMMMMMMM"'];
      }
      if (line.trim() === '}') { table = undefined; return [line]; }
      if (!table || !line.trim() || line.trim().startsWith('%%')) return [line];
      const f = line.match(/^\s*(\S+)\s+(\w+)(?:\s+((?:PK|FK|UK)(?:,\s*(?:PK|FK|UK))*))?\s+"(.*) \| Required: (Yes|No|Conditional|Unspecified)"\s*$/);
      if (!f) throw new Error(`Unsupported annotated field: ${line}`);
      table.rows.push([f[2]!, f[4]!, f[1]!, f[3] || (/keys and nullability unspecified/.test(f[4]!) ? 'Unspecified' : '—'), f[5]!]);
      // Extra comment width leaves room for the fifth column and its header.
      return [line.replace(/"\s*$/, ' MMMMMMMMMMMM"')];
    }).join('\n');
    const { data } = await renderMermaid(browser, input, 'svg', {
      viewport: { width: 2400, height: 1800, deviceScaleFactor: 1 },
      mermaidConfig: { maxEdges: 2000, maxTextSize: 500000, deterministicIds: true, deterministicIDSeed: basename(path), theme: 'neutral', fontFamily: 'Arial', er: { minEntityWidth: 120, fontSize: 16 } },
    });
    const page = await browser.newPage();
    try {
      await page.setContent(Buffer.from(data).toString('utf8'));
      const report = await page.evaluate((tables: { id: string; title: string; rows: string[][] }[]) => {
        const svg = document.querySelector('svg')!;
        const ns = 'http://www.w3.org/2000/svg';
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        context.font = '14px Arial';
        const measure = (s: string) => context.measureText(s).width;
        let fields = 0;
        for (const table of tables) {
          const node = Array.from(svg.querySelectorAll<SVGGElement>('g.node')).find(n => n.id.includes(`entity-${table.id}-`));
          if (!node) throw new Error(`Rendered entity missing: ${table.id}`);
          const box = node.querySelector<SVGGraphicsElement>('.outer-path')?.getBBox() ?? node.getBBox();
          const widths = table.rows[0]!.map((_, i) => Math.ceil(Math.max(...table.rows.map(row => measure(row[i]!))) + 24));
          const needed = widths.reduce((a, b) => a + b, 0);
          if (needed > box.width + 1) throw new Error(`Table too narrow: ${table.id}: ${needed} > ${box.width}`);
          widths[1] = widths[1]! + box.width - needed;
          const rowHeight = box.height / (table.rows.length + 1);
          if (rowHeight < 24) throw new Error(`Rows too short: ${table.id}`);
          node.replaceChildren();
          const rect = (x: number, y: number, w: number, h: number, fill: string) => {
            const e = document.createElementNS(ns, 'rect');
            for (const [k, v] of Object.entries({ x, y, width: w, height: h, fill, stroke: '#adb6c0', 'stroke-width': 0.7 })) e.setAttribute(k, String(v));
            e.style.fill = fill; e.style.stroke = '#adb6c0'; node.append(e);
          };
          const text = (x: number, y: number, content: string, bold = false) => {
            const e = document.createElementNS(ns, 'text');
            for (const [k, v] of Object.entries({ x, y, fill: '#172332', 'font-family': 'Arial', 'font-size': 14, 'font-weight': bold ? 600 : 400, 'dominant-baseline': 'middle' })) e.setAttribute(k, String(v));
            e.style.fill = '#172332'; e.style.fontFamily = 'Arial'; e.style.fontSize = '14px'; e.style.fontWeight = bold ? '600' : '400'; e.textContent = content; node.append(e);
          };
          rect(box.x, box.y, box.width, rowHeight, '#dfe8ee');
          text(box.x + 12, box.y + rowHeight / 2, table.title, true);
          table.rows.forEach((row, index) => {
            const y = box.y + (index + 1) * rowHeight;
            let x = box.x;
            row.forEach((value, col) => {
              rect(x, y, widths[col]!, rowHeight, index === 0 ? '#edf2f6' : index % 2 ? '#ffffff' : '#f7f9fb');
              text(x + 12, y + rowHeight / 2, value, index === 0);
              x += widths[col]!;
            });
          });
          fields += table.rows.length - 1;
        }
        svg.setAttribute('data-erd-columns', 'Field,Description,Type,PK/FK,Required');
        svg.setAttribute('aria-label', 'Entity relationship diagram: field, description, type, key membership, required');
        return { svg: new XMLSerializer().serializeToString(svg), entities: tables.length, fields };
      }, tables);
      const sourceHash = createHash('sha256').update(source).digest('hex');
      writeFileSync(path.replace(/\.mmd$/, '.svg'), report.svg.replace('<svg ', `<svg data-erd-source-sha256="${sourceHash}" `));
      const png = path.replace(/\.mmd$/, '.png');
      if (existsSync(png) || process.env.ERD_PNG === '1') {
        const element = await page.$('svg');
        const dimensions = await element.evaluate((e: SVGSVGElement) => ({ width: Math.ceil(e.viewBox.baseVal.width), height: Math.ceil(e.viewBox.baseVal.height) }));
        // Cap bitmap dimensions for large overview diagrams; SVG remains fully scalable.
        const scale = Math.min(1, 12000 / Math.max(dimensions.width, dimensions.height));
        const size = { width: Math.ceil(dimensions.width * scale), height: Math.ceil(dimensions.height * scale) };
        await page.setViewport({ ...size, deviceScaleFactor: 1 });
        await element.evaluate((e: SVGSVGElement, size: { width: number; height: number }) => { e.style.maxWidth = 'none'; e.style.width = size.width + 'px'; e.style.height = size.height + 'px'; }, size);
        await element.screenshot({ path: png });
      }
      console.log(JSON.stringify({ file, entities: report.entities, fields: report.fields, columns: 5 }));
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
