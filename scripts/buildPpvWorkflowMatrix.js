#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [mode, configName, country] = process.argv.slice(2);
const baseName = path.basename(configName || '');
let configPath = path.join('config', 'events', baseName);
if (!fs.existsSync(configPath)) configPath = path.join('config', 'events', 'completed', baseName);
if (!mode || !configName || !country) throw new Error('Usage: buildPpvWorkflowMatrix.js <mode> <PPV_CONFIG> <COUNTRY>');
if (!fs.existsSync(configPath)) throw new Error(`PPV config not found: ${configName}`);

const event = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (country === 'SA' && event.regions && !event.regions.SA) {
  event.regions.SA = JSON.parse(JSON.stringify(event.regions.AE || event.regions.GB || {}));
}
if (country === 'CA' && event.regions && !event.regions.CA) {
  event.regions.CA = JSON.parse(JSON.stringify(event.regions.US || event.regions.GB || {}));
}

if (process.env.PPV_DEV_MODE === 'true') {
  event.PPV_DEV_MODE = true;
} else if (process.env.PPV_DEV_MODE === 'false') {
  event.PPV_DEV_MODE = false;
}

if (process.env.DEFAULT_SIGNUP_DEVMODE === 'true') {
  event.DEFAULT_SIGNUP_DEVMODE = true;
  event.HAS_DEFAULT_SIGNUP_PPV = false;
} else if (process.env.DEFAULT_SIGNUP_DEVMODE === 'false') {
  event.DEFAULT_SIGNUP_DEVMODE = false;
  event.HAS_DEFAULT_SIGNUP_PPV = true;
}
if (!event.regions?.[country]) throw new Error(`${configName} is not available in ${country}: regions.${country} is missing.`);

const sourceConfig = JSON.parse(fs.readFileSync('config/surfacingpoint.json', 'utf8'));
const planConfig = JSON.parse(fs.readFileSync('config/DaznPlan.json', 'utf8'));
const isBoxing = String(event.SPORT || '').trim().toLowerCase() === 'boxing';
const isBkfc = String(event.SPORT || '').trim().toLowerCase() === 'bkfc';
const isKickboxing = String(event.SPORT || '').toLowerCase() === 'kickboxing';
const isStandalonePPV = String(event.PPV_TYPE || '').trim().toLowerCase() === 'standalone';
const isStandardOnlyPPV = isStandalonePPV || String(event.PPV_TYPE || '').trim().toLowerCase() === 'upsell';
const hasBundle = event.HAS_BUNDLE === true;
const defaultSignupDevMode = event.DEFAULT_SIGNUP_DEVMODE === true;
const hasDefaultSignup = event.HAS_DEFAULT_SIGNUP_PPV === true;
// The workflow matrix must only contain plans offered in the selected country.
// `loadEventConfig` validates this too, but filtering here avoids creating CI jobs
// that are guaranteed to fail (for example, standard_apm is not offered in AE).
const requestedPlans = (isStandardOnlyPPV
  ? ['standard_monthly', 'standard_apm']
  : ['standard_monthly', 'standard_apm', 'ultimate_apm', 'ultimate_upfront']
);
const standardPlans = requestedPlans.filter((plan) => planConfig[plan]?.regions?.[country]);
if (standardPlans.length === 0) {
  throw new Error(`No supported plans are configured for ${country} in DaznPlan.json.`);
}

// Canada uses a completely different plan format: <tier>-<subscription>-<plan>
// e.g. "standard-dazn-annual-pay over time".
// Canada has 2 tiers × 2 subscriptions × 3 billing options = 12 combinations.
// These are built directly rather than mapped from DaznPlan.json keys.
const availableCanadaPlans = [
  'standard-dazn-monthly',
  'standard-dazn-annual-pay over time',
  'standard-dazn-annual-pay now',
  'standard-dazn+-monthly',
  'standard-dazn+-annual-pay over time',
  'standard-dazn+-annual-pay now',
  'ultimate-dazn-monthly',
  'ultimate-dazn-annual-pay over time',
  'ultimate-dazn-annual-pay now',
  'ultimate-dazn+-monthly',
  'ultimate-dazn+-annual-pay over time',
  'ultimate-dazn+-annual-pay now',
];
const canadaPlans = country === 'CA'
  ? availableCanadaPlans.filter((plan) => !isStandardOnlyPPV || plan.startsWith('standard-'))
  : null;

// For existing/signed-in CA jobs:
// - freemium + frozen × all 12 plans (new/returning subscribers)
// - active users on the verified CA account states purchase PPV as an add-on.
// active_standard_apm is intentionally excluded until its placeholder
// credentials in userstatus.json are replaced with a verified CA account.
const canadaProfiles = canadaPlans ? [
  // Freemium (no subscription) — all 12 plan combinations
  ...canadaPlans.map((plan) => `freemium/${plan}`),
  // Frozen (lapsed subscription) — all 12 plan combinations
  ...canadaPlans.map((plan) => `frozen/${plan}`),
  'active_standard_monthly/standard-dazn-monthly',
  'active_ultimate_apm/ultimate-dazn-annual-pay over time',
  'active_ultimate_upfront/ultimate-dazn-annual-pay now',
] : null;

const regularProfiles = [
  'freemium/standard_monthly',
  'active_standard_monthly/standard_monthly',
  'frozen/standard_monthly',
  'active_ultimate_apm/ultimate_apm',
  'freemium/standard_apm',
  'active_standard_apm/standard_apm',
  'frozen/standard_apm',
  'active_ultimate_upfront/ultimate_upfront',
  'freemium/ultimate_apm',
  'active_standard_monthly/ultimate_apm',
  'frozen/ultimate_apm',
  'active_standard_apm/ultimate_apm',
  'freemium/ultimate_upfront',
  'active_standard_monthly/ultimate_upfront',
  'frozen/ultimate_upfront',
].filter((profile) => standardPlans.includes(profile.split('/')[1]));
const ultimateOnly = new Set(['boxing-banner-ultimate', 'boxing-ultimate-subscription', 'boxing-join-the-club']);
const validUltimateProfiles = new Set(['active_standard_monthly/ultimate_apm', 'active_standard_monthly/ultimate_upfront', 'active_standard_apm/ultimate_apm']);
const removalExcludedSources = new Set(['boxing-standard-subscription', 'boxing-ultimate-subscription', 'boxing-join-the-club', 'home-page-dazntile', 'home-page-get-started']);
// Sources that open a subscription modal — active users already have a subscription so
// no modal appears and the flow gets stuck. Only freemium/frozen profiles are valid.
const activeSubscribedExcludedSources = new Set(['home-page-dazntile', 'home-page-get-started', 'boxing-standard-subscription', 'boxing-ultimate-subscription']);
const isActiveSubscribed = (profile) => profile.startsWith('active_standard_') || profile.startsWith('active_ultimate_');
// Boxing PPVs are surfaced through the complete set of boxing-specific entry
// points. Other sports use the sport tile, the home-page Don't Miss tile,
// Search, Schedule, and (for authenticated users) My Account.
// `home-boxing-tile` is the legacy source key for the sport tile; the page
// object resolves the actual destination from event.SPORT.
const liveSources = {
  new: isBoxing
    ? ['boxing-banner-ultimate', 'boxing-join-the-club', 'boxing-page-banner', 'boxing-page-bundle', 'boxing-standard-subscription', 'boxing-upcoming-fights', 'boxing-ultimate-subscription', 'home-biggest-fights', 'home-boxing-banner', 'home-boxing-tile', 'home-boxing-upcoming', 'home-kickboxing-tile', 'home-page-banner', 'home-page-dazntile', 'home-page-dont-miss', 'home-page-get-started', 'home-page-popup', 'landing-page-banner', 'landing-page-dont-miss-live', 'schedule', 'search']
    : ['landing-page-banner', 'home-page-banner', 'home-boxing-banner', 'home-boxing-tile', 'home-page-dont-miss', 'home-page-popup', 'schedule', 'search'],
  existing: isBoxing
    ? ['landing-page-banner', 'home-page-banner', 'home-page-dont-miss', 'home-biggest-fights', 'home-page-dazntile', 'home-page-popup', 'home-boxing-banner', 'home-boxing-tile', 'home-boxing-upcoming', 'home-kickboxing-tile', 'boxing-page-banner', 'boxing-page-bundle', 'boxing-upcoming-fights', 'boxing-banner-ultimate', 'boxing-ultimate-subscription', 'boxing-standard-subscription', 'boxing-join-the-club', 'search', 'schedule', 'myaccount']
    : ['landing-page-banner', 'home-page-banner', 'home-boxing-banner', 'home-boxing-tile', 'home-page-dont-miss', 'home-page-popup', 'schedule', 'search', 'myaccount'],
  signed: isBoxing
    ? ['home-page-banner', 'home-page-dont-miss', 'home-biggest-fights', 'home-page-dazntile', 'home-page-popup', 'home-boxing-banner', 'home-boxing-tile', 'home-boxing-upcoming', 'home-kickboxing-tile', 'boxing-page-banner', 'boxing-page-bundle', 'boxing-upcoming-fights', 'boxing-banner-ultimate', 'boxing-ultimate-subscription', 'boxing-standard-subscription', 'boxing-join-the-club', 'search', 'schedule', 'myaccount']
    : ['home-page-banner', 'home-boxing-banner', 'home-boxing-tile', 'home-page-dont-miss', 'home-page-popup', 'schedule', 'search', 'myaccount'],
};
const standaloneGlorySources = isStandalonePPV
  ? ['glory-tile', 'glory-banner'].filter((source) => sourceConfig[source])
  : [];
if (standaloneGlorySources.length > 0) {
  liveSources.new.push(...standaloneGlorySources);
  liveSources.existing.push(...standaloneGlorySources);
  liveSources.signed.push(...standaloneGlorySources);
}

// Canada (CA): PPV is surfaced via search, schedule, sport/UFC page tile, and banners.
// home-page-dont-miss is not applicable for CA.
if (country === 'CA') {
  liveSources.new      = ['landing-page-banner', 'home-page-banner', 'home-boxing-banner', 'home-boxing-tile', 'schedule', 'search'];
  liveSources.existing = ['landing-page-banner', 'home-page-banner', 'home-boxing-banner', 'home-boxing-tile', 'schedule', 'search', 'myaccount'];
  liveSources.signed   = ['home-page-banner', 'home-boxing-banner', 'home-boxing-tile', 'schedule', 'search', 'myaccount'];
}
let androidNewSources = ['landing-page-banner', 'home-page-banner', 'home-page-dont-miss', 'home-page-popup', ...(isBoxing ? ['home-boxing-banner', 'home-boxing-upcoming'] : []), 'home-boxing-tile', 'schedule', 'search'];
if (isBkfc) {
  liveSources.new = liveSources.new.filter((source) => source !== 'home-page-dont-miss');
  liveSources.existing = liveSources.existing.filter((source) => source !== 'home-page-dont-miss');
  liveSources.signed = liveSources.signed.filter((source) => source !== 'home-page-dont-miss');
  androidNewSources = androidNewSources.filter((source) => source !== 'home-page-dont-miss');
}
let androidExistingSources = androidNewSources.filter(source => source !== 'landing-page-banner');
const androidProfiles = regularProfiles;
let detectedDevices = [];
try {
  const { execSync } = require('child_process');
  const adbOut = execSync('adb devices', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = adbOut.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
  detectedDevices = lines
    .filter(l => l.endsWith('\tdevice') || l.endsWith(' device'))
    .map(l => l.split(/\s+/)[0]);
} catch (e) {
  // ADB optional during build step
}

const defaultSerial = process.env.DEVICE_SERIAL || detectedDevices[0] || '';
const secondSerial = process.env.DEVICE_SERIAL || detectedDevices[1] || defaultSerial;
const androidDevices = [
  { deviceSerial: defaultSerial, appiumPort: 4723, appiumSystemPort: 8200, chromedriverPort: 9515 },
  { deviceSerial: secondSerial, appiumPort: 4724, appiumSystemPort: 8201, chromedriverPort: 9516 },
];
const assignAndroidDevices = (entries) => entries.map((entry, index) => ({ ...entry, ...androidDevices[index % androidDevices.length] }));

const iosDevices = [
  { iosUdid: '00008110-001A255A2688201E', iosPlatformVersion: '16.5', appiumPort: 4723, wdaUrl: 'http://127.0.0.1:8100', mjpegServerPort: 9100 },
];
const assignIosDevices = (entries) => entries.map((entry, index) => ({ ...entry, ...iosDevices[index % iosDevices.length] }));
let iosNewSources = [...androidNewSources];
let iosExistingSources = [...androidExistingSources];
const iosProfiles = regularProfiles;

const filterBanners = (sources) => {
  if (process.env.BANNERS_CONFIGURED === 'false') {
    return sources.filter(source => !source.toLowerCase().includes('banner'));
  }
  if (process.env.BANNERS_CONFIGURED === 'true') {
    return sources.filter(source => source.toLowerCase().includes('banner'));
  }
  return sources;
};

const filterPopups = (sources) => {
  if (process.env.POPUPS_CONFIGURED === 'false') {
    return sources.filter(source => !source.toLowerCase().includes('popup'));
  }
  if (process.env.POPUPS_CONFIGURED === 'true') {
    return sources.filter(source => source.toLowerCase().includes('popup'));
  }
  return sources;
};

// When both BANNERS and POPUPS are set to 'true', use union (OR) so both
// banner and popup sources are included. When either is 'false', exclude
// those sources. When 'all'/unset, pass through unchanged.
const filterBannersAndPopups = (sources) => {
  const bannersTrue = process.env.BANNERS_CONFIGURED === 'true';
  const popupsTrue = process.env.POPUPS_CONFIGURED === 'true';
  if (bannersTrue && popupsTrue) {
    return sources.filter(source => {
      const lower = source.toLowerCase();
      return lower.includes('banner') || lower.includes('popup');
    });
  }
  return filterPopups(filterBanners(sources));
};

androidNewSources = filterBannersAndPopups(androidNewSources);
androidExistingSources = filterBannersAndPopups(androidExistingSources);
iosNewSources = filterBannersAndPopups(iosNewSources);
iosExistingSources = filterBannersAndPopups(iosExistingSources);

const applicable = (sources, allowDefaultSignup = hasDefaultSignup) => {
  const filtered = sources.filter((source) => {
    if (source === 'home-kickboxing-tile' && !isKickboxing) return false;
    if (source === 'boxing-page-bundle' && !hasBundle) return false;
    return !sourceConfig[source]?.defaultSignup || allowDefaultSignup;
  });
  return filterBannersAndPopups(filtered);
};
const withOutput = (name, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${JSON.stringify(value)}\n`);

/**
 * Applies Canada plan remapping to matrix entries.
 * Adds a `canada_plan` field for CA and rewrites the `plan` field in `profile`
 * so the PLAN env var received by each job contains the right format.
 */
const applyCanadaPlans = (entries) => {
  if (country !== 'CA') return entries;
  return entries.map((entry) => {
    const out = { ...entry };
    if (out.plan) {
      out.plan = resolvePlan(out.plan);
    } else if (out.profile) {
      const parts = out.profile.split('/');
      const planKey = parts[parts.length - 1];
      parts[parts.length - 1] = resolvePlan(planKey);
      out.profile = parts.join('/');
    }
    return out;
  });
};

let matrix;
switch (mode) {
  case 'dev-account':
    if (event.PPV_DEV_MODE !== true) throw new Error(`${configName} requires PPV_DEV_MODE: true for this workflow.`);
    matrix = (canadaProfiles || [
      ...standardPlans.map((plan) => ({ source: 'myaccount', profile: `freemium/${plan}` })),
      ...standardPlans.map((plan) => ({ source: 'myaccount', profile: `frozen/${plan}` })),
      { source: 'myaccount', profile: 'active_standard_monthly/standard_monthly' },
      { source: 'myaccount', profile: 'active_standard_monthly/ultimate_apm' },
      { source: 'myaccount', profile: 'active_standard_monthly/ultimate_upfront' },
      ...(standardPlans.includes('standard_apm') ? [
        { source: 'myaccount', profile: 'active_standard_apm/standard_apm' },
        { source: 'myaccount', profile: 'active_standard_apm/ultimate_apm' },
      ] : []),
      { source: 'myaccount', profile: 'active_ultimate_apm/ultimate_apm' },
      { source: 'myaccount', profile: 'active_ultimate_upfront/ultimate_upfront' },
    ]).map((entry) => typeof entry === 'string'
      ? { source: 'myaccount', profile: entry }
      : entry);
    if (standaloneGlorySources.length > 0) {
      matrix.push(...standaloneGlorySources.flatMap((source) =>
        matrix.map((entry) => ({ ...entry, source }))
      ));
    }
    break;
  case 'live-new': {
    const sources = applicable(liveSources.new, false);
    if (canadaPlans) {
      // CA: all 12 tier×subscription×billing combinations per source
      matrix = sources.flatMap((source) => canadaPlans.map((plan) => ({ source, plan })));
    } else {
      matrix = sources.flatMap((source) => standardPlans.filter((plan) => !ultimateOnly.has(source) || plan.startsWith('ultimate_')).map((plan) => ({ source, plan })));
      if (isBoxing && process.env.BANNERS_CONFIGURED !== 'true' && process.env.POPUPS_CONFIGURED !== 'true') {
        matrix.push({ source: 'landing-page-dont-miss-live-switch', plan: 'standard_monthly', switch: 'true' }, { source: 'landing-page-dont-miss-live-switch', plan: 'standard_apm', switch: 'true' });
      }
    }
    break;
  }
  case 'live-existing': {
    const sources = applicable(liveSources.existing, false);
    if (canadaProfiles) {
      // CA: freemium + frozen user states × all 12 plan combinations per source
      matrix = sources.flatMap((source) => canadaProfiles.map((profile) => ({ source, profile })));
    } else {
      matrix = sources.flatMap((source) => regularProfiles.filter((profile) => !ultimateOnly.has(source) || validUltimateProfiles.has(profile)).map((profile) => ({ source, profile })));
      if (isBoxing && process.env.BANNERS_CONFIGURED !== 'true' && process.env.POPUPS_CONFIGURED !== 'true') {
        matrix.push({ source: 'landing-page-dont-miss-live-switch', profile: 'freemium/standard_monthly', switch: 'true' }, { source: 'landing-page-dont-miss-live-switch', profile: 'freemium/standard_apm', switch: 'true' });
      }
    }
    break;
  }
  case 'live-signed': {
    const sources = applicable(liveSources.signed, false);
    if (canadaProfiles) {
      // CA: freemium + frozen user states × all 12 plan combinations per source
      matrix = sources.flatMap((source) => canadaProfiles.map((profile) => ({ source, profile })));
    } else {
      matrix = sources.flatMap((source) => regularProfiles.filter((profile) => !ultimateOnly.has(source) || validUltimateProfiles.has(profile)).map((profile) => ({ source, profile })));
    }
    break;
  }
  case 'ufc-sanity-new':
  case 'web-sanity-new': {
    const sources = applicable(liveSources.new, false).filter((source) => !ultimateOnly.has(source));
    if (canadaPlans) {
      matrix = sources.map((source, index) => ({ source, plan: canadaPlans[index % canadaPlans.length] }));
    } else {
      matrix = sources.map((source, index) => {
        const plans = standardPlans.filter((plan) => !ultimateOnly.has(source) || plan.startsWith('ultimate_'));
        return { source, plan: plans[index % plans.length] };
      });
    }
    break;
  }
  case 'ufc-sanity-signin':
  case 'web-sanity-signin':
  case 'web-sanity-existing': {
    const sources = applicable(liveSources.existing, false).filter((source) => !ultimateOnly.has(source));
    if (canadaProfiles) {
      matrix = sources.map((source, index) => ({ source, profile: canadaProfiles[index % canadaProfiles.length] }));
    } else {
      matrix = sources.map((source, index) => {
        let profiles = regularProfiles.filter((profile) => !ultimateOnly.has(source) || validUltimateProfiles.has(profile));
        if (activeSubscribedExcludedSources.has(source)) {
          profiles = profiles.filter((p) => !isActiveSubscribed(p));
        }
        const ultimateProfile = source === 'schedule'
          ? 'active_ultimate_apm/ultimate_apm'
          : source === 'myaccount'
            ? 'active_ultimate_upfront/ultimate_upfront'
            : undefined;
        return { source, profile: ultimateProfile && profiles.includes(ultimateProfile) ? ultimateProfile : profiles[index % profiles.length] };
      });
    }
    break;
  }
  case 'ufc-sanity-signed':
  case 'web-sanity-signed': {
    const sources = applicable(liveSources.signed, false).filter((source) => !ultimateOnly.has(source));
    if (canadaProfiles) {
      matrix = sources.map((source, index) => ({ source, profile: canadaProfiles[(index + sources.length) % canadaProfiles.length] }));
    } else {
      matrix = sources.map((source, index) => {
        let profiles = regularProfiles.filter((profile) => !ultimateOnly.has(source) || validUltimateProfiles.has(profile));
        if (activeSubscribedExcludedSources.has(source)) {
          profiles = profiles.filter((p) => !isActiveSubscribed(p));
        }
        const ultimateProfile = source === 'schedule'
          ? 'active_ultimate_apm/ultimate_apm'
          : source === 'myaccount'
            ? 'active_ultimate_upfront/ultimate_upfront'
            : undefined;
        return { source, profile: ultimateProfile && profiles.includes(ultimateProfile) ? ultimateProfile : profiles[index % profiles.length] };
      });
    }
    break;
  }
  case 'android-full-new': matrix = assignAndroidDevices(androidNewSources.flatMap(source => standardPlans.map(plan => ({ source, plan })))); break;
  case 'android-full-signin': matrix = assignAndroidDevices(androidNewSources.flatMap(source => androidProfiles.map(profile => ({ source, profile })))); break;
  case 'android-full-signed': matrix = assignAndroidDevices(androidExistingSources.flatMap(source => androidProfiles.map(profile => ({ source, profile })))); break;
  case 'android-sanity-new': matrix = assignAndroidDevices(androidNewSources.map((source, index) => ({ source, plan: standardPlans[index % standardPlans.length] }))); break;
  case 'android-sanity-signin': matrix = assignAndroidDevices(androidNewSources.map((source, index) => ({ source, profile: androidProfiles[index % androidProfiles.length] }))); break;
  case 'android-sanity-signed': matrix = assignAndroidDevices(androidExistingSources.map((source, index) => ({ source, profile: androidProfiles[(index + 3) % androidProfiles.length] }))); break;
  case 'ios-full-new': matrix = assignIosDevices(iosNewSources.flatMap(source => standardPlans.map(plan => ({ source, plan })))); break;
  case 'ios-full-signin': matrix = assignIosDevices(iosNewSources.flatMap(source => iosProfiles.map(profile => ({ source, profile })))); break;
  case 'ios-full-signed': matrix = assignIosDevices(iosExistingSources.flatMap(source => iosProfiles.map(profile => ({ source, profile })))); break;
  case 'ios-sanity-new': matrix = assignIosDevices(iosNewSources.map((source, index) => ({ source, plan: standardPlans[index % standardPlans.length] }))); break;
  case 'ios-sanity-signin': matrix = assignIosDevices(iosNewSources.map((source, index) => ({ source, profile: iosProfiles[index % iosProfiles.length] }))); break;
  case 'ios-sanity-signed': matrix = assignIosDevices(iosExistingSources.map((source, index) => ({ source, profile: iosProfiles[(index + 3) % iosProfiles.length] }))); break;
  case 'default-new':
    matrix = ['boxing-standard-subscription', 'home-page-get-started', 'home-page-dazntile'].flatMap((source) => standardPlans.map((plan) => ({ source, plan })));
    matrix.push({ source: 'subscribe-without-pay-per-view', plan: 'standard_monthly' });
    break;
  case 'default-signin': {
    const signinFreemiumFrozen = regularProfiles.filter((p) => !isActiveSubscribed(p));
    matrix = ['boxing-standard-subscription', 'home-page-get-started', 'home-page-dazntile'].flatMap((source) =>
      standardPlans.flatMap((plan, pi) => {
        const i = pi * 2;
        const p0 = regularProfiles[i % regularProfiles.length];
        const p1 = regularProfiles[(i + 1) % regularProfiles.length];
        return [{ source, profile: p0 }, { source, profile: p1 }];
      })
    );
    // myaccount-subscription-status: freemium/frozen only for sign-in-during-flow
    standardPlans.forEach((plan, pi) => {
      matrix.push({ source: 'myaccount-subscription-status', profile: signinFreemiumFrozen[pi % signinFreemiumFrozen.length], scenario: 'resubscribe' });
    });
    matrix.push({ source: 'subscribe-without-pay-per-view', profile: 'freemium/standard_monthly' });
    break;
  }
  case 'default-signed': {
    const signedFreemiumFrozen = regularProfiles.filter((p) => !isActiveSubscribed(p));
    const signedFreemiumOnly = regularProfiles.filter((p) => p.startsWith('freemium/'));
    matrix = [
      ...standardPlans.flatMap((plan) => [
        { source: 'boxing-standard-subscription', profile: `freemium/${plan}` },
        { source: 'boxing-standard-subscription', profile: `frozen/${plan}` },
      ]),
      // home-page-dazntile: freemium/frozen only
      ...standardPlans.flatMap((plan, pi) => {
        const i = pi * 2;
        const p0 = signedFreemiumFrozen[i % signedFreemiumFrozen.length];
        const p1 = signedFreemiumFrozen[(i + 1) % signedFreemiumFrozen.length];
        return [{ source: 'home-page-dazntile', profile: p0 }, { source: 'home-page-dazntile', profile: p1 }];
      }),
      // home-page-subscribe: freemium only
      ...standardPlans.map((plan, pi) => ({ source: 'home-page-subscribe', profile: signedFreemiumOnly[pi % signedFreemiumOnly.length] })),
      ...standardPlans.map((plan, pi) => ({ source: 'myaccount', profile: `${pi % 2 === 0 ? 'freemium' : 'frozen'}/${plan}`, scenario: 'upgrade' })),
      // myaccount-subscription-status: freemium/frozen only
      ...standardPlans.map((plan, pi) => ({ source: 'myaccount-subscription-status', profile: signedFreemiumFrozen[pi % signedFreemiumFrozen.length], scenario: 'resubscribe' })),
      { source: 'subscribe-without-pay-per-view', profile: 'freemium/standard_monthly' },
    ];
    break;
  }
  case 'removal-new': {
    const sources = applicable(liveSources.new, false).filter((source) => !removalExcludedSources.has(source));
    matrix = sources.map((source) => {
      const plans = standardPlans.filter((plan) => !ultimateOnly.has(source) || plan.startsWith('ultimate_'));
      if (plans.length === 0) {
        throw new Error(`No Ultimate plan is configured for removal source "${source}" in ${country}.`);
      }
      return { source, plan: plans[0] };
    });
    break;
  }
  case 'removal-signed': {
    const sources = applicable(liveSources.signed, false).filter((source) => !removalExcludedSources.has(source));
    matrix = sources.map((source) => {
      const profiles = regularProfiles.filter((profile) => !ultimateOnly.has(source) || validUltimateProfiles.has(profile));
      if (profiles.length === 0) {
        throw new Error(`No Ultimate-compatible profile is configured for removal source "${source}" in ${country}.`);
      }
      return { source, profile: profiles[0] };
    });
    break;
  }
  default: throw new Error(`Unsupported matrix mode: ${mode}`);
}

if (isStandalonePPV) {
  const standalonePurchasePlan = country === 'CA'
    ? (canadaPlans.includes('standard-dazn-annual-pay over time')
      ? 'standard-dazn-annual-pay over time'
      : canadaPlans[0])
    : (standardPlans.includes('standard_apm') ? 'standard_apm' : 'standard_monthly');

  matrix = matrix.flatMap((entry) => {
    if (!entry.profile) return [entry];

    const [userState, purchasePlan] = entry.profile.split('/');
    const isUltimatePurchasePlan =
      purchasePlan.startsWith('ultimate_') ||
      purchasePlan.startsWith('ultimate-');
    if (!isUltimatePurchasePlan) return [entry];

    // Active Ultimate accounts can buy standalone PPV, but the standalone
    // selector itself only supports Standard purchase plans.
    if (userState.startsWith('active_ultimate_')) {
      return [{ ...entry, profile: `${userState}/${standalonePurchasePlan}` }];
    }

    return [];
  });
}

// Keep every matrix mode consistent, including explicitly-added switch jobs.
// New-user jobs use `plan`; authenticated jobs encode the destination plan in
// the last segment of `profile` (for example, freemium/standard_apm).
// For CA, canadaPlans are already in the correct format and are validated directly.
matrix = matrix.filter((entry) => {
  const plan = entry.plan || entry.profile?.split('/').pop();
  if (country === 'CA' && canadaPlans) return canadaPlans.includes(plan);
  return standardPlans.includes(plan);
});

if (country === 'SA') {
  const existingModes = [
    'live-existing',
    'live-signed',
    'web-sanity-signin',
    'web-sanity-signed',
    'android-full-signin',
    'android-full-signed',
    'android-sanity-signin',
    'android-sanity-signed',
    'ios-full-signin',
    'ios-full-signed',
    'ios-sanity-signin',
    'ios-sanity-signed'
  ];
  if (existingModes.includes(mode)) {
    matrix = [];
  }
}

if (mode.startsWith('default-') && !defaultSignupDevMode && !hasDefaultSignup) {
  throw new Error(`${configName} does not enable default signup (set DEFAULT_SIGNUP_DEVMODE or HAS_DEFAULT_SIGNUP_PPV to true).`);
}
console.log(`Validated ${configName} for ${country}; ${matrix.length} ${mode} jobs.`);
withOutput('matrix', matrix);
if (mode.startsWith('default-')) fs.appendFileSync(process.env.GITHUB_OUTPUT, `dev_mode_on=${defaultSignupDevMode ? 'on' : 'off'}\n`);
