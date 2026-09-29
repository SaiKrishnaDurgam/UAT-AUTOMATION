import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

const rawData = JSON.parse(
  fs.readFileSync('./figma/exports/ppv-checkout-full.json', 'utf-8')
);

// ─────────────────────────────────────────
// CLEAN REPORT STRUCTURE
// ─────────────────────────────────────────
interface UIElement {
  component:     string;
  role:          string;
  text?:         string;
  fontSize?:     number;
  fontWeight?:   number;
  color?:        string;
  background?:   string;
  width?:        number;
  height?:       number;
  padding?:      string;
  borderRadius?: number;
  border?:       string;
}

const report: Record<string, UIElement[]> = {
  'Page Header':         [],
  'Page Title':          [],
  'Body Text':           [],
  'Monthly Plan Card':   [],
  'Annual Plan Card':    [],
  'Plan Pricing':        [],
  'Plan Labels':         [],
  'Bullet Points':       [],
  'Timeline':            [],
  'CTA Button':          [],
};

// ─────────────────────────────────────────
// SKIP SYSTEM ELEMENTS
// ─────────────────────────────────────────
const SKIP_ELEMENTS = [
  'status-bar', 'safari', 'battery', 'wifi', 'cellular',
  'time and status', 'search bar', 'keyboard', 'above keyboard',
  'reload', 'site settings', 'domain', 'path', 'vector',
  'border', 'cap', 'capacity', 'wifi-path', 'cellular_connection',
  'mask group', 'rectangle 2', 'oval', 'shape', 'line',
  'icon', 'ic-placeholder', 'ic-checkmark', 'discount',
  'sports-boxing', 'reminder', 'divider', 'frame 214'
];

function shouldSkip(name: string): boolean {
  const lower = name.toLowerCase();
  return SKIP_ELEMENTS.some(s => lower.includes(s)) ||
         lower.startsWith('frame 2') ||  // Skip unnamed frames
         lower.startsWith('path') ||
         lower.startsWith('vector');
}

// ─────────────────────────────────────────
// BUILD ELEMENT FROM NODE
// ─────────────────────────────────────────
function buildElement(node: any): UIElement {
  const el: UIElement = {
    component: node.name,
    role:      node.type,
  };

  if (node.typography?.content)   el.text        = node.typography.content;
  if (node.typography?.fontSize)  el.fontSize    = node.typography.fontSize;
  if (node.typography?.fontWeight)el.fontWeight  = node.typography.fontWeight;
  if (node.typography?.textColor) el.color       = node.typography.textColor;
  if (node.fills?.[0]?.color)     el.background  = node.fills[0].color;
  if (node.dimensions?.width)     el.width       = node.dimensions.width;
  if (node.dimensions?.height)    el.height      = node.dimensions.height;
  if (node.borderRadius?.all)     el.borderRadius= node.borderRadius.all;
  if (node.border)                el.border      =
    `${node.border.width}px solid ${node.border.color}`;

  if (node.spacing) {
    const { paddingTop: pt, paddingBottom: pb,
            paddingLeft: pl, paddingRight: pr } = node.spacing;
    if (pt || pl) el.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
  }

  return el;
}

// ─────────────────────────────────────────
// PRECISE CATEGORIZER
// ─────────────────────────────────────────
function categorize(node: any, parentPath: string = '') {
  const name     = node.name || '';
  const nameLower= name.toLowerCase();
  const path     = `${parentPath}/${name}`.toLowerCase();

  if (shouldSkip(name)) return;

  const el = buildElement(node);

  // ── PAGE HEADER (navigation bar) ──
  if (nameLower === '.header-component-mobile' ||
      nameLower === 'slot/header') {
    report['Page Header'].push(el);
  }

  // ── BACK BUTTON ──
  else if (nameLower === 'across-platform/icon-button' ||
           nameLower === 'chevron-left-large') {
    report['Page Header'].push({
      ...el,
      component: 'Back Button',
      role: 'NAVIGATION'
    });
  }

  // ── DAZN LOGO ──
  else if (nameLower === 'daznrubik') {
    report['Page Header'].push({
      ...el,
      component: 'DAZN Logo',
      role: 'IMAGE'
    });
  }

  // ── PAGE TITLE ──
  else if (nameLower === 'title' && node.typography?.content) {
    report['Page Title'].push({
      ...el,
      component: 'Page Title',
    });
  }

  // ── BODY COPY ──
  else if (nameLower === 'body copy' && node.typography?.content) {
    report['Body Text'].push(el);
  }

  // ── MONTHLY PLAN ──
  else if (path.includes('frame 2147226884') ||
           (nameLower.includes('heading') &&
            node.typography?.content === 'Pay monthly')) {
    report['Monthly Plan Card'].push(el);
  }

  // ── ANNUAL PLAN ──
  else if (path.includes('frame 2147226883') ||
           (nameLower.includes('heading') &&
            node.typography?.content === 'Annual - Pay monthly')) {
    report['Annual Plan Card'].push(el);
  }

  // ── PRICING TEXT ──
  else if (nameLower === 'header' && node.typography?.content) {
    const text = node.typography.content;

    if (text.includes('£') || text.includes('$') || text.includes('€')) {
      report['Plan Pricing'].push({
        ...el,
        component: `Price: ${text}`
      });
    }
    else if (text.includes('/month') || text.includes('billed') ||
             text.includes('contract') || text.includes('cancel')) {
      report['Plan Pricing'].push({
        ...el,
        component: `Billing Info`
      });
    }
    else if (text.includes('Today') || text.includes('7 days') ||
             text.includes('charged') || text.includes('trial')) {
      report['Timeline'].push({
        ...el,
        component: `Timeline: ${text.substring(0, 30)}`
      });
    }
  }

  // ── PLAN LABELS (badges) ──
  else if (nameLower.includes('mobile/label') ||
           nameLower.includes('save £') ||
           nameLower.includes('save €')) {
    if (node.typography?.content) {
      report['Plan Labels'].push({
        ...el,
        component: `Badge: ${node.typography.content}`
      });
    }
  }

  // ── BULLET POINTS ──
  else if (nameLower === 'main' && node.typography?.content &&
           node.typography.content.includes('explanatory')) {
    report['Bullet Points'].push({
      ...el,
      component: 'Bullet Text'
    });
  }

  // ── TIMELINE ──
  else if (nameLower === 'today' ||
           nameLower.includes('7 days') ||
           (node.typography?.content?.includes('charged')) ||
           (node.typography?.content?.includes('free trial of DAZN'))) {
    if (node.typography?.content) {
      report['Timeline'].push({
        ...el,
        component: `Timeline: ${node.typography.content.substring(0, 40)}`
      });
    }
  }

  // ── CTA BUTTON ──
  else if (nameLower === 'mobile/button' ||
           nameLower === 'button-validation-sucess') {
    report['CTA Button'].push({
      ...el,
      component: 'Continue Button'
    });
  }
  else if (nameLower === 'text' &&
           node.typography?.content === 'Continue') {
    report['CTA Button'].push({
      ...el,
      component: 'Continue Button Text'
    });
  }

  // Recurse into children
  node.children?.forEach((child: any) =>
    categorize(child, path)
  );
}

// ─────────────────────────────────────────
// DEDUPLICATE
// ─────────────────────────────────────────
function deduplicate(elements: UIElement[]): UIElement[] {
  const seen = new Set<string>();
  return elements.filter(e => {
    const key = `${e.component}-${e.text}-${e.width}-${e.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─────────────────────────────────────────
// GENERATE PLAYWRIGHT TESTS
// ─────────────────────────────────────────
function generateTests(cleanReport: Record<string, UIElement[]>): string {
  let t = `import { test, expect } from '@playwright/test';\n\n`;
  t    += `/**\n * Auto-generated from Figma PPV Checkout\n`;
  t    += ` * Generated: ${new Date().toISOString()}\n */\n\n`;
  t    += `test.describe('PPV Checkout - Figma Validation', () => {\n\n`;
  t    += `  test.beforeEach(async ({ page }) => {\n`;
  t    += `    await page.goto('/ppv/checkout');\n`;
  t    += `    await page.waitForLoadState('networkidle');\n`;
  t    += `  });\n\n`;

  Object.entries(cleanReport).forEach(([section, elements]) => {
    if (!elements.length) return;

    t += `  // ${'─'.repeat(40)}\n`;
    t += `  test('${section} matches Figma design', async ({ page }) => {\n`;

    elements.forEach(e => {
      t += `\n    // ${e.component}\n`;

      if (e.text && e.text.length < 50) {
        t += `    const el_${sanitize(e.component)} = `
          +  `page.getByText('${e.text.replace(/'/g, "\\'")}');\n`;
        t += `    await expect(el_${sanitize(e.component)}).toBeVisible();\n`;

        if (e.color) {
          t += `    await expect(el_${sanitize(e.component)})\n`;
          t += `      .toHaveCSS('color', '${hexToRgb(e.color)}'); `
            +  `// Figma: ${e.color}\n`;
        }
        if (e.fontSize) {
          t += `    await expect(el_${sanitize(e.component)})\n`;
          t += `      .toHaveCSS('font-size', '${e.fontSize}px'); `
            +  `// Figma: ${e.fontSize}px\n`;
        }
        if (e.fontWeight) {
          t += `    await expect(el_${sanitize(e.component)})\n`;
          t += `      .toHaveCSS('font-weight', '${e.fontWeight}'); `
            +  `// Figma: ${e.fontWeight}\n`;
        }
      }

      if (e.background && !e.text) {
        t += `    // Background: ${e.background} | Size: ${e.width}x${e.height}\n`;
      }
    });

    t += `  });\n\n`;
  });

  t += `});\n`;
  return t;
}

// ─────────────────────────────────────────
// GENERATE CSV
// ─────────────────────────────────────────
function generateCSV(cleanReport: Record<string, UIElement[]>): string {
  const rows: any[] = [];

  Object.entries(cleanReport).forEach(([section, elements]) => {
    elements.forEach(e => {
      rows.push({
        Section:       section,
        Component:     e.component,
        Type:          e.role,
        'Text Content':e.text        ?? '',
        'Font Size':   e.fontSize    ?? '',
        'Font Weight': e.fontWeight  ?? '',
        'Text Color':  e.color       ?? '',
        'Background':  e.background  ?? '',
        'Width (px)':  e.width       ?? '',
        'Height (px)': e.height      ?? '',
        'Padding':     e.padding     ?? '',
        'Border Radius':e.borderRadius ?? '',
        'Border':      e.border      ?? '',
      });
    });
  });

  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [
    headers.join(','),
    ...rows.map(r =>
      headers.map(h =>
        `"${String(r[h] ?? '').replace(/"/g, '""')}"`
      ).join(',')
    )
  ].join('\n');
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

function sanitize(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .substring(0, 25);
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
function main() {
  console.log('\n📊 Generating Clean PPV Checkout Report...');
  console.log('━'.repeat(55));

  // Categorize all elements
  categorize(rawData);

  // Build clean report
  const cleanReport: Record<string, UIElement[]> = {};
  Object.entries(report).forEach(([section, elements]) => {
    const unique = deduplicate(elements);
    if (unique.length > 0) cleanReport[section] = unique;
  });

  // Save outputs
  fs.mkdirSync('./figma/exports',    { recursive: true });
  fs.mkdirSync('./tests/generated',  { recursive: true });

  fs.writeFileSync(
    './figma/exports/ppv-checkout-clean.json',
    JSON.stringify(cleanReport, null, 2)
  );
  fs.writeFileSync(
    './figma/exports/ppv-checkout-clean.csv',
    generateCSV(cleanReport)
  );
  fs.writeFileSync(
    './tests/generated/ppv-checkout-figma.spec.ts',
    generateTests(cleanReport)
  );

  // ── PRINT CLEAN REPORT ──
  console.log('\n📋 PPV Checkout - Design Specs:\n');

  Object.entries(cleanReport).forEach(([section, elements]) => {
    console.log(`\n┌─ ${section} (${elements.length} elements)`);
    elements.forEach(e => {
      const parts = [`│  • ${e.component}`];
      if (e.text)        parts.push(`"${e.text.substring(0, 40)}"`);
      if (e.fontSize)    parts.push(`${e.fontSize}px`);
      if (e.fontWeight)  parts.push(`fw:${e.fontWeight}`);
      if (e.color)       parts.push(`color:${e.color}`);
      if (e.background)  parts.push(`bg:${e.background}`);
      if (e.width)       parts.push(`${e.width}x${e.height}`);
      if (e.borderRadius)parts.push(`r:${e.borderRadius}px`);
      console.log(parts.join(' | '));
    });
  });

  console.log('\n\n✅ Done!');
  console.log('━'.repeat(55));
  console.log('📁 JSON  : ./figma/exports/ppv-checkout-clean.json');
  console.log('📊 CSV   : ./figma/exports/ppv-checkout-clean.csv');
  console.log('🧪 Tests : ./tests/generated/ppv-checkout-figma.spec.ts\n');
}

main();
