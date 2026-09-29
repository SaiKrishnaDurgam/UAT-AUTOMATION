import fs from 'fs';

type WdBrowser = any;

type CropRegion = {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

function isLikelyCheckoutUrl(value: string): boolean {
  return !!value && value.startsWith('http') && value.includes('dazn.com');
}

function decodeTextFromImage(
  jsQR: any,
  data: Buffer,
  width: number,
  height: number,
): string {
  const primary = jsQR(new Uint8ClampedArray(data), width, height, {
    inversionAttempts: 'attemptBoth',
  });
  return String(primary?.data || '').trim();
}

function trimPngAfterIend(buffer: Buffer): Buffer {
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const nextOffset = offset + 12 + length;

    if (nextOffset > buffer.length) return buffer;
    if (type === 'IEND') return buffer.subarray(0, nextOffset);

    offset = nextOffset;
  }

  return buffer;
}

function cropRgba(
  src: Buffer,
  srcWidth: number,
  srcHeight: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++) {
    const srcStart = ((y + row) * srcWidth + x) * 4;
    const srcEnd = srcStart + width * 4;
    const outStart = row * width * 4;
    src.copy(out, outStart, srcStart, srcEnd);
  }
  return out;
}

function upscaleRgba2x(src: Buffer, width: number, height: number): { data: Buffer; width: number; height: number } {
  const outWidth = width * 2;
  const outHeight = height * 2;
  const out = Buffer.alloc(outWidth * outHeight * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const r = src[srcIdx];
      const g = src[srcIdx + 1];
      const b = src[srcIdx + 2];
      const a = src[srcIdx + 3];

      const x2 = x * 2;
      const y2 = y * 2;
      const targets = [
        (y2 * outWidth + x2) * 4,
        (y2 * outWidth + (x2 + 1)) * 4,
        ((y2 + 1) * outWidth + x2) * 4,
        ((y2 + 1) * outWidth + (x2 + 1)) * 4,
      ];

      for (const idx of targets) {
        out[idx] = r;
        out[idx + 1] = g;
        out[idx + 2] = b;
        out[idx + 3] = a;
      }
    }
  }

  return { data: out, width: outWidth, height: outHeight };
}

export async function decodeCheckoutUrlFromQr(
  driver: WdBrowser,
  screenshotPath = './test-results/android_tv_qr.png',
): Promise<string> {
  try {
    const pngBase64 = await driver.takeScreenshot();
    const pngBuffer = Buffer.from(pngBase64, 'base64');
    fs.writeFileSync(screenshotPath, pngBuffer);

    // Keep runtime optional: if QR libs are unavailable, TV flow still uses
    // existing copy/webview capture without failing startup.
    const { PNG } = require('pngjs');
    const jsQR = require('jsqr');

    const parsed = PNG.sync.read(trimPngAfterIend(pngBuffer));
    const regions: CropRegion[] = [
      { name: 'full', x: 0, y: 0, w: parsed.width, h: parsed.height },
      { name: 'center-80', x: Math.floor(parsed.width * 0.1), y: Math.floor(parsed.height * 0.1), w: Math.floor(parsed.width * 0.8), h: Math.floor(parsed.height * 0.8) },
      { name: 'center-60', x: Math.floor(parsed.width * 0.2), y: Math.floor(parsed.height * 0.2), w: Math.floor(parsed.width * 0.6), h: Math.floor(parsed.height * 0.6) },
      { name: 'left-75', x: 0, y: 0, w: Math.floor(parsed.width * 0.75), h: parsed.height },
      { name: 'right-75', x: Math.floor(parsed.width * 0.25), y: 0, w: Math.floor(parsed.width * 0.75), h: parsed.height },
      { name: 'top-75', x: 0, y: 0, w: parsed.width, h: Math.floor(parsed.height * 0.75) },
      { name: 'bottom-75', x: 0, y: Math.floor(parsed.height * 0.25), w: parsed.width, h: Math.floor(parsed.height * 0.75) },
    ];

    for (const region of regions) {
      const safeW = Math.max(32, Math.min(region.w, parsed.width - region.x));
      const safeH = Math.max(32, Math.min(region.h, parsed.height - region.y));
      if (safeW < 32 || safeH < 32) continue;

      const cropped = cropRgba(parsed.data, parsed.width, parsed.height, region.x, region.y, safeW, safeH);
      const candidate = decodeTextFromImage(jsQR, cropped, safeW, safeH);
      if (isLikelyCheckoutUrl(candidate)) {
        console.log(`✅ QR decoded from ${region.name} region`);
        return candidate;
      }

      const upscaled = upscaleRgba2x(cropped, safeW, safeH);
      const candidateUpscaled = decodeTextFromImage(jsQR, upscaled.data, upscaled.width, upscaled.height);
      if (isLikelyCheckoutUrl(candidateUpscaled)) {
        console.log(`✅ QR decoded from ${region.name} region (2x scale)`);
        return candidateUpscaled;
      }
    }

    console.log('ℹ️ No QR payload detected in screenshot after regional retries.');
    return '';
  } catch (err: any) {
    console.log(`ℹ️ QR decode unavailable/failed: ${err.message}`);
    return '';
  }
}
