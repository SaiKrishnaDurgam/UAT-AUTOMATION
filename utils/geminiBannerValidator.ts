import fs from 'fs';
import https from 'https';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

type BannerAssessment = {
  imageLoaded: 'pass' | 'fail' | 'uncertain';
  imageQuality: 'pass' | 'fail' | 'uncertain';
  fightersVisible: 'pass' | 'fail' | 'uncertain';
  fighterCropping: 'pass' | 'fail' | 'uncertain';
  imageDistortion: 'pass' | 'fail' | 'uncertain';
  overlayObstructingArtwork: 'pass' | 'fail' | 'uncertain';
  confidence: number;
  findings: string[];
};

export type BannerValidationResult = {
  passed: boolean;
  assessment: BannerAssessment;
};

function requestGemini(url: string, apiKey: string, body: Buffer): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(30_000, () => request.destroy(new Error('Gemini request timed out after 30 seconds')));
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function parseAssessment(responseBody: string): BannerAssessment {
  const response = JSON.parse(responseBody) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = response.candidates?.[0]?.content?.parts?.find(part => part.text)?.text;
  if (!text) throw new Error('Gemini returned no text assessment');

  const assessment = JSON.parse(text) as BannerAssessment;
  if (
    !assessment.imageLoaded ||
    !assessment.imageQuality ||
    !assessment.fightersVisible ||
    !assessment.fighterCropping ||
    !assessment.imageDistortion ||
    !assessment.overlayObstructingArtwork ||
    typeof assessment.confidence !== 'number' ||
    !Array.isArray(assessment.findings)
  ) {
    throw new Error('Gemini returned an invalid or incomplete banner assessment');
  }
  return assessment;
}

/**
 * Checks a rendered promotional banner image. Existing PPV callers use this as
 * supplementary, warn-only QA; standalone callers can assert the result.
 */
export async function validateBannerImage(
  banner: { screenshot(options: { path: string; type: 'png' }): Promise<Buffer> },
  context: { region: string; flow: string; url?: string; fighterNames?: string[] }
): Promise<BannerValidationResult | null> {
  if (process.env.GITHUB_ACTIONS !== 'true' && process.env.GEMINI_BANNER_VALIDATION !== 'true' && process.env.DEMO_MODE !== 'true') return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    console.log('ℹ️ [Gemini Banner] GEMINI_API_KEY is not configured; visual check skipped.');
    return null;
  }

  try {
    const evidenceDir = path.resolve(process.cwd(), 'test-results', 'gemini-banner');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeFlow = context.flow.replace(/[^a-zA-Z0-9_-]/g, '-');
    const imagePath = path.join(evidenceDir, `banner-${safeFlow}-${context.region}-${timestamp}.png`);
    await banner.screenshot({ path: imagePath, type: 'png' });

    const image = fs.readFileSync(imagePath).toString('base64');
    const schema = {
      type: 'object',
      properties: {
        imageLoaded: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        imageQuality: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        fightersVisible: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        fighterCropping: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        imageDistortion: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        overlayObstructingArtwork: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
        confidence: { type: 'number' },
        findings: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'imageLoaded', 'imageQuality', 'fightersVisible',
        'fighterCropping', 'imageDistortion', 'overlayObstructingArtwork',
        'confidence', 'findings'
      ]
    };
    const fighterNames = context.fighterNames?.length ? context.fighterNames : [];
    const fighterNamesText = fighterNames.length
      ? ` The featured fighters for this event are: ${fighterNames.join(' and ')}.`
      : '';

const prompt = [
  'You are a senior QA engineer reviewing a DAZN promotional banner.',

  'Your responsibility is to validate ONLY the promotional artwork.',
  'Ignore all marketing copy, event names, dates, prices, logos, CTA buttons and UI text.',
  'These are validated separately by automation.',

  fighterNamesText,

  'Use the expected promotional subjects only to determine who should appear in the artwork.',
  'Mention the expected subject names in the findings whenever possible.',

  'If the screenshot does not show the expected promotional artwork, mark the validation as failed.',
  'Examples include:',
  '- VPN warning',
  '- Cookie consent page covering the banner',
  '- Login page',
  '- 403/404 error page',
  '- Placeholder image',
  '- Skeleton loader',
  '- Broken or missing image',

  'Review the artwork exactly as an experienced QA engineer would.',

  'Evaluate the following:',

  '• imageLoaded',
  'pass only if the promotional artwork has loaded completely.',
  'fail if the artwork is missing, replaced by an error page, placeholder, skeleton loader or other non-promotional content.',

  '• imageQuality',
  'pass if the artwork is visually sharp and suitable for production.',
  'fail if the artwork is blurry, pixelated, heavily compressed or noticeably low resolution.',

  '• fightersVisible',
  'Determine whether every expected promotional subject can be confidently identified.',
  'pass if each expected subject is clearly recognizable.',
  'fail if any expected subject is missing, cannot be confidently identified or the image quality prevents identification.',
  'A subject does NOT fail simply because only the upper body is shown.',
  'Chest-up or waist-up promotional artwork is acceptable.',

  '• fighterCropping',
  'Determine whether the visible upper-body portrait is unintentionally cropped.',
  'For DAZN promotional artwork, evaluate only the visible portrait area (typically chest-up or waist-up).',
  'pass if the portrait is naturally framed and no unintended clipping is present.',
  'fail if the banner edge cuts through the head, hair, forehead, face, chin, ears, neck, shoulders or upper chest.',
  'Do NOT fail simply because the lower body, waist or legs are not shown.',

  '• imageDistortion',
  'pass if the artwork maintains the correct proportions.',
  'fail if the artwork appears stretched, squashed, warped or displayed with an incorrect aspect ratio.',

  '• overlayObstructingArtwork',
  'fail if a popup, cookie banner, VPN warning, modal or other overlay blocks a significant portion of the promotional artwork.',

  'Findings:',
  'Write concise QA observations describing only what is visible.',
  'Do not speculate.',
  'Mention the expected subject names whenever possible.',
  'Examples:',
  '- Joshua is clearly visible.',
  '- Prenga is clearly visible.',
  '- Joshua is unintentionally cropped at the head.',
  '- The promotional artwork is heavily pixelated.',
  '- A cookie banner obscures the lower portion of the artwork.',

  'Confidence:',
  'Return a value between 0 and 100.',
  '95-99 = Very confident.',
  '80-94 = Confident.',
  '50-79 = Moderate confidence.',
  '0-49 = Unable to reliably assess.',
  'Use 100 only when absolutely no ambiguity exists.',

  'Return ONLY valid JSON matching the supplied schema.',
].join(' ');
    const payload = Buffer.from(JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'image/png', data: image } },
        { text: prompt },
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0,
      },
    }));
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const response = await requestGemini(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      apiKey,
      payload
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Gemini returned HTTP ${response.statusCode}: ${response.body.slice(0, 500)}`);
    }

    const assessment = parseAssessment(response.body);
    const MIN_CONFIDENCE = 60;
    const hasFindings = Array.isArray(assessment.findings) && assessment.findings.length > 0;
    const passed =
      hasFindings &&
      assessment.confidence >= MIN_CONFIDENCE &&
      assessment.imageLoaded === 'pass' &&
      assessment.imageQuality === 'pass' &&
      assessment.fightersVisible === 'pass' &&
      assessment.fighterCropping === 'pass' &&
      assessment.imageDistortion === 'pass' &&
      assessment.overlayObstructingArtwork === 'pass';

    const icon = passed ? '✅' : '⚠️';

    fs.writeFileSync(`${imagePath}.json`, `${JSON.stringify({
      url: context.url,
      flow: context.flow,
      region: context.region,
      image: path.basename(imagePath),
      passed,
      assessment,
    }, null, 2)}\n`);

    console.log(
      `${icon} [Gemini Banner] ${passed ? 'PASS' : 'WARN'} | ` +
      `loaded=${assessment.imageLoaded}` +
      ` | quality=${assessment.imageQuality}` +
      ` | fighters=${assessment.fightersVisible}` +
      ` | crop=${assessment.fighterCropping}` +
      ` | distortion=${assessment.imageDistortion}` +
      ` | overlay=${assessment.overlayObstructingArtwork}` +
      ` | confidence=${assessment.confidence}%`
    );
    for (const finding of assessment.findings) console.log(`   [Gemini Banner] ${finding}`);
    return { passed, assessment };
  } catch (error: any) {
    // Gemini is supplementary QA; an API/quota/model issue must not hide the E2E result.
    console.warn(`⚠️ [Gemini Banner] Visual check could not run: ${error?.message || error}`);
    return null;
  }
}

// Kept for existing PPV flows, where the result remains warn-only.
export const validatePpvBannerImage = validateBannerImage;