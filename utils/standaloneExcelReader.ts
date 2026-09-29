import * as XLSX from 'xlsx';
import * as path from 'path';

const FILE_PATH = path.resolve(process.cwd(), 'data/Standalone_Input.xlsx');

export const readStandaloneSheet = (sheetName: string) => {
  const workbook = XLSX.readFile(FILE_PATH);
  const sheet    = workbook.Sheets[sheetName];

  if (!sheet) {
    const available = workbook.SheetNames.join(', ');
    throw new Error(
      `❌ Sheet not found: "${sheetName}" in ${FILE_PATH}\n` +
      `   Available sheets: ${available}`
    );
  }

  const rawData: any[] = XLSX.utils.sheet_to_json(sheet);
  return rawData;
};
