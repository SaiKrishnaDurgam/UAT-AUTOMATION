import path from 'path';
import fs   from 'fs';

function findConfig(dir: string, filename: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findConfig(full, filename);
      if (found) return found;
    } else if (entry.name === filename) {
      return full;
    }
  }
  return null;
}

function findBaseConfig(eventConfigPath: string): any | null {
  let dir = path.dirname(eventConfigPath);
  for (let i = 0; i < 3; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    try {
      const baseFile = fs.readdirSync(dir).find(f => f.endsWith('_base.json'));
      if (baseFile) {
        console.log(`📎 Base config: ${baseFile}`);
        return require(path.join(dir, baseFile));
      }
    } catch {}
  }
  return null;
}

function mergeWithBase(base: any, event: any): any {
  const result = { ...base, ...event };

  if (base.regions && event.regions) {
    result.regions = {};
    const regions = new Set([
      ...Object.keys(base.regions),
      ...Object.keys(event.regions),
    ]);
    for (const r of regions) {
      result.regions[r] = {
        ...(base.regions[r] || {}),
        ...(event.regions[r] || {}),
      };
    }
  }

  return result;
}

export function loadPPVConfig(daznEnv: string, eventConfig: string): any {
  const configDir = path.resolve(process.cwd(), 'config', daznEnv);

  const directPath = path.join(configDir, eventConfig);
  const eventConfigPath = fs.existsSync(directPath)
    ? directPath
    : findConfig(configDir, eventConfig);

  if (!eventConfigPath) {
    throw new Error(
      `❌ Config not found: "${eventConfig}"\n` +
      `   Searched in: ${configDir} (DAZN_ENV=${daznEnv})`
    );
  }

  console.log(`📁 Config: ${path.basename(eventConfigPath)}`);
  const eventCfg = require(eventConfigPath);

  if (eventCfg.PPV_NAME && eventCfg.regions) {
    const sampleRegion = Object.values(eventCfg.regions)[0] as any;
    if (sampleRegion?.BASE_URL) return eventCfg;
  }

  const baseCfg = findBaseConfig(eventConfigPath);
  if (baseCfg) return mergeWithBase(baseCfg, eventCfg);

  return eventCfg;
}
