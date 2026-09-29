import fs from 'fs';
import path from 'path';

function deepMerge(base: any, override: any): any {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      base[key] !== undefined &&
      typeof base[key] === 'object'
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

function alignRegions(data: any) {
  if (!data || !data.regions) return;
  const gb = data.regions.GB;
  const uk = data.regions.UK;
  // Backward-compat: if an old config only has UK, copy it to GB
  if (uk && !gb) {
    data.regions.GB = deepMerge({}, uk);
  }
  // Clean up: remove UK key entirely so only GB is used
  if (data.regions.UK) {
    delete data.regions.UK;
  }
}

function normalizeRegionKey(region: string): string {
  return (region || 'GB').toUpperCase();
}

export interface CanadaUFTConfig {
  tier: 'Standard' | 'Ultimate';
  subscriptionInput: string;
  subscriptionCard: 'DAZN' | 'DAZN+' | 'DAZN Ultimate' | 'DAZN+ Ultimate';
  plan: 'Annual - Pay over time' | 'Annual - Pay now' | 'Monthly';
  rawPlanInput: string;
  tierPlanDisplay: string;
  flowDisplay: string;
}

/**
 * Parses the Canada tier/card/plan command in the format
 * `<tier>-<subscription>-<plan>`, for example:
 * `ultimate-dazn+-Annual-pay now`.
 */
export function parseCanadaCommand(commandStr?: string): CanadaUFTConfig {
  const rawInput = (commandStr || process.env.CANADA_PLAN || process.env.UFT_PLAN || process.env.PLAN || '').trim();
  if (!rawInput) {
    const userState = (process.env.USER_STATE || '').toLowerCase();
    if (userState.startsWith('active_')) {
      console.log(`[Canada Command Parser] No CANADA_PLAN supplied for active user ("${userState}"). Direct PPV addon purchase flow will be executed.`);
      return {
        tier: 'Standard',
        subscriptionInput: 'dazn',
        subscriptionCard: 'DAZN',
        plan: 'Monthly',
        rawPlanInput: 'monthly',
        tierPlanDisplay: 'Active User (No Plan Required)',
        flowDisplay: `${process.env.SOURCE || 'myaccount'} -> ${userState} -> PPV Addon Purchase`,
      };
    }

    throw new Error(
      '[Canada Command Parser] CANADA_PLAN is required for Canada subscription flow. ' +
      'Use format "<tier>-<subscription>-<plan>", for example "standard-dazn+-annual-pay now".'
    );
  }

  const input = rawInput.toLowerCase();
  console.log(`[Canada Command Parser] Parsing command input: "${rawInput}"`);

  let tier: 'Standard' | 'Ultimate';

  const rawParts = rawInput.split('-').map(part => part.trim());
  if (rawParts.length < 3) {
    throw new Error(
      `[Canada Command Parser] Invalid CANADA_PLAN "${rawInput}". ` +
      'Use format "<tier>-<subscription>-<plan>", for example "ultimate-dazn+-annual-pay now".'
    );
  }
  const subscriptionInput = rawParts[1];
  const rawPlanInput = rawParts.slice(2).join('-');

  if (input.startsWith('ultimate')) {
    tier = 'Ultimate';
  } else if (input.startsWith('standard')) {
    tier = 'Standard';
  } else {
    throw new Error(
      `[Canada Command Parser] Invalid Canada tier in CANADA_PLAN "${rawInput}". Expected "standard" or "ultimate".`
    );
  }

  const subLower = subscriptionInput.toLowerCase();
  let subscriptionCard: CanadaUFTConfig['subscriptionCard'];
  if (tier === 'Standard') {
    subscriptionCard = subLower.includes('dazn+') || subLower.includes('plus') ? 'DAZN+' : 'DAZN';
  } else {
    subscriptionCard = subLower.includes('dazn+') || subLower.includes('plus') ? 'DAZN+ Ultimate' : 'DAZN Ultimate';
  }

  const planLower = rawPlanInput.toLowerCase();
  let plan: CanadaUFTConfig['plan'];
  if (planLower.includes('over time') || planLower.includes('pay over time')) {
    plan = 'Annual - Pay over time';
  } else if (planLower.includes('pay now') || planLower.includes('upfront')) {
    plan = 'Annual - Pay now';
  } else if (planLower.includes('monthly') || planLower.includes('month')) {
    plan = 'Monthly';
  } else {
    throw new Error(
      `[Canada Command Parser] Invalid Canada plan in CANADA_PLAN "${rawInput}". ` +
      'Expected "annual-pay over time", "annual-pay now", or "monthly".'
    );
  }

  const cardDisplay = subscriptionCard.includes('+') ? 'DAZN+' : 'DAZN';
  const tierPlanDisplay = `${tier} -> ${cardDisplay} -> ${plan}`;
  const sourceStr = process.env.SOURCE || 'myaccount';
  const userStateStr = process.env.USER_STATE || 'freemium';
  const flowDisplay = `${sourceStr} -> ${userStateStr} -> ${tierPlanDisplay}`;

  const config: CanadaUFTConfig = {
    tier,
    subscriptionInput,
    subscriptionCard,
    plan,
    rawPlanInput,
    tierPlanDisplay,
    flowDisplay,
  };

  console.log(`[Canada Config Parsed] Display: "${config.tierPlanDisplay}" | Flow: "${config.flowDisplay}"`);
  return config;
}

function findConfig(dir: string, filename: string): string | null {
  if (!fs.existsSync(dir)) return null;

  // Search event files recursively so completed events can live under
  // config/events/completed without breaking filename-based invocations.
  function findInEvents(eventsRoot: string): string | null {
    if (!fs.existsSync(eventsRoot)) return null;
    const entries = fs.readdirSync(eventsRoot, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(eventsRoot, entry.name);
      if (entry.isDirectory()) {
        const found = findInEvents(full);
        if (found) return found;
      } else if (entry.name === filename) {
        return full;
      }
    }
    return null;
  }

  // 1. Check config/events and its subfolders first if dir is config/
  const eventsDir = path.join(dir, 'events');
  if (fs.existsSync(eventsDir)) {
    const eventsPath = findInEvents(eventsDir);
    if (eventsPath) return eventsPath;
  }

  // 2. Check config/filename
  const directPath = path.join(dir, filename);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  // 3. Recursively search other directories
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'events') {
      const found = findConfig(path.join(dir, entry.name), filename);
      if (found) return found;
    }
  }
  return null;
}

export function loadEventConfig(eventConfigOrKey?: string, planKeyOverride?: string): Record<string, any> {
  const configSource = process.env.PPV_CONFIG || process.env.PPV_EVENT || eventConfigOrKey || 'ppv_t_joshua_prenga.json';

  let filePath: string | null = null;

  // If it's a direct path that exists, use it
  if (fs.existsSync(configSource) && fs.statSync(configSource).isFile()) {
    filePath = configSource;
  } else {
    // Determine the filename to search recursively under config/
    let filename = path.basename(configSource);
    if (!filename.toLowerCase().endsWith('.json')) {
      filename += '.json';
    }
    // Resolve config/ relative to this file's location (project root),
    // not process.cwd(), so it works even when tests run from appium/ or other subdirs.
    const configDir = path.resolve(__dirname, '..', 'config');
    filePath = findConfig(configDir, filename);
  }

  if (!filePath) {
    throw new Error(`❌ Configuration file "${configSource}" not found recursively under config/`);
  }

  let eventData: any = {};
  try {
    eventData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    console.log(`📄 Loaded event configuration file: ${filePath}`);
  } catch (err: any) {
    throw new Error(`❌ Failed to parse event config file ${filePath}: ${err.message}`);
  }

  if (process.env.PPV_DEV_MODE === 'true') {
    eventData.PPV_DEV_MODE = true;
  } else if (process.env.PPV_DEV_MODE === 'false') {
    eventData.PPV_DEV_MODE = false;
  }

  if (process.env.DEFAULT_SIGNUP_DEVMODE === 'true') {
    eventData.DEFAULT_SIGNUP_DEVMODE = true;
    eventData.HAS_DEFAULT_SIGNUP_PPV = false;
  } else if (process.env.DEFAULT_SIGNUP_DEVMODE === 'false') {
    eventData.DEFAULT_SIGNUP_DEVMODE = false;
    eventData.HAS_DEFAULT_SIGNUP_PPV = true;
  }

  // Load plan data if needed
  const planKey = planKeyOverride || process.env.PLAN || 'standard_monthly';
  const configDirPlan = fs.existsSync(path.resolve(process.cwd(), 'config/DaznPlan.json'))
    ? path.resolve(process.cwd(), 'config')
    : path.resolve(__dirname, '..', 'config');
  const plansPath = path.join(configDirPlan, 'DaznPlan.json');
  let planData: any = {};

  if (fs.existsSync(plansPath)) {
    try {
      const plans = JSON.parse(fs.readFileSync(plansPath, 'utf-8'));
      planData = plans[planKey] || {};
    } catch (err: any) {
      console.warn(`⚠️ Failed to parse DaznPlan.json:`, err.message);
    }
  }

  // Validate that the selected plan supports the target region
  const region = process.env.DAZN_REGION || 'GB';
  const regionKey = normalizeRegionKey(region);
  if (planData.regions && Object.keys(planData.regions).length > 0) {
    const planRegions = Object.keys(planData.regions);
    if (!planRegions.includes(regionKey)) {
      const planDisplayName = `${planData.TIER || 'unknown'} ${planData.RATE_PLAN || planKey}`.trim();
      throw new Error(
        `❌ No "${planDisplayName}" plan available for region "${region}".\n` +
        `   Available regions for this plan: ${planRegions.join(', ')}\n` +
        `   Please choose a different plan or region.`
      );
    }
  }

  alignRegions(planData);
  alignRegions(eventData);

  let merged = deepMerge(planData, eventData);
  merged.eventKey = eventData.eventKey || path.basename(filePath, '.json');
  merged.planKey = planKey;

  return merged;
}
