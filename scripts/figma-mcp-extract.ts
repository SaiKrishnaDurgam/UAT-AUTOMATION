import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────
// CONFIG - Just update these!
// ─────────────────────────────────────────
const FIGMA_TOKEN    = process.env.FIGMA_TOKEN!;
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY!;  // from URL
const PAGE_NAME      = process.env.PAGE_NAME || 'Mobile'; // page to extract

// ─────────────────────────────────────────
// FETCH SPECIFIC PAGE
// ─────────────────────────────────────────
async function getPageDetails() {
  console.log('\n�� Fetching Figma Page Details...');
  console.log('━'.repeat(55));

  // Step 1: Get file structure
  const fileRes = await fetch(
    `https://api.figma.com/v1/files/${FIGMA_FILE_KEY}`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );

  const fileData = await fileRes.json() as any;

  // Step 2: Find the specific page
  const pages = fileData.document.children;
  console.log('\n📄 Available Pages:');
  pages.forEach((p: any, i: number) => {
    console.log(`   ${i + 1}. ${p.name} (${p.children?.length || 0} frames)`);
  });

  const targetPage = pages.find((p: any) =>
    p.name.toLowerCase().includes(PAGE_NAME.toLowerCase())
  ) || pages[0];

  console.log(`\n✅ Extracting: "${targetPage.name}"`);

  // Step 3: Get all frame IDs on this page
  const frameIds = targetPage.children
    .map((f: any) => f.id)
    .join(',');

  // Step 4: Fetch detailed node data
  const nodesRes = await fetch(
    `https://api.figma.com/v1/files/${FIGMA_FILE_KEY}/nodes?ids=${frameIds}`,
    { headers: { 'X-Figma-Token': FIGMA_TOKEN } }
  );

  const nodesData = await nodesRes.json() as any;

  // Step 5: Extract all details section by section
  const pageDetails: any = {
    pageName:   targetPage.name,
    extractedAt: new Date().toISOString(),
    sections:   {}
  };

  for (const [nodeId, nodeData] of Object.entries(nodesData.nodes)) {
    const node = (nodeData as any).document;
    console.log(`\n   🔲 Section: ${node.name}`);

    pageDetails.sections[node.name] = {
      id:         node.id,
      type:       node.type,
      dimensions: {
        width:  node.absoluteBoundingBox?.width,
        height: node.absoluteBoundingBox?.height,
      },
      colors:     {},
      typography: {},
      spacing:    {},
      components: [],
      elements:   []
    };

    // Deep extract all elements
    extractAllElements(
      node,
      pageDetails.sections[node.name],
      node.name
    );
  }

  return pageDetails;
}

// ─────────────────────────────────────────
// DEEP EXTRACT ALL ELEMENTS
// ─────────────────────────────────────────
function extractAllElements(node: any, section: any, sectionName: string) {

  // Colors
  if (node.fills?.length > 0) {
    node.fills
      .filter((f: any) => f.type === 'SOLID' && f.color)
      .forEach((f: any) => {
        section.colors[node.name] = rgbaToHex(
          f.color.r, f.color.g, f.color.b
        );
      });
  }

  // Typography
  if (node.type === 'TEXT' && node.style) {
    section.typography[node.name] = {
      content:       node.characters,
      fontFamily:    node.style.fontFamily,
      fontSize:      `${node.style.fontSize}px`,
      fontWeight:    node.style.fontWeight,
      lineHeight:    node.style.lineHeightPx
        ? `${node.style.lineHeightPx}px` : 'auto',
      letterSpacing: node.style.letterSpacing,
      textAlign:     node.style.textAlignHorizontal,
      color: node.fills?.[0]?.color
        ? rgbaToHex(
            node.fills[0].color.r,
            node.fills[0].color.g,
            node.fills[0].color.b
          )
        : null
    };
  }

  // Spacing & Layout
  if (node.paddingTop !== undefined ||
      node.paddingLeft !== undefined) {
    section.spacing[node.name] = {
      paddingTop:    `${node.paddingTop    ?? 0}px`,
      paddingBottom: `${node.paddingBottom ?? 0}px`,
      paddingLeft:   `${node.paddingLeft   ?? 0}px`,
      paddingRight:  `${node.paddingRight  ?? 0}px`,
      gap:           `${node.itemSpacing   ?? 0}px`,
      borderRadius:  `${node.cornerRadius  ?? 0}px`,
      width:         node.absoluteBoundingBox?.width,
      height:        node.absoluteBoundingBox?.height,
    };
  }

  // Components
  if (node.type === 'COMPONENT' ||
      node.type === 'INSTANCE') {
    section.components.push({
      name:       node.name,
      type:       node.type,
      componentId: node.componentId,
      width:      node.absoluteBoundingBox?.width,
      height:     node.absoluteBoundingBox?.height,
    });
  }

  // Recurse into children
  node.children?.forEach((child: any) =>
    extractAllElements(child, section, sectionName)
  );
}

// ─────────────────────────────────────────
// FLATTEN TO CSV/EXCEL
// ─────────────────────────────────────────
function flattenToCSV(pageDetails: any): string {
  const rows: any[] = [];

  Object.entries(pageDetails.sections).forEach(
    ([sectionName, section]: any) => {

    // Colors
    Object.entries(section.colors).forEach(([name, color]) => {
      rows.push({
        Section:   sectionName,
        Element:   name,
        Property:  'Color',
        Value:     color,
        Category:  'Colors'
      });
    });

    // Typography
    Object.entries(section.typography).forEach(
      ([name, typo]: any) => {
      Object.entries(typo).forEach(([prop, val]) => {
        rows.push({
          Section:   sectionName,
          Element:   name,
          Property:  prop,
          Value:     val,
          Category:  'Typography'
        });
      });
    });

    // Spacing
    Object.entries(section.spacing).forEach(
      ([name, space]: any) => {
      Object.entries(space).forEach(([prop, val]) => {
        rows.push({
          Section:   sectionName,
          Element:   name,
          Property:  prop,
          Value:     val,
          Category:  'Spacing'
        });
      });
    });
  });

  // Build CSV
  const headers = ['Section', 'Element', 'Category', 'Property', 'Value'];
  const csvRows = rows.map(r =>
    headers.map(h =>
      `"${String(r[h] ?? '').replace(/"/g, '""')}"`
    ).join(',')
  );

  return [headers.join(','), ...csvRows].join('\n');
}

// ─────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────
function rgbaToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  try {
    const pageDetails = await getPageDetails();

    // Create output directory
    fs.mkdirSync('./figma/exports', { recursive: true });

    // Save JSON
    fs.writeFileSync(
      './figma/exports/page-details.json',
      JSON.stringify(pageDetails, null, 2)
    );

    // Save CSV
    fs.writeFileSync(
      './figma/exports/page-details.csv',
      flattenToCSV(pageDetails)
    );

    // Print Summary
    console.log('\n✅ Extraction Complete!');
    console.log('━'.repeat(55));
    const sections = Object.keys(pageDetails.sections);
    sections.forEach(s => {
      const sec = pageDetails.sections[s];
      console.log(`\n   📦 ${s}`);
      console.log(`      🎨 Colors     : ${Object.keys(sec.colors).length}`);
      console.log(`      🔤 Typography : ${Object.keys(sec.typography).length}`);
      console.log(`      📐 Spacing    : ${Object.keys(sec.spacing).length}`);
      console.log(`      🧩 Components : ${sec.components.length}`);
    });
    console.log('\n━'.repeat(55));
    console.log('📁 JSON : ./figma/exports/page-details.json');
    console.log('📊 CSV  : ./figma/exports/page-details.csv\n');

  } catch (err) {
    console.error('❌ Failed:', err);
    process.exit(1);
  }
}

main();
