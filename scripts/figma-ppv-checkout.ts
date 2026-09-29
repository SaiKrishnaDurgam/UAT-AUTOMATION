import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

const FIGMA_TOKEN    = process.env.FIGMA_TOKEN!;
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY!;

// ─────────────────────────────────────────
// TARGET: Checkout section on Mobile page
// ─────────────────────────────────────────
const TARGET_PAGE    = '📱 Mobile';
const TARGET_SECTION = 'Checkout';

// ─────────────────────────────────────────
// FETCH FILE
// ─────────────────────────────────────────
async function fetchFile() {
  const res = await fetch(
    `https://api.figma.com/v1/files/${FIGMA_FILE_KEY}`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );
  if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
  return res.json() as any;
}

// ─────────────────────────────────────────
// FETCH SPECIFIC NODE DETAILS
// ─────────────────────────────────────────
async function fetchNodeDetails(nodeId: string) {
  const res = await fetch(
    `https://api.figma.com/v1/files/${FIGMA_FILE_KEY}/nodes?ids=${nodeId}`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );
  if (!res.ok) throw new Error(`API Error: ${res.statusText}`);
  return res.json() as any;
}

// ─────────────────────────────────────────
// HELPER: RGBA to HEX
// ─────────────────────────────────────────
function rgbaToHex(r: number, g: number, b: number, a: number = 1): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ─────────────────────────────────────────
// EXTRACT ELEMENT DETAILS
// ─────────────────────────────────────────
function extractElementDetails(node: any, depth: number = 0): any {
  const element: any = {
    id:       node.id,
    name:     node.name,
    type:     node.type,
    depth:    depth,
    visible:  node.visible ?? true,
  };

  // ── Dimensions & Position ──
  if (node.absoluteBoundingBox) {
    element.dimensions = {
      x:      Math.round(node.absoluteBoundingBox.x),
      y:      Math.round(node.absoluteBoundingBox.y),
      width:  Math.round(node.absoluteBoundingBox.width),
      height: Math.round(node.absoluteBoundingBox.height),
    };
  }

  // ── Layout/Flex ──
  if (node.layoutMode) {
    element.layout = {
      mode:          node.layoutMode,          // HORIZONTAL / VERTICAL
      primaryAlign:  node.primaryAxisAlignItems,
      crossAlign:    node.counterAxisAlignItems,
      wrap:          node.layoutWrap,
    };
  }

  // ── Spacing ──
  element.spacing = {
    paddingTop:    node.paddingTop    ?? 0,
    paddingBottom: node.paddingBottom ?? 0,
    paddingLeft:   node.paddingLeft   ?? 0,
    paddingRight:  node.paddingRight  ?? 0,
    gap:           node.itemSpacing   ?? 0,
  };

  // ── Border Radius ──
  if (node.cornerRadius !== undefined || node.rectangleCornerRadii) {
    element.borderRadius = {
      all:         node.cornerRadius ?? 0,
      topLeft:     node.rectangleCornerRadii?.[0] ?? node.cornerRadius ?? 0,
      topRight:    node.rectangleCornerRadii?.[1] ?? node.cornerRadius ?? 0,
      bottomRight: node.rectangleCornerRadii?.[2] ?? node.cornerRadius ?? 0,
      bottomLeft:  node.rectangleCornerRadii?.[3] ?? node.cornerRadius ?? 0,
    };
  }

  // ── Background/Fill Colors ──
  if (node.fills?.length > 0) {
    element.fills = node.fills
      .filter((f: any) => f.visible !== false)
      .map((f: any) => {
        if (f.type === 'SOLID' && f.color) {
          return {
            type:    'SOLID',
            color:   rgbaToHex(f.color.r, f.color.g, f.color.b),
            opacity: Math.round((f.opacity ?? 1) * 100) + '%',
          };
        }
        if (f.type === 'GRADIENT_LINEAR') {
          return {
            type:   'GRADIENT',
            stops:  f.gradientStops?.map((s: any) => ({
              color:    rgbaToHex(s.color.r, s.color.g, s.color.b),
              position: Math.round(s.position * 100) + '%',
            }))
          };
        }
        return { type: f.type };
      });
  }

  // ── Typography ──
  if (node.type === 'TEXT') {
    element.typography = {
      content:       node.characters ?? '',
      fontFamily:    node.style?.fontFamily,
      fontSize:      node.style?.fontSize,
      fontWeight:    node.style?.fontWeight,
      lineHeight:    node.style?.lineHeightPx
        ? `${Math.round(node.style.lineHeightPx)}px`
        : node.style?.lineHeightUnit,
      letterSpacing: node.style?.letterSpacing ?? 0,
      textAlign:     node.style?.textAlignHorizontal,
      textDecoration: node.style?.textDecoration,
      textColor:     node.fills?.[0]?.color
        ? rgbaToHex(
            node.fills[0].color.r,
            node.fills[0].color.g,
            node.fills[0].color.b
          )
        : null,
    };
  }

  // ── Borders/Strokes ──
  if (node.strokes?.length > 0 && node.strokes[0].color) {
    element.border = {
      color:  rgbaToHex(
        node.strokes[0].color.r,
        node.strokes[0].color.g,
        node.strokes[0].color.b
      ),
      width:  node.strokeWeight ?? 1,
      align:  node.strokeAlign,
      style:  node.strokeDashes ? 'DASHED' : 'SOLID',
    };
  }

  // ── Effects (Shadow/Blur) ──
  if (node.effects?.length > 0) {
    element.effects = node.effects
      .filter((e: any) => e.visible !== false)
      .map((e: any) => ({
        type:    e.type,
        radius:  e.radius,
        color:   e.color
          ? rgbaToHex(e.color.r, e.color.g, e.color.b)
          : null,
        offsetX: e.offset?.x ?? 0,
        offsetY: e.offset?.y ?? 0,
      }));
  }

  // ── Component Info ──
  if (node.type === 'INSTANCE') {
    element.component = {
      componentId:  node.componentId,
      isComponent:  true,
    };
  }

  // ── Image/Vector ──
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') {
    element.vector = { type: node.type };
  }

  // ── Opacity ──
  if (node.opacity !== undefined && node.opacity !== 1) {
    element.opacity = Math.round(node.opacity * 100) + '%';
  }

  // ── Recurse Children ──
  if (node.children?.length > 0) {
    element.children = node.children.map((child: any) =>
      extractElementDetails(child, depth + 1)
    );
  }

  return element;
}

// ─────────────────────────────────────────
// FLATTEN FOR CSV - ONE ROW PER PROPERTY
// ─────────────────────────────────────────
function flattenElement(
  element: any,
  rows: any[] = [],
  parentName: string = ''
): any[] {
  const path = parentName
    ? `${parentName} > ${element.name}`
    : element.name;

  // Base row
  const baseRow = {
    ElementPath:   path,
    ElementName:   element.name,
    Type:          element.type,
    Depth:         element.depth,
    Visible:       element.visible,
    Width:         element.dimensions?.width         ?? '',
    Height:        element.dimensions?.height        ?? '',
    X:             element.dimensions?.x             ?? '',
    Y:             element.dimensions?.y             ?? '',
    PaddingTop:    element.spacing?.paddingTop        ?? '',
    PaddingBottom: element.spacing?.paddingBottom     ?? '',
    PaddingLeft:   element.spacing?.paddingLeft       ?? '',
    PaddingRight:  element.spacing?.paddingRight      ?? '',
    Gap:           element.spacing?.gap               ?? '',
    BorderRadius:  element.borderRadius?.all          ?? '',
    FillColor:     element.fills?.[0]?.color          ?? '',
    FillOpacity:   element.fills?.[0]?.opacity        ?? '',
    BorderColor:   element.border?.color              ?? '',
    BorderWidth:   element.border?.width              ?? '',
    // Typography
    TextContent:   element.typography?.content        ?? '',
    FontFamily:    element.typography?.fontFamily     ?? '',
    FontSize:      element.typography?.fontSize       ?? '',
    FontWeight:    element.typography?.fontWeight     ?? '',
    LineHeight:    element.typography?.lineHeight     ?? '',
    LetterSpacing: element.typography?.letterSpacing  ?? '',
    TextAlign:     element.typography?.textAlign      ?? '',
    TextColor:     element.typography?.textColor      ?? '',
    // Layout
    LayoutMode:    element.layout?.mode               ?? '',
    // Effects
    HasShadow:     element.effects?.length > 0 ? 'Yes' : '',
  };

  rows.push(baseRow);

  // Recurse children
  element.children?.forEach((child: any) =>
    flattenElement(child, rows, path)
  );

  return rows;
}

// ─────────────────────────────────────────
// CONVERT TO CSV
// ─────────────────────────────────────────
function toCSV(rows: any[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const csvRows = rows.map(row =>
    headers.map(h =>
      `"${String(row[h] ?? '').replace(/"/g, '""')}"`
    ).join(',')
  );
  return [headers.join(','), ...csvRows].join('\n');
}

// ─────────────────────────────────────────
// PRINT TREE VIEW
// ─────────────────────────────────────────
function printTree(element: any, indent: string = '') {
  const iconMap: Record<string, string> = {
    'TEXT':      '🔤',
    'FRAME':     '🔲',
    'INSTANCE':  '🧩',
    'VECTOR':    '✏️',
    'RECTANGLE': '▬',
    'GROUP':     '📁',
    'IMAGE':     '🖼️',
  };
  const icon = iconMap[element.type] || '📦';

  const color    = element.fills?.[0]?.color    ? ` bg:${element.fills[0].color}` : '';
  const textInfo = element.typography?.content
    ? ` "${element.typography.content.substring(0, 30)}"`
    : '';
  const size     = element.dimensions
    ? ` [${element.dimensions.width}x${element.dimensions.height}]`
    : '';

  console.log(
    `${indent}${icon} ${element.name}${size}${color}${textInfo}`
  );

  element.children?.forEach((child: any) =>
    printTree(child, indent + '   ')
  );
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  try {
    console.log('\n🚀 Extracting PPV Checkout Page Details...');
    console.log('━'.repeat(55));

    // Step 1: Get file & find target page
    const fileData = await fetchFile();
    const pages    = fileData.document.children;

    const targetPage = pages.find((p: any) =>
      p.name === TARGET_PAGE
    );

    if (!targetPage) {
      throw new Error(`Page "${TARGET_PAGE}" not found!`);
    }

    // Step 2: Find Checkout section
    const checkoutFrame = targetPage.children.find((f: any) =>
      f.name === TARGET_SECTION
    );

    if (!checkoutFrame) {
      console.log('\n⚠️  Available sections:');
      targetPage.children.forEach((f: any) =>
        console.log(`   - ${f.name}`)
      );
      throw new Error(`Section "${TARGET_SECTION}" not found!`);
    }

    console.log(`✅ Found: "${TARGET_SECTION}" (ID: ${checkoutFrame.id})`);

    // Step 3: Fetch full node details
    console.log('⏳ Fetching detailed node data...');
    const nodeData   = await fetchNodeDetails(checkoutFrame.id);
    const nodeKey    = Object.keys(nodeData.nodes)[0];
    const rootNode   = nodeData.nodes[nodeKey].document;

    // Step 4: Extract all elements
    console.log('🔍 Extracting all elements...\n');
    const extracted  = extractElementDetails(rootNode);

    // Step 5: Print tree view
    console.log('📋 Page Structure:');
    console.log('━'.repeat(55));
    printTree(extracted);

    // Step 6: Flatten for CSV
    const flatRows   = flattenElement(extracted);

    // Step 7: Save outputs
    fs.mkdirSync('./figma/exports', { recursive: true });

    // Full JSON
    fs.writeFileSync(
      './figma/exports/ppv-checkout-full.json',
      JSON.stringify(extracted, null, 2)
    );

    // CSV/Excel
    fs.writeFileSync(
      './figma/exports/ppv-checkout.csv',
      toCSV(flatRows)
    );

    // Summary JSON (just key values)
    const summary = {
      page:    TARGET_PAGE,
      section: TARGET_SECTION,
      totalElements: flatRows.length,
      colors:     [...new Set(flatRows.map(r => r.FillColor).filter(Boolean))],
      textColors: [...new Set(flatRows.map(r => r.TextColor).filter(Boolean))],
      fontSizes:  [...new Set(flatRows.map(r => r.FontSize).filter(Boolean))],
      fontWeights:[...new Set(flatRows.map(r => r.FontWeight).filter(Boolean))],
      fontFamilies:[...new Set(flatRows.map(r => r.FontFamily).filter(Boolean))],
    };

    fs.writeFileSync(
      './figma/exports/ppv-checkout-summary.json',
      JSON.stringify(summary, null, 2)
    );

    // Print Summary
    console.log('\n✅ Extraction Complete!');
    console.log('━'.repeat(55));
    console.log(`📦 Total Elements : ${flatRows.length}`);
    console.log(`🎨 Unique Colors  : ${summary.colors.length}`);
    console.log(`   ${summary.colors.join(', ')}`);
    console.log(`🔤 Font Sizes     : ${summary.fontSizes.join(', ')}`);
    console.log(`💪 Font Weights   : ${summary.fontWeights.join(', ')}`);
    console.log('━'.repeat(55));
    console.log('📁 Full JSON  : ./figma/exports/ppv-checkout-full.json');
    console.log('📊 CSV/Excel  : ./figma/exports/ppv-checkout.csv');
    console.log('📋 Summary    : ./figma/exports/ppv-checkout-summary.json\n');

  } catch (err) {
    console.error('\n❌ Failed:', err);
    process.exit(1);
  }
}

main();
