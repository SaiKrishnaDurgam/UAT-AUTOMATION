import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Utility to manage a pool of single-use PAC URLs in an Excel file.
 * Automatically picks the first unused URL and marks it as USED with a timestamp.
 */
export class PacUrlPool {
  private excelPath: string;

  constructor(partnerConfigName: string) {
    // Determine the Excel filename based on the partner config name (e.g. mobilevikings_be -> viking_be_links.xlsx)
    const baseName = partnerConfigName.toLowerCase();
    let fileName = 'viking_be_links.xlsx';
    if (baseName.includes('viking')) {
      fileName = 'viking_be_links.xlsx';
    } else {
      fileName = `${baseName}_links.xlsx`;
    }
    const pac2Path = path.resolve(__dirname, `../data/pac2/${fileName}`);
    this.excelPath = fs.existsSync(pac2Path) ? pac2Path : path.resolve(__dirname, `../data/pac/${fileName}`);
  }

  /**
   * Reads the pool, finds the first unused URL, marks it as USED, saves the sheet, and returns it.
   */
  async getNextUnusedUrl(): Promise<string> {
    if (!fs.existsSync(this.excelPath)) {
      throw new Error(
        `❌ [PAC URL Pool] Link pool Excel file is missing at: ${this.excelPath}\n` +
        `   Please ensure the file exists before running the test.`
      );
    }

    console.log(`📊 [PAC URL Pool] Reading pool file: ${this.excelPath}`);
    const workbook = XLSX.readFile(this.excelPath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    
    // Parse rows including empty cells
    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
    if (!rows.length) {
      throw new Error(`❌ [PAC URL Pool] Excel sheet "${sheetName}" is empty.`);
    }

    // Search for first row where Status is blank or not USED, EXPIRED, CLAIMED
    let targetRowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const status = String(rows[i].Status || '').trim().toUpperCase();
      if (status !== 'USED' && status !== 'EXPIRED' && status !== 'CLAIMED') {
        targetRowIndex = i;
        break;
      }
    }

    if (targetRowIndex === -1) {
      throw new Error(
        `❌ [PAC URL Pool] All URLs in the Excel pool have been USED, EXPIRED, or CLAIMED.\n` +
        `   Please replenish ${this.excelPath} with fresh partner links.`
      );
    }

    const row = rows[targetRowIndex];
    const url = (row.Url || '').trim();
    if (!url) {
      throw new Error(`❌ [PAC URL Pool] Found an unused row at index ${targetRowIndex + 1} but the Url column is empty.`);
    }

    console.log(`🎯 [PAC URL Pool] Picked unused URL (Row ${targetRowIndex + 2}): ${url}`);

    // Update row status and timestamp
    row.Status = 'USED';
    row.Timestamp = new Date().toISOString();

    // Write back to the Excel file
    const updatedWs = XLSX.utils.json_to_sheet(rows);
    workbook.Sheets[sheetName] = updatedWs;
    XLSX.writeFile(workbook, this.excelPath);
    console.log(`💾 [PAC URL Pool] Marked URL as USED and saved back to Excel.`);

    return url;
  }

  /**
   * Peeks the first URL in the pool to determine the environment (staging vs. prod) without marking it as used.
   */
  async peekUrl(): Promise<string> {
    if (!fs.existsSync(this.excelPath)) {
      throw new Error(`❌ [PAC URL Pool] Link pool Excel file is missing at: ${this.excelPath}`);
    }
    const workbook = XLSX.readFile(this.excelPath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
    if (!rows.length) {
      throw new Error(`❌ [PAC URL Pool] Excel sheet "${sheetName}" is empty.`);
    }
    const url = (rows[0].Url || '').trim();
    if (!url) {
      throw new Error(`❌ [PAC URL Pool] The first URL in the pool is empty.`);
    }
    return url;
  }

  /**
   * Marks a specific URL in the Excel pool with a custom status (e.g. EXPIRED or CLAIMED).
   */
  async markUrlStatus(url: string, status: string): Promise<void> {
    if (!fs.existsSync(this.excelPath)) return;
    
    console.log(`✏️ [PAC URL Pool] Updating status of URL: ${url} to: ${status}`);
    const workbook = XLSX.readFile(this.excelPath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
    
    let updated = false;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i].Url || '').trim() === url.trim()) {
        rows[i].Status = status.toUpperCase();
        rows[i].Timestamp = new Date().toISOString();
        updated = true;
        break;
      }
    }
    
    if (updated) {
      const updatedWs = XLSX.utils.json_to_sheet(rows);
      workbook.Sheets[sheetName] = updatedWs;
      XLSX.writeFile(workbook, this.excelPath);
      console.log(`💾 [PAC URL Pool] Status successfully saved back to Excel.`);
    } else {
      console.warn(`⚠️ [PAC URL Pool] Could not find URL in pool to update: ${url}`);
    }
  }
}
