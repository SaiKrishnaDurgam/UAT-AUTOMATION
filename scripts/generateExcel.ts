import * as XLSX from 'xlsx';
import * as path from 'path';
import * as fs from 'fs';

const outputPath = path.resolve(process.cwd(), 'data', 'PPV_Input.xlsx');

// ═══════════════════════════════════════════════════════════
// SHEET 1: Landing page
// ═══════════════════════════════════════════════════════════
const landingData = [
  { Field: 'Don\'t Miss Live on DAZN Section', Expected: 'Yes', Flow: 'landing' },
  { Field: 'PPV Tile Present', Expected: 'Yes', Flow: 'landing' },
  { Field: 'PPV Name', Expected: '{{PPV_FULL_NAME}}', Flow: 'landing' },
  { Field: 'Landing Page PPV Date', Expected: '{{LANDING_PAGE_PPV_DATE}}', Flow: 'landing' },
  { Field: 'Buy Now Button', Expected: 'Buy now', Flow: 'landing' },
  // ── Landing Page Banner validations ───────────────────────
  { Field: 'Banner Image Present', Expected: 'Yes', Flow: 'landing-page-banner' },
  { Field: 'Banner - Event Title', Expected: '{{MOBILE_BANNER_TITLE}}', Flow: 'landing-page-banner' },
  { Field: 'Banner - Buy Now CTA', Expected: 'Buy now', Flow: 'landing-page-banner' },
  { Field: 'Banner - Event Description', Expected: '{{MOBILE_BANNER_DESCRIPTION}}', Flow: 'landing-page-banner' },
  { Field: 'Banner - Event Date', Expected: '{{MOBILE_BANNER_DATE_TIME}}', Flow: 'landing-page-banner' },
  { Field: 'Copy Description', Expected: 'Copy the link below and paste it in your browser. We\'ll take you back to the app when you finish.', Flow: 'landing-page-banner' },
  { Field: 'Copy URL', Expected: 'https://dazn-direct-subscription-prod.s3.eu-', Flow: 'landing-page-banner' },
  { Field: 'Copy Button', Expected: 'Copy', Flow: 'landing-page-banner' },
];

const boxingLandingData = [
  { Field: 'Boxing Banner Present', Expected: 'Yes', Flow: 'boxing' },
  { Field: 'Boxing Banner Date', Expected: '{{BOXING_BANNER_DATE}}', Flow: 'boxing' },
  { Field: 'Event Name', Expected: '{{PPV_NAME}}', Flow: 'boxing' },
  { Field: 'Event Subtitle', Expected: '{{BOXING_BANNER_SUBTITLE}}', Flow: 'boxing' },
  { Field: 'Or Separator', Expected: 'or', Flow: 'boxing' },
  { Field: 'Buy Fight CTA', Expected: 'Buy this fight for {{PPV_PRICE}}', Flow: 'boxing' },
  { Field: 'Get Included CTA', Expected: 'Get included in DAZN Ultimate', Flow: 'boxing' },
  { Field: 'Best Value Badge', Expected: 'Best value for boxing fans', Flow: 'boxing' },
  { Field: 'Upcoming Big Fights Heading', Expected: 'Upcoming Big Fights', Flow: 'boxing-upcoming' },
  { Field: 'PPV Name', Expected: '{{PPV_DISPLAY_NAME}}', Flow: 'boxing-upcoming' },
  { Field: 'PPV Date and Time Text', Expected: '{{PPV_DATE}}', Flow: 'boxing-upcoming' },
  { Field: 'PPV Description Text', Expected: '{{PPV_LOCATION}}', Flow: 'boxing-upcoming' },
  { Field: 'PPV Image Present', Expected: 'Yes', Flow: 'boxing-upcoming' },
  { Field: 'Buy Now CTA', Expected: 'Buy now', Flow: 'boxing-upcoming' },
  // ── Bundle section on /boxing page ───────────────────────
  { Field: 'Bundle Section Present', Expected: 'Yes', Flow: 'boxing-bundle' },
  { Field: 'Bundle Section Title', Expected: '{{BUNDLE_SECTION_TITLE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Section Subtitle', Expected: '{{BUNDLE_SECTION_SUBTITLE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Title', Expected: '{{BUNDLE_NAME}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Description', Expected: '{{BUNDLE_DESCRIPTION}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Price', Expected: '{{BUNDLE_PRICE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Original Price', Expected: '{{BUNDLE_ORIGINAL_PRICE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Save Badge', Expected: '{{BUNDLE_SAVE_BADGE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle Fight Count', Expected: '{{BUNDLE_FIGHT_COUNT}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle PPV 1 Name', Expected: '{{BUNDLE_PPV1_NAME}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle PPV 1 Date', Expected: '{{BUNDLE_PPV1_LANDING_DATE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle PPV 1 Image', Expected: 'Yes', Flow: 'boxing-bundle' },
  { Field: 'Bundle PPV 2 Name', Expected: '{{BUNDLE_PPV2_NAME}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle PPV 2 Date', Expected: '{{BUNDLE_PPV2_LANDING_DATE}}', Flow: 'boxing-bundle' },
  { Field: 'Bundle PPV 2 Image', Expected: 'Yes', Flow: 'boxing-bundle' },
  { Field: 'Get Started CTA', Expected: 'Get Started', Flow: 'boxing-bundle' },
  // ── Bundle PPV page validations ─────────────────────────
  { Field: 'Page Title', Expected: 'Choose the right plan for you.', Flow: 'boxing-bundle-ppv' },
  { Field: 'Header Sub Text', Expected: 'To watch your pay-per-view, you\'ll need a DAZN plan.', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle Card Title', Expected: '{{BUNDLE_NAME}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle Card Description', Expected: '{{BUNDLE_PPV_CARD_DESCRIPTION}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle Card Selected', Expected: 'Yes', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle Card Price', Expected: '{{BUNDLE_PRICE}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle Card Original Price', Expected: '{{BUNDLE_ORIGINAL_PRICE}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle Card Save Badge', Expected: '{{BUNDLE_SAVE_BADGE}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle PPV 1 Full Name', Expected: '{{BUNDLE_PPV1_FULL_NAME}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle PPV 1 PPV Date', Expected: '{{BUNDLE_PPV1_DATE}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle PPV 1 PPV Image', Expected: 'Yes', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle PPV 2 Full Name', Expected: '{{BUNDLE_PPV2_FULL_NAME}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle PPV 2 PPV Date', Expected: '{{BUNDLE_PPV2_DATE}}', Flow: 'boxing-bundle-ppv' },
  { Field: 'Bundle PPV 2 PPV Image', Expected: 'Yes', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Section Present', Expected: 'Yes', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Badge', Expected: 'The Ultimate Fan Package', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Plan Name', Expected: 'DAZN Ultimate', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}/month', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Contract Text', Expected: 'Annual contract. Auto renews.', Flow: 'boxing-bundle-ppv' },
  { Field: 'Fights Included Text', Expected: 'All these fights included and more.', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Feature 1', Expected: 'Minimum 12 pay-per-views a year included at no extra cost.', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Feature 2', Expected: '185+ fights a year from the world\'s best promoters.', Flow: 'boxing-bundle-ppv' },
  { Field: 'Upsell Feature 3', Expected: 'HDR and Dolby 5.1 surround sound on select events', Flow: 'boxing-bundle-ppv' },
  { Field: 'CTA Button', Expected: 'Continue with DAZN Ultimate', Flow: 'boxing-bundle-ppv' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 2: PPV page
// ═══════════════════════════════════════════════════════════
const ppvData = [
  // ── variant1 ─────────────────────────────────────────────

  { Variant: 'variant1', Field: 'Page Title', Expected: 'Choose the right plan for you.', Flow: '' },
  { Variant: 'variant1', Field: 'Header Sub Text', Expected: 'To watch your pay-per-view, you\'ll need a DAZN plan.', Flow: '' },
  { Variant: 'variant1', Field: 'Header Highlight Text2', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Event Name', Expected: '{{PPV_DISPLAY_NAME}}', Flow: '' },
  { Variant: 'variant1', Field: 'PPV Per Fight Text', Expected: '/fight', Flow: '' },
  { Variant: 'variant1', Field: 'PPV Price', Expected: '{{PPV_PRICE}}', Flow: '' },
  { Variant: 'variant1', Field: 'Currency', Expected: '{{CURRENCY}}', Flow: '' },
  { Variant: 'variant1', Field: 'DAZN Tier', Expected: '+DAZN Standard', Flow: 'newuser' },
  { Variant: 'variant1', Field: 'PPV Name', Expected: '{{PPV_NAME}}', Flow: '' },
  { Variant: 'variant1', Field: 'PPV Image Present', Expected: 'Yes', Flow: '' },
  { Variant: 'variant1', Field: 'PPV Date and Time Text', Expected: '{{PPV_DATE}}', Flow: '' },
  { Variant: 'variant1', Field: 'Radio Selected', Expected: 'Yes', Flow: '' },
  { Variant: 'variant1', Field: 'PPV Card Title', Expected: '{{PPV_DISPLAY_NAME}}', Flow: '' },
  { Variant: 'variant1', Field: 'PPV Card Description', Expected: '{{PPV_CARD_DESCRIPTION}}', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Section Present', Expected: 'Yes', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Badge', Expected: 'The Ultimate Fan Package', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Plan Name', Expected: 'DAZN Ultimate', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Price Text', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Price', Expected: '{{UPSELL_PRICE}}', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Price Length', Expected: '{{UPSELL_PRICE_LENGTH}}', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Crossed Price', Expected: '{{UPSELL_CROSSED_PRICE}}', Flow: '' },

  { Variant: 'variant1', Field: 'Upsell Billing Text', Expected: '{{ANNUAL_PAY_MONTHLY_CONTRACT_TEXT}}', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Offer Text', Expected: '{{UPSELL_OFFER_TEXT}}', Flow: 'offer' },
  { Variant: 'variant1', Field: 'Upsell Section Heading', Expected: '{{UPSELL_SECTION_HEADING}}', Flow: '' },

  { Variant: 'variant1', Field: 'PPV1 Included tag', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Included PPV2 Name', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'PPV2 Image Present on ultimate tier', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'PPV2 Date Text on ultimate tier', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'PPV2 Included tag', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Feature 1', Expected: '{{UPSELL_FEATURE_1}}', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Highlight Text', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Feature 2', Expected: '{{UPSELL_FEATURE_2}}', Flow: '' },
  { Variant: 'variant1', Field: 'Upsell Feature 3', Expected: '{{UPSELL_FEATURE_3}}', Flow: '' },
  { Variant: 'variant1', Field: 'Whats Included CTA', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Gold Highlight 1', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Gold Highlight 2', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Gold Highlight 3', Expected: 'N/A', Flow: '' },
  { Variant: 'variant1', Field: 'Bundle Name', Expected: '{{BUNDLE_NAME}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle Description', Expected: '{{BUNDLE_DESCRIPTION}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle Monthly Price', Expected: '{{BUNDLE_MONTHLY_PRICE}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle Price', Expected: '{{BUNDLE_PRICE}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle Original Price', Expected: '{{BUNDLE_ORIGINAL_PRICE}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle Fight Count', Expected: '{{BUNDLE_FIGHT_COUNT}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle Save Badge', Expected: '{{BUNDLE_SAVE_BADGE}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle PPV 1 Full Name', Expected: '{{BUNDLE_PPV1_FULL_NAME}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle PPV 1 Date', Expected: '{{BUNDLE_PPV1_DATE}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle PPV 1 Image', Expected: 'Yes', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle PPV 2 Full Name', Expected: '{{BUNDLE_PPV2_FULL_NAME}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle PPV 2 Date', Expected: '{{BUNDLE_PPV2_DATE}}', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'Bundle PPV 2 Image', Expected: 'Yes', Flow: 'bundle' },
  { Variant: 'variant1', Field: 'CTA Button', Expected: '{{PPV_CTA_TEXT}}', Flow: '' },
  { Variant: 'variant1', Field: 'CTA Without PPV', Expected: 'Subscribe without a pay-per-view', Flow: 'newuser' },

  // ── variant2 ─────────────────────────────────────────────

  { Variant: 'variant2', Field: 'Page Title', Expected: 'Choose your plan', Flow: '' },
  { Variant: 'variant2', Field: 'Header Full Copy', Expected: 'Buy {{PPV_NAME}} with DAZN Standard or get it included in DAZN Ultimate.', Flow: '' },
  { Variant: 'variant2', Field: 'Header Highlight Text2', Expected: 'get it included in DAZN Ultimate.', Flow: '' },
  { Variant: 'variant2', Field: 'PPV Image', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'Event Date and Time', Expected: '{{PPV_DATE}}', Flow: '' },
  { Variant: 'variant2', Field: 'Event Name', Expected: '{{PPV_DISPLAY_NAME}}', Flow: '' },
  { Variant: 'variant2', Field: 'PPV Checkbox Present', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'PPV Selected', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'PPV Name', Expected: '{{PPV_DISPLAY_NAME}}', Flow: '' },
  { Variant: 'variant2', Field: 'PPV Per Fight Text', Expected: '/fight', Flow: '' },
  { Variant: 'variant2', Field: 'PPV Price', Expected: '{{PPV_PRICE}}', Flow: '' },
  { Variant: 'variant2', Field: 'Currency', Expected: '{{CURRENCY}}', Flow: '' },
  { Variant: 'variant2', Field: 'Subscription Section Title', Expected: 'Choose your subscription', Flow: '' },
  { Variant: 'variant2', Field: 'Trial Card Present', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'Trial Title', Expected: '7-day free trial of DAZN Standard', Flow: '' },
  { Variant: 'variant2', Field: 'Trial Radio Present', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'Trial Selected', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'Trial Feature 1', Expected: '7-days free access to DAZN Standard.', Flow: '' },
  { Variant: 'variant2', Field: 'Trial Feature 2', Expected: 'Cancel anytime during the trial and only pay for the fight. After the trial you move onto a Monthly Flex plan for {{CURRENCY}}{{MONTHLY_PRICE}}/month. You will not lose access to the pay-per-view[s].', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Section Present', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Label', Expected: 'Pay-per-views included', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Plan Name', Expected: 'DAZN Ultimate', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Price Text', Expected: 'From', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Price', Expected: '{{UPSELL_PRICE}}', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Price Length', Expected: '{{UPSELL_PRICE_LENGTH}}', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Billing Text', Expected: 'Annual contract. Auto renews.', Flow: '' },

  { Variant: 'variant2', Field: 'PPV1 Included tag', Expected: 'Yes', Flow: '' },
  { Variant: 'variant2', Field: 'Included PPV2 Name', Expected: 'N/A', Flow: '' },
  { Variant: 'variant2', Field: 'PPV2 Image Present on ultimate tier', Expected: 'N/A', Flow: '' },
  { Variant: 'variant2', Field: 'PPV2 Date Text on ultimate tier', Expected: 'N/A', Flow: '' },
  { Variant: 'variant2', Field: 'PPV2 Included tag', Expected: 'N/A', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Feature 1', Expected: 'Pay-per-views included at no extra cost. Minimum of 12 events per year including {{PPV_NAME}}.', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Highlight Text', Expected: '{{PPV_NAME}}.', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Feature 2', Expected: 'HDR and Dolby 5.1 surround sound on select events.', Flow: '' },
  { Variant: 'variant2', Field: 'Upsell Feature 3', Expected: '185+ fights a year from the world\'s best promoters.', Flow: '' },
  { Variant: 'variant2', Field: 'Whats Included CTA', Expected: 'Whats included', Flow: '' },
  { Variant: 'variant2', Field: 'Gold Highlight 1', Expected: '{{PPV_NAME}}', Flow: '' },
  { Variant: 'variant2', Field: 'Gold Highlight 2', Expected: 'get it included in DAZN Ultimate.', Flow: '' },
  { Variant: 'variant2', Field: 'Gold Highlight 3', Expected: 'DAZN Ultimate', Flow: '' },
  { Variant: 'variant2', Field: 'CTA Button', Expected: 'Continue with PPV + 7-day free trial', Flow: '' },
  { Variant: 'variant2', Field: 'CTA Without PPV', Expected: 'N/A', Flow: '' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 3: Dazn Plan page
// Supports both "7 day trial" and "1 month free" offer types
// ═══════════════════════════════════════════════════════════
const planData = [
  // ── Standard ─────────────────────────────────────────────

  { Tier: 'Standard', Field: 'Page Title', Expected: '{{PLAN_PAGE_TITLE}}', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Card Present', Expected: 'Yes', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Title', Expected: 'Flex – Pay Monthly', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Badge', Expected: '{{FLEX_BADGE}}', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Description', Expected: '{{FLEX_DESCRIPTION}}', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Selected', Expected: 'Yes', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Today Text', Expected: '{{FLEX_TODAY_TEXT}}', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Future Date', Expected: '{{FLEX_FUTURE_DATE}}', Flow: '' },
  { Tier: 'Standard', Field: 'Flex Future Text', Expected: '{{FLEX_FUTURE_TEXT}}', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Card Present', Expected: 'Yes', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Savings Badge', Expected: '{{ANNUAL_SAVINGS_BADGE}}', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Title', Expected: 'Annual - Pay Monthly', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Badge', Expected: '1 MONTH FREE', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Price Text', Expected: 'then {{CURRENCY}}{{ANNUAL_PRICE}}/month for {{ANNUAL_MONTHS}} months', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Contract Text', Expected: 'Annual contract. Auto renews.', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Feature 1', Expected: '185+ fights a year from the world\'s best promoters.', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Feature 2', Expected: 'Additional cost for pay-per-view events.', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Feature 3', Expected: 'Full HD video resolution.', Flow: '' },
  { Tier: 'Standard', Field: 'Annual Selected', Expected: 'No', Flow: '' },
  { Tier: 'Standard', Field: 'CTA Button', Expected: '{{PLAN_CTA_BUTTON}}', Flow: '' },

  // ── Ultimate ─────────────────────────────────────────────

  { Tier: 'Ultimate', Field: 'Page Title', Expected: '{{PLAN_PAGE_TITLE}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Ultimate Card Present', Expected: 'Yes', Flow: 'boxing-ultimate-direct' },
  { Tier: 'Ultimate', Field: 'Ultimate Badge', Expected: 'The Ultimate Fan Package', Flow: 'boxing-ultimate-direct' },
  { Tier: 'Ultimate', Field: 'Ultimate Plan Name', Expected: 'DAZN Ultimate', Flow: 'boxing-ultimate-direct' },
  { Tier: 'Ultimate', Field: 'Ultimate Package Description', Expected: 'All these fights and more this year. One unbeatable price.', Flow: 'boxing-ultimate-direct' },
  { Tier: 'Ultimate', Field: 'Ultimate Image Strip Present', Expected: 'Yes', Flow: 'boxing-ultimate-direct' },
  { Tier: 'Ultimate', Field: 'Annual Pay Monthly Option', Expected: 'Yes', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Monthly Title', Expected: 'Annual - Pay Monthly', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Monthly Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Monthly Price Length', Expected: '/month', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Monthly Contract Text', Expected: '{{ANNUAL_PAY_MONTHLY_CONTRACT_TEXT}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Monthly Selected', Expected: 'Yes', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Upfront Option', Expected: 'Yes', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Upfront Title', Expected: 'Annual - Pay Upfront', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Upfront Save Badge', Expected: 'Save {{CURRENCY}}{{UPFRONT_SAVE_AMOUNT}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Upfront Price', Expected: '{{ANNUAL_UPFRONT_PRICE_DISPLAY}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Upfront Price Length', Expected: '/year', Flow: '' },
  { Tier: 'Ultimate', Field: 'Annual Pay Upfront Selected', Expected: 'No', Flow: '' },
  { Tier: 'Ultimate', Field: 'Ultimate Feature 1', Expected: '{{ULTIMATE_FEATURE_1}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Ultimate Feature 2', Expected: '{{ULTIMATE_FEATURE_2}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Ultimate Feature 3', Expected: '{{ULTIMATE_FEATURE_3}}', Flow: '' },
  { Tier: 'Ultimate', Field: 'Select How To Pay Heading', Expected: 'Select how to pay', Flow: 'boxing-ultimate-direct' },
  { Tier: 'Ultimate', Field: 'CTA Button', Expected: '{{PLAN_CTA_BUTTON}}', Flow: '' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 4: Payment page
// Supports both "7 day trial" and "1 month free" offer types
// ═══════════════════════════════════════════════════════════
const paymentData = [
  // ── Common ───────────────────────────────────────────────
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Payment Method Heading', Expected: 'Payment method', Flow: '' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Purchase Summary Heading', Expected: 'Purchase summary', Flow: '' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Plan Change CTA', Expected: 'Change', Flow: '' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Credit & Debit Card Option', Expected: 'Yes', Flow: '' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'PayPal Option', Expected: 'Yes', Flow: '' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Google Pay Option', Expected: 'Yes', Flow: '' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Saved Card Present', Expected: 'Yes', Flow: 'myaccount' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Signed In As Text', Expected: 'Signed in as {{FIRST_NAME}} {{LAST_NAME}}', Flow: 'returning' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Log Out Present', Expected: 'Yes', Flow: 'returning' },
  { Tier: 'Common', 'Rate Plan': 'All', Field: 'Redeem Promo Code CTA', Expected: 'Yes', Flow: '' },

  // ── Standard + Monthly ───────────────────────────────────
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Page Title', Expected: '{{PAYMENT_PAGE_TITLE}}', Flow: 'newuser' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Page Title', Expected: '{{PAYMENT_PAGE_TITLE}}', Flow: 'myaccount' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'DAZN Tier', Expected: 'DAZN Standard', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Plan Name', Expected: '{{PAYMENT_PLAN_NAME}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Plan Subtitle', Expected: '{{PAYMENT_FLEX_CANCEL_NOTICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'First Month Free Price', Expected: '{{CURRENCY}}0', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'First Month Free Text', Expected: '{{PAYMENT_FREE_TEXT}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'PPV Name', Expected: '{{PPV_NAME}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'PPV Price', Expected: '{{PPV_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Today You Pay Text', Expected: 'Today you pay', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Today You Pay Price', Expected: '{{TODAY_YOU_PAY_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Legal Text', Expected: '{{PAYMENT_FLEX_LEGAL_TEXT}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly', Field: 'Ultimate Upsell Text', Expected: 'Switch to DAZN Ultimate and enjoy pay-per-views at no extra cost – {{UPSELL_PRICE}}/month|Switch to DAZN Ultimate and enjoy pay-per-views at no extra cost|N/A', Flow: '' },

  // ── Standard + Annual Pay Monthly ────────────────────────
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Page Title', Expected: 'Choose how to pay', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'DAZN Tier', Expected: 'DAZN Standard', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'PPV Name', Expected: '{{PPV_NAME}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'PPV Price', Expected: '{{PPV_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Rate Plan', Expected: '{{RATE_PLAN_LABEL}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Rate Plan Original Price', Expected: '{{CURRENCY}}{{ANNUAL_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Rate Plan Discounted Price', Expected: '{{CURRENCY}}0', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Today You Pay Text', Expected: 'Today you pay', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Today You Pay Price', Expected: '{{TODAY_YOU_PAY_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT_ANNUAL}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Redeem Promo Code CTA', Expected: 'Yes', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly', Field: 'Ultimate Upsell Text', Expected: 'Switch to DAZN Ultimate and enjoy pay-per-views at no extra cost – {{UPSELL_PRICE}}/month|Switch to DAZN Ultimate and enjoy pay-per-views at no extra cost|N/A', Flow: '' },

  // ── Ultimate + Annual Pay Monthly ────────────────────────
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Page Title', Expected: 'Choose how to pay', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'DAZN Tier', Expected: 'DAZN Ultimate', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'PPV Name', Expected: '{{PPV_NAME}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'PPV Price', Expected: '{{CURRENCY}}0', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Rate Plan', Expected: 'Annual - Pay Monthly', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Rate Plan Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}/month', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Plan Subtitle', Expected: 'Billed monthly. 12-month contract.', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Today You Pay Text', Expected: 'Today you pay', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Today You Pay Price', Expected: '{{TODAY_YOU_PAY_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Next Payment Label', Expected: 'Next payment on {{NEXT_PAYMENT_DATE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Next Payment Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Redeem Promo Code CTA', Expected: 'Yes', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly', Field: 'Discount Badge', Expected: '{{DISCOUNT_BADGE}}', Flow: '' },

  // ── Ultimate + Annual Pay Upfront ────────────────────────
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Page Title', Expected: 'Choose how to pay', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'DAZN Tier', Expected: 'DAZN Ultimate', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'PPV Name', Expected: '{{PPV_NAME}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'PPV Price', Expected: '{{CURRENCY}}0', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Rate Plan', Expected: 'Annual - Pay Upfront', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Rate Plan Price', Expected: '{{ANNUAL_UPFRONT_PRICE}}/year', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Plan Subtitle', Expected: 'Save {{CURRENCY}}{{UPFRONT_SAVE_AMOUNT}}. Pay for the full year up front|Save {{CURRENCY}}{{UPFRONT_SAVE_AMOUNT}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Today You Pay Text', Expected: 'Today you pay', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Today You Pay Price', Expected: '{{TODAY_YOU_PAY_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Next Payment Label', Expected: 'Next Annual payment on {{NEXT_PAYMENT_DATE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Next Payment Price', Expected: '{{ANNUAL_UPFRONT_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront', Field: 'Redeem Promo Code CTA', Expected: 'Yes', Flow: '' },

  // ── Standard + Monthly Bundle ────────────────────────────
  { Tier: 'Standard', 'Rate Plan': 'Monthly Bundle', Field: 'Page Title', Expected: '{{PAYMENT_PAGE_TITLE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly Bundle', Field: 'DAZN Tier', Expected: 'DAZN Standard', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly Bundle', Field: 'Bundle Name', Expected: '{{BUNDLE_NAME}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly Bundle', Field: 'Bundle Price', Expected: '{{BUNDLE_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly Bundle', Field: 'Today You Pay Price', Expected: '{{BUNDLE_TODAY_YOU_PAY_STANDARD}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Monthly Bundle', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT}}', Flow: '' },

  // ── Standard + Annual Pay Monthly Bundle ──────────────────
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Page Title', Expected: 'Choose how to pay', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'DAZN Tier', Expected: 'DAZN Standard', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Rate Plan', Expected: 'Annual - Pay Monthly', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'First Month Free Text', Expected: 'First month free', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Bundle Name', Expected: '{{BUNDLE_NAME}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Bundle Original Price', Expected: '{{BUNDLE_ORIGINAL_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Bundle Price', Expected: '{{BUNDLE_PRICE}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Bundle Discount', Expected: '{{BUNDLE_DISCOUNT}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Today You Pay Price', Expected: '{{BUNDLE_TODAY_YOU_PAY_STANDARD}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT_ANNUAL}}', Flow: '' },
  { Tier: 'Standard', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Ultimate Upsell Text', Expected: 'Switch to DAZN Ultimate and enjoy pay-per-views at no extra cost – {{UPSELL_PRICE}}/month|Switch to DAZN Ultimate and enjoy pay-per-views at no extra cost|N/A', Flow: '' },

  // ── Ultimate + Annual Pay Monthly Bundle ──────────────────
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Page Title', Expected: 'Choose how to pay', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'DAZN Tier', Expected: 'DAZN Ultimate', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Rate Plan', Expected: 'Annual - Pay Monthly', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Rate Plan Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}/month', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Bundle Name', Expected: '{{BUNDLE_NAME}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Bundle Price', Expected: '{{CURRENCY}}0', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Today You Pay Price', Expected: '{{TODAY_YOU_PAY_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Next Payment Label', Expected: 'Next payment on {{NEXT_PAYMENT_DATE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Next Payment Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Monthly Bundle', Field: 'Discount Badge', Expected: '{{DISCOUNT_BADGE}}', Flow: '' },

  // ── Ultimate + Annual Pay Upfront Bundle ──────────────────
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Page Title', Expected: 'Choose how to pay', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'DAZN Tier', Expected: 'DAZN Ultimate', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Rate Plan', Expected: 'Annual - Pay Upfront', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Rate Plan Price', Expected: '{{ANNUAL_UPFRONT_PRICE}}/year', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Save Badge', Expected: 'Save {{CURRENCY}}{{UPFRONT_SAVE_AMOUNT}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Bundle Name', Expected: '{{BUNDLE_NAME}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Bundle Price', Expected: '{{CURRENCY}}0', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Today You Pay Price', Expected: '{{ANNUAL_UPFRONT_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Next Payment Label', Expected: 'Next Annual payment on {{NEXT_PAYMENT_DATE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Next Payment Price', Expected: '{{ANNUAL_UPFRONT_PRICE}}', Flow: '' },
  { Tier: 'Ultimate', 'Rate Plan': 'Annual Pay Upfront Bundle', Field: 'Cancellation Text', Expected: '{{CANCELLATION_TEXT}}', Flow: '' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 5: Schedule page
// ═══════════════════════════════════════════════════════════
const scheduleData = [
  // ── Tile fields (validated BEFORE popup opens) ──────────────────────────────
  { Field: 'PPV Tile Present', Expected: 'Yes' },
  { Field: 'PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'PPV Image Present', Expected: 'Yes' },
  { Field: 'Lock Icon Present', Expected: 'Yes' },
  { Field: 'PPV Promoter on Tile', Expected: '{{PPV_PROMOTER}}' },
  { Field: 'Day', Expected: '{{MOBILE_SCHEDULE_DAY}}' },
  { Field: 'Month', Expected: '{{MOBILE_SCHEDULE_MONTH}}' },
  { Field: 'Date', Expected: '{{MOBILE_SCHEDULE_DATE}}' },
  { Field: 'Time', Expected: '{{MOBILE_SCHEDULE_TIME}}' },
  { Field: 'Bell Icon Present', Expected: 'Yes' },
  { Field: 'Three Dots Icon Present', Expected: 'Yes' },
  { Field: 'Popup Image Present', Expected: 'Yes' },
  { Field: 'Popup Date', Expected: '{{PPV_DATE}}' },
  { Field: 'Popup PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'Popup Promoter', Expected: '{{PPV_PROMOTER}}' },
  { Field: 'Popup Description', Expected: 'Catch the biggest moment of the year. Select a DAZN plan to pair with your pay-per-view.' },
  { Field: 'Popup Buy Now CTA Present', Expected: 'Yes' },
  { Field: 'Popup Buy Now CTA Text', Expected: 'Buy now' },
  { Field: 'Popup Close Button', Expected: 'Yes' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 6: My Account page
// ═══════════════════════════════════════════════════════════
const myAccountData = [
  { Field: 'Current Subscription', Expected: '{{DAZN_TIER}}' },
  { Field: 'Subscription Status', Expected: '{{SUBSCRIPTION_STATUS}}' },
  { Field: 'PPV Section Present', Expected: 'Yes' },
  { Field: 'PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'PPV Date', Expected: '{{PPV_DATE}}' },
  { Field: 'PPV Price', Expected: '{{PPV_PRICE}}' },
  { Field: 'PPV Status', Expected: '{{PPV_STATUS}}' },
  { Field: 'PPV Image Present', Expected: 'Yes' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 7: Choose How To Buy page
// ═══════════════════════════════════════════════════════════
const chooseHowToBuyData = [
  { Field: 'Page Title', Expected: 'Choose how to buy|Choose your plan' },
  { Field: 'Header PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'Header Sub Text', Expected: 'Buy {{PPV_NAME}}, or get it included in a DAZN Ultimate subscription' },
  { Field: 'PPV Option Present', Expected: 'Yes' },
  { Field: 'PPV Option Selected', Expected: 'Yes' },
  { Field: 'PPV Option Price', Expected: '{{PPV_PRICE}}' },
  { Field: 'PPV Image Present', Expected: 'Yes' },
  { Field: 'PPV Date and Time', Expected: '{{PPV_DATE}}' },
  { Field: 'DAZN Ultimate Option Present', Expected: 'Yes' },
  { Field: 'DAZN Ultimate Price Text', Expected: 'From' },
  { Field: 'DAZN Ultimate Price', Expected: '{{UPSELL_PRICE}}' },
  { Field: 'DAZN Ultimate Price Length', Expected: '/ month' },
  { Field: 'DAZN Ultimate Billing Text', Expected: 'Annual contract. Auto renews.' },
  { Field: 'PPV Included Tag', Expected: 'Yes' },
  { Field: 'Upsell Label', Expected: 'N/A' },
  { Field: 'Upsell Plan Name', Expected: 'DAZN Ultimate' },
  { Field: 'Upsell Feature 1', Expected: '{{UPSELL_FEATURE_1}}' },
  { Field: 'Upsell Highlight Text', Expected: 'N/A' },
  { Field: 'Upsell Feature 2', Expected: '{{UPSELL_FEATURE_2}}' },
  { Field: 'Upsell Feature 3', Expected: '{{UPSELL_FEATURE_3}}' },
  { Field: 'Upsell Feature 4', Expected: '{{UPSELL_FEATURE_4}}' },
  { Field: 'Whats Included CTA', Expected: 'Whats included' },
  { Field: 'CTA Button', Expected: '{{PPV_CTA_TEXT}}' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 8: PPV Payment page
// ═══════════════════════════════════════════════════════════
const ppvPaymentData = [
  { Field: 'Skip CTA', Expected: 'Yes' },
  { Field: 'PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'PPV Description', Expected: 'Yes' },
  { Field: 'PPV Image Present', Expected: 'Yes' },
  { Field: 'PPV Date and Time', Expected: '{{PPV_DATE}}' },
  { Field: 'Order Summary PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'Today You Pay Text', Expected: 'Today you pay' },
  { Field: 'Today You Pay Price', Expected: '{{TODAY_YOU_PAY_PRICE}}' },
  { Field: 'Payment Method Present', Expected: 'Yes' },
  { Field: 'Pay Now Button', Expected: 'Yes' },
  { Field: 'Secure Checkout', Expected: 'Yes' },
  { Field: 'More Payment Methods', Expected: 'Yes' },
  { Field: 'Legal Text Present', Expected: 'Yes' },
  { Field: 'Terms Link Present', Expected: 'Yes' },
  { Field: 'Privacy Policy Link Present', Expected: 'Yes' },
  { Field: 'Payment Type', Expected: 'One time payment' },
  { Field: 'Payment Instruction Text', Expected: 'In order to purchase this event, please choose from the payment options below' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 9: Upgrade Confirmation page
// ═══════════════════════════════════════════════════════════
const upgradeConfirmationData = [
  { Tier: 'common', Field: 'Page Title', Expected: 'DAZN Ultimate' },
  { Tier: 'common', Field: 'Page Description', Expected: 'All the action in one subscription. 12 pay-per-view fights a year with the ultimate viewing experience, plus football, basketball and more.' },
  { Tier: 'common', Field: 'Terms And Conditions Text', Expected: "By changing the terms of your subscription, you confirm that you have read and agree to our Terms and Conditions of Use (including the instruction regarding your right of withdrawal). Your subscription auto-renews unless you cancel before the end of the minimum term by selecting 'Cancel Subscription' in My Account." },
  { Tier: 'common', Field: 'Payment Method Present', Expected: 'Yes' },
  { Tier: 'common', Field: 'Confirm Button', Expected: 'Confirm' },
  { Tier: 'common', Field: 'Terms Link Present', Expected: 'Yes' },
  { Tier: 'annual pay upfront', Field: 'Legal Text Line 1', Expected: 'Your plan will be changed to DAZN Ultimate today {{TODAY_DATE}} and your contract will last 12 months.' },
  { Tier: 'annual pay upfront', Field: 'Legal Text Line 2', Expected: 'Today you will be charged {{CURRENCY}}{{ANNUAL_UPFRONT_PRICE}} minus the remainder of your last payment which was not used in full. From {{NEXT_PAYMENT_DATE}} you will be charged {{CURRENCY}}{{ANNUAL_UPFRONT_PRICE}}/year.' },
  { Tier: 'annual pay upfront', Field: 'Rate Plan', Expected: 'Annual - Pay Upfront' },
  { Tier: 'annual pay upfront', Field: 'Rate Plan Price', Expected: '{{ANNUAL_UPFRONT_PRICE}}' },
  { Tier: 'annual pay upfront', Field: 'Rate Plan Period', Expected: '/year' },
  { Tier: 'annual pay upfront', Field: 'Rate Plan Description', Expected: 'Get the best value when you pay upfront.' },
  { Tier: 'annual pay upfront', Field: 'Next Payment Label', Expected: 'Next payment on {{NEXT_PAYMENT_DATE}}' },
  { Tier: 'annual pay upfront', Field: 'Next Payment Date', Expected: '{{NEXT_PAYMENT_DATE}}' },
  { Tier: 'annual pay monthly', Field: 'Legal Text Line 1', Expected: 'Your plan will be changed to DAZN Ultimate today {{TODAY_DATE}} and your contract will last 12 months.' },
  { Tier: 'annual pay monthly', Field: 'Legal Text Line 2', Expected: 'Today you will be charged {{CURRENCY}}{{ANNUAL_PAY_MONTHLY_PRICE}} minus the remainder of your last payment which was not used in full. From {{NEXT_PAYMENT_DATE}} you will be charged {{CURRENCY}}{{ANNUAL_PAY_MONTHLY_PRICE}} /month.' },
  { Tier: 'annual pay monthly', Field: 'Rate Plan', Expected: 'Annual - Pay Monthly' },
  { Tier: 'annual pay monthly', Field: 'Rate Plan Price', Expected: '{{ANNUAL_PAY_MONTHLY_PRICE}}' },
  { Tier: 'annual pay monthly', Field: 'Rate Plan Period', Expected: '/ month' },
  { Tier: 'annual pay monthly', Field: 'Rate Plan Description', Expected: 'Annual contract. Paid in 12 monthly instalments.' },
  { Tier: 'annual pay monthly', Field: 'Next Payment Label', Expected: 'Next payment on {{NEXT_PAYMENT_DATE}}' },
  { Tier: 'annual pay monthly', Field: 'Next Payment Date', Expected: '{{NEXT_PAYMENT_DATE}}' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 10: Phone Number page
// ═══════════════════════════════════════════════════════════
const phoneNumberData = [
  { Field: 'Page Title', Expected: 'Add your phone number' },
  { Field: 'Page Description', Expected: 'This helps us recover your account if you ever get locked out.' },
  { Field: 'Phone Input Present', Expected: 'Yes' },
  { Field: 'Continue Button', Expected: 'Continue' },
  { Field: 'Country Code Present', Expected: 'Yes' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 11: OTP page
// ═══════════════════════════════════════════════════════════
const otpData = [
  { Field: 'Page Title', Expected: 'Verify your phone' },
  { Field: 'Page Description', Expected: 'Enter the code below to continue' },
  { Field: 'OTP Input Present', Expected: 'Yes' },
  { Field: 'Verify Button', Expected: 'Verify' },
  { Field: 'Resend Code Link', Expected: 'Yes' }
];

// ═══════════════════════════════════════════════════════════
// SHEET 12: Home of Boxing
// ═══════════════════════════════════════════════════════════
const homeOfBoxingData = [
  { Flow: 'home-boxing-banner', Field: 'Best of Boxing Section', Expected: 'Present' },
  { Flow: 'home-boxing-banner', Field: 'Banner - Event Title', Expected: '{{PPV_NAME}}' },
  { Flow: 'home-boxing-banner', Field: 'Banner - Event Date', Expected: '{{PPV_DATE}}' },
  { Flow: 'home-boxing-banner', Field: 'Banner - Event Description', Expected: '{{BANNER_DESCRIPTION}}' },
  { Flow: 'home-boxing-banner', Field: 'Banner - Buy Now CTA', Expected: 'Visible' },
  { Flow: 'home-boxing-banner', Field: 'Banner - Fight Card CTA', Expected: 'Visible' },
  { Flow: 'home-boxing-tile', Field: 'Best of Boxing Section', Expected: 'Present' },
  { Flow: 'home-boxing-tile', Field: 'PPV Tile Present', Expected: 'Yes' },
  { Flow: 'home-boxing-tile', Field: 'PPV Name', Expected: '{{PPV_NAME}}' },
  { Flow: 'home-boxing-tile', Field: 'PPV Date', Expected: '{{LANDING_PAGE_PPV_DATE}}' },
  { Flow: 'home-boxing-tile', Field: 'PPV Image Present', Expected: 'Yes' },
  { Flow: 'home-boxing-tile', Field: 'Popup - Event Title', Expected: '{{PPV_NAME}}' },
  { Flow: 'home-boxing-tile', Field: 'Popup - Event Date', Expected: '{{PPV_POPUP_DATE}}' },
  { Flow: 'home-boxing-tile', Field: 'Popup - Promoter', Expected: '{{PPV_PROMOTER}}' },
  { Flow: 'home-boxing-tile', Field: 'Popup - Buy Now CTA', Expected: 'Visible' },
  { Flow: 'home-boxing-tile', Field: 'Popup - Event Description', Expected: 'Catch the biggest moment of the year. Select a DAZN plan to pair with your pay-per-view.' },
  { Flow: 'home-boxing-tile', Field: 'Popup - Close Button', Expected: 'Visible' },
  { Flow: 'home-boxing-upcoming', Field: 'PPV Image Present', Expected: 'Yes' },
  { Flow: 'home-boxing-upcoming', Field: 'PPV Title', Expected: '{{MOBILE_BANNER_TITLE}}' },
  { Flow: 'home-boxing-upcoming', Field: 'PPV Promoter', Expected: '{{PPV_PROMOTER}}' },
  { Flow: 'home-boxing-upcoming', Field: 'Description', Expected: 'WATCH LIVE {{MOBILE_SEARCH_PPV_DATE}}' },
  { Flow: 'home-boxing-upcoming', Field: 'Tile - Day', Expected: '{{MOBILE_SCHEDULE_DAY}}' },
  { Flow: 'home-boxing-upcoming', Field: 'Tile - Date', Expected: '{{MOBILE_SCHEDULE_DATE}}' },
  { Flow: 'home-boxing-upcoming', Field: 'Tile - Month', Expected: '{{MOBILE_SCHEDULE_MONTH}}' },
  { Flow: 'home-boxing-upcoming', Field: 'Buy Now Button', Expected: 'Buy now' },
  { Flow: 'home-boxing-upcoming', Field: 'Fight Card Button', Expected: 'Fight card' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 13: Home page
// ═══════════════════════════════════════════════════════════
const homePageData = [
  { Flow: 'home-page-banner', Field: 'Banner Image Present', Expected: 'Yes' },
  { Flow: 'home-page-banner', Field: 'Banner - Event Title', Expected: '{{MOBILE_BANNER_TITLE}}' },
  { Flow: 'home-page-banner', Field: 'Banner - Event Date', Expected: '{{MOBILE_BANNER_DATE_TIME}}' },
  { Flow: 'home-page-banner', Field: 'Banner - Event Description', Expected: '{{MOBILE_BANNER_DESCRIPTION}}' },
  { Flow: 'home-page-banner', Field: 'Banner - Buy Now CTA', Expected: 'Buy now' },
  { Flow: 'home-page-banner', Field: 'Banner - Fight Card CTA', Expected: 'Fight Card' },
  { Flow: 'home-page-dont-miss', Field: 'Popup - Event Title', Expected: '{{PPV_NAME}}' },
  { Flow: 'home-page-dont-miss', Field: 'Popup - Event Date', Expected: '{{PPV_POPUP_DATE}}' },
  { Flow: 'home-page-dont-miss', Field: 'Popup - Promoter', Expected: '{{PPV_PROMOTER}}' },
  { Flow: 'home-page-dont-miss', Field: 'Popup - Buy Now CTA', Expected: 'Visible' },
  { Flow: 'home-page-dont-miss', Field: 'Popup - Event Description', Expected: 'Catch the biggest moment of the year. Select a DAZN plan to pair with your pay-per-view.' },
  { Flow: 'home-page-dont-miss', Field: 'Popup - Close Button', Expected: 'Visible' },
  // ── Home Page Biggest Fights validations ───────────────────
  { Flow: 'home-biggest-fights', Field: 'Biggest Fights Section', Expected: 'Saturday Fight Night' },
  { Flow: 'home-biggest-fights', Field: 'Popup - Event Title', Expected: '{{PPV_NAME}}' },
  { Flow: 'home-biggest-fights', Field: 'Popup - Event Date', Expected: '{{PPV_DATE}}' },
  { Flow: 'home-biggest-fights', Field: 'Popup - Promoter', Expected: '{{PPV_PROMOTER}}' },
  { Flow: 'home-biggest-fights', Field: 'Popup - Buy Now CTA', Expected: 'Visible' },
  { Flow: 'home-biggest-fights', Field: 'Popup - Event Description', Expected: 'Catch the biggest moment of the year. Select a DAZN plan to pair with your pay-per-view.' },
  { Flow: 'home-biggest-fights', Field: 'Popup - Close Button', Expected: 'Visible' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 14: Standalone PPV page
// ═══════════════════════════════════════════════════════════
const standalonePPVData = [
  { Field: 'Page Title', Expected: 'Choose a plan that\'s right for you', State: 'checked' },
  { Field: 'Page Heading', Expected: 'Buy {{PPV_NAME}} with a 7-day free trial', State: 'checked' },
  { Field: 'PPV Image Present', Expected: 'Yes', State: 'checked' },
  { Field: 'PPV Date Badge', Expected: '{{PPV_DATE}}', State: 'checked' },
  { Field: 'PPV Name', Expected: '{{PPV_NAME}}', State: 'checked' },
  { Field: 'PPV Price', Expected: '{{CURRENCY}}{{PPV_PRICE_RAW}}', State: 'checked' },
  { Field: 'PPV Checkbox State', Expected: 'Checked', State: 'checked' },
  { Field: 'Section Label', Expected: 'Choose your subscription', State: 'checked' },
  { Field: 'Flex Title', Expected: 'Flex – Pay Monthly', State: 'checked' },
  { Field: 'Flex Badge', Expected: '7 DAY FREE TRIAL', State: 'checked' },
  { Field: 'Flex Description', Expected: 'Only pay for the fight. Cancel anytime before the end of the trial.', State: 'checked' },
  { Field: 'Flex Today Text', Expected: 'Only pay for the fight and start your 7-day free trial of DAZN Standard', State: 'checked' },
  { Field: 'Flex Future Date', Expected: 'In 7 days • {{FLEX_FUTURE_DATE_SHORT}}', State: 'checked' },
  { Field: 'Flex Future Text', Expected: 'You will start your DAZN Standard plan at {{CURRENCY}}{{MONTHLY_PRICE}}/month. Cancel anytime before the end of the trial.', State: 'checked' },
  { Field: 'Annual Title', Expected: 'Annual - Pay Monthly', State: 'checked' },
  { Field: 'Annual Badge', Expected: 'SAVE {{CURRENCY}}{{ANNUAL_SAVINGS}} A YEAR', State: 'checked' },
  { Field: 'Annual Description', Expected: 'Annual contract. Auto renews.', State: 'checked' },
  { Field: 'Annual Price', Expected: '{{CURRENCY}}{{ANNUAL_PRICE}}/month for 12 months', State: 'checked' },
  { Field: 'CTA Button (Flex selected)', Expected: 'Continue with 7-day free trial', State: 'checked' },
  { Field: 'CTA Button (APM selected)', Expected: 'Continue', State: 'checked' },
  { Field: 'Plans Visible Count (checked)', Expected: '2', State: 'checked' },
  { Field: 'Plans Visible Count (unchecked)', Expected: '3', State: 'unchecked' },
  { Field: 'Flex Title (unchecked)', Expected: 'Flex – Pay Monthly', State: 'unchecked' },
  { Field: 'Flex Description (unchecked)', Expected: 'Billed monthly. Cancel anytime.', State: 'unchecked' },
  { Field: 'Flex Price (unchecked)', Expected: '{{CURRENCY}}{{MONTHLY_PRICE}}/month', State: 'unchecked' },
  { Field: 'APM Title (unchecked)', Expected: 'Annual - Pay Monthly', State: 'unchecked' },
  { Field: 'APU Title (unchecked)', Expected: 'Annual - Pay Upfront', State: 'unchecked' },
  { Field: 'APU Description (unchecked)', Expected: 'Annual contract. Auto renews.', State: 'unchecked' },
  { Field: 'APU Price (unchecked)', Expected: '{{CURRENCY}}{{ANNUAL_UPFRONT_PRICE}}/year', State: 'unchecked' },
  { Field: 'APU Save Badge (unchecked)', Expected: 'Save {{CURRENCY}}{{UPFRONT_SAVE_AMOUNT}}', State: 'unchecked' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 15: Upsell First Success page
// ═══════════════════════════════════════════════════════════
const upsellFirstSuccessData = [
  { Field: 'Payment Success Text', Expected: '{{SUCCESS_HEADING}}' },
  { Field: 'Upsell Heading', Expected: '{{UPSELL_HEADING}}' },
  { Field: 'Upsell Image Present', Expected: 'Yes' },
  { Field: 'Upsell Date Badge', Expected: '{{UPSELL_DATE}}' },
  { Field: 'Upsell Buy CTA', Expected: '{{UPSELL_BUY_CTA}}' },
  { Field: 'No Thanks Link', Expected: 'No thanks' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 16: Upsell Second Success page
// ═══════════════════════════════════════════════════════════
const upsellSecondSuccessData = [
  { Field: 'Payment Success Text', Expected: '{{SECOND_SUCCESS_HEADING}}' },
  { Field: 'Bet Offer Title', Expected: '{{BET_OFFER_TITLE}}' },
  { Field: 'Bet Heading', Expected: '{{BET_HEADING}}' },
  { Field: 'Bet Image Present', Expected: 'Yes' },
  { Field: 'Activate Betting CTA', Expected: '{{BET_CTA}}' },
  { Field: 'Maybe Later Link', Expected: '{{BET_DISMISS}}' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 17: Upsell Payment page
// ═══════════════════════════════════════════════════════════
const upsellPaymentData = [
  { Field: 'Page Title', Expected: '{{UPSELL_PPV_TITLE}}' },
  { Field: 'PPV Image Present', Expected: 'Yes' },
  { Field: 'Date Badge', Expected: '{{UPSELL_PPV_DATE}}' },
  { Field: 'PPV Price', Expected: '{{UPSELL_PPV_PRICE}}' },
  { Field: 'Payment Type', Expected: '{{UPSELL_PPV_TYPE}}' },
  { Field: 'Today you pay', Expected: '{{UPSELL_PPV_TODAY}}' },
  { Field: 'Payment Instruction', Expected: '{{UPSELL_PPV_TEXT}}' },
  { Field: 'Saved Card', Expected: '{{UPSELL_PPV_SAVED_CARD}}' },
  { Field: 'More Payment Methods', Expected: 'More payment methods' },
  { Field: 'Redeem Promo Code', Expected: 'Redeem promo code' },
];

// ═══════════════════════════════════════════════════════════
// SHEET 18: Search page
// ═══════════════════════════════════════════════════════════
const paywallData = [
  { Field: 'Event Name', Expected: '{{MOBILE_BANNER_TITLE}}' },
  { Field: 'Event Date and Time', Expected: '{{MOBILE_PPV_DATE}}' },
  { Field: 'Category', Expected: '{{PPV_PROMOTER}}' },
  { Field: 'Instruction Header', Expected: 'How to watch this and more?' },
  { Field: 'Instruction Text', Expected: 'Paste this link on your browser and choose the plan that’s right for you' },
  { Field: 'Copy Button', Expected: 'Copy' },
];

const searchPageData = [
  // ── Tile fields (validated BEFORE popup opens) ──────────────────────────────
  { Field: 'PPV Tile Present', Expected: 'Yes' },
  { Field: 'PPV Name', Expected: '{{PPV_NAME}}' },
  { Field: 'PPV Image Present', Expected: 'Yes' },
  { Field: 'Lock Icon Present', Expected: 'Yes' },
  { Field: 'PPV Description', Expected: 'WATCH LIVE {{MOBILE_SEARCH_PPV_DATE}}' },
];

// ═══════════════════════════════════════════════════════════
// BUILD WORKBOOK AND WRITE FILE
// ═══════════════════════════════════════════════════════════
const wb = XLSX.utils.book_new();

function addSheet(name: string, data: any[]): void {
  const ws = XLSX.utils.json_to_sheet(data);
  const keys = Object.keys(data[0] || {});
  ws['!cols'] = keys.map(k => ({
    wch: Math.max(k.length, ...data.map(r => String(r[k] ?? '').length)) + 2,
  }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

addSheet('Landing page', landingData);
addSheet('Boxing page', boxingLandingData);
addSheet('PPV page', ppvData);
addSheet('Dazn Plan page', planData);
addSheet('Payment page', paymentData);
addSheet('Schedule page', scheduleData);
addSheet('My Account page', myAccountData);
addSheet('Choose How To Buy page', chooseHowToBuyData);
addSheet('PPV Payment page', ppvPaymentData);
addSheet('Upgrade Confirmation page', upgradeConfirmationData);
addSheet('Phone Number page', phoneNumberData);
addSheet('OTP page', otpData);
addSheet('Home of Boxing', homeOfBoxingData);
addSheet('Home page', homePageData);
addSheet('Standalone PPV page', standalonePPVData);
addSheet('Upsell First Success page', upsellFirstSuccessData);
addSheet('Upsell Second Success page', upsellSecondSuccessData);
addSheet('Upsell Payment page', upsellPaymentData);
addSheet('Search page', searchPageData);
addSheet('paywall', paywallData);

// ── Dedicated Android In-App Sheets ──────────────────────────────────────────
addSheet('Andriod_Landing_Page', landingData);
addSheet('Andriod_Home_Page', homePageData);
addSheet('Andriod_Home_Boxing_Page', homeOfBoxingData);
addSheet('Andriod_Search_Page', searchPageData);
addSheet('Andriod_Schedule_Page', scheduleData);
addSheet('Andriod_Paywall', paywallData);

const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

XLSX.writeFile(wb, outputPath);

console.log('✅ Excel generated successfully!');
console.log(`📁 Path: ${outputPath}`);
console.log(`📋 Sheets: ${wb.SheetNames.join(', ')}`);
console.log(`📊 Rows per sheet:`);
wb.SheetNames.forEach(name => {
  const data = XLSX.utils.sheet_to_json(wb.Sheets[name]);
  console.log(`   ${name}: ${data.length}`);
});
