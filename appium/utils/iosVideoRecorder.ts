/**
 * iOS screen-recording helpers.
 *
 * Two strategies, chosen automatically by IOS_DEVICE_MODE:
 *
 *  SIMULATOR  → driver.startRecordingScreen() / stopRecordingScreen() (simctl)
 *               Works perfectly, no permissions needed.
 *
 *  REAL DEVICE → ffmpeg captures the WDA MJPEG stream (port 9100).
 *               Requires `appium:mjpegServerPort: 9100` in wdio.ios.conf.ts.
 *               No iOS privacy permission needed on the device.
 *
 * Usage:
 *   await startIOSRecording(driver);
 *   // ... run the test ...
 *   const videoPath = await stopIOSRecording(driver);  // absolute path or null
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

const MJPEG_PORT = 9100;
let ffmpegProcess: ChildProcess | null = null;
let recordingOutputPath: string | null = null;
let recordingActive = false;
let lastRecordingPath: string | null = null;

// ─── Simulator: delegate to Appium's built-in recorder ────────────────────────

async function startSimulatorRecording(driver: any): Promise<void> {
  await driver.startRecordingScreen({
    timeLimit: 600,
    videoType: 'mp4',
    videoQuality: 'medium',
  });
}

async function stopSimulatorRecording(driver: any): Promise<string | null> {
  const videoBuffer: string = await driver.stopRecordingScreen();
  if (!videoBuffer || videoBuffer.length === 0) {
    console.warn('⚠️ Simulator recording returned empty buffer.');
    return null;
  }
  const buf = Buffer.from(videoBuffer, 'base64');
  if (buf.length < 1024) {
    console.warn('⚠️ Simulator recording buffer too small — likely empty.');
    return null;
  }
  const videoDir = path.resolve(process.cwd(), 'test-results');
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  const outPath = path.join(videoDir, `ios_sim_${Date.now()}.mp4`);
  fs.writeFileSync(outPath, buf);
  console.log(`🎥 Simulator video saved: ${outPath} (${Math.round(buf.length / 1024)} KB)`);
  return outPath;
}

// ─── Real device: capture WDA MJPEG stream with ffmpeg ────────────────────────

async function startRealDeviceRecording(): Promise<void> {
  const videoDir = path.resolve(process.cwd(), 'test-results');
  if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
  recordingOutputPath = path.join(videoDir, `ios_real_${Date.now()}.mp4`);

  // ffmpeg reads the MJPEG stream from WDA and encodes to H.264 MP4.
  // -framerate 10   — matches WDA's default MJPEG frame rate
  // -i              — MJPEG stream URL served by WDA on localhost
  // -vcodec libx264 — encode to H.264 (widely compatible)
  // -preset ultrafast -crf 28 — fast encode, reasonable quality
  // -pix_fmt yuv420p — required for QuickTime / browser compatibility
  const args = [
    '-y',
    '-f', 'mjpeg',
    '-framerate', '10',
    '-i', `http://localhost:${MJPEG_PORT}`,
    '-stdin',
    '-vcodec', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '28',
    '-pix_fmt', 'yuv420p',
    recordingOutputPath,
  ];

  console.log(`🎥 Starting MJPEG capture → ${recordingOutputPath}`);
  ffmpegProcess = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpegProcess.on('error', (e) => {
    console.warn(`⚠️ ffmpeg process error: ${e.message}`);
    ffmpegProcess = null;
  });

  // Give ffmpeg 2s to connect to the MJPEG stream before the test runs
  await new Promise(r => setTimeout(r, 2000));
}

async function stopRealDeviceRecording(): Promise<string | null> {
  if (!ffmpegProcess || !recordingOutputPath) {
    console.warn('⚠️ No real-device recording in progress.');
    return null;
  }

  return new Promise((resolve) => {
    const proc = ffmpegProcess!;
    const outPath = recordingOutputPath!;
    ffmpegProcess = null;
    recordingOutputPath = null;
    let settled = false;

    const discardIncompleteVideo = () => {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    };

    proc.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(interruptTimeout);
      clearTimeout(terminateTimeout);
      clearTimeout(forceTimeout);
      if (fs.existsSync(outPath)) {
        const size = fs.statSync(outPath).size;
        if (size > 4096) {
          console.log(`🎥 Real device video saved: ${outPath} (${Math.round(size / 1024)} KB)`);
          resolve(outPath);
        } else {
          console.warn(`⚠️ Video file too small (${size} bytes) — likely no frames captured.`);
          resolve(null);
        }
      } else {
        console.warn('⚠️ Video file not created.');
        resolve(null);
      }
    });

    // Close ffmpeg's command input after requesting a graceful quit so it
    // writes the MP4 trailer (including the moov atom) before exiting.
    try {
      proc.stdin?.end('q');
    } catch {
      proc.kill('SIGINT');
    }

    const interruptTimeout = setTimeout(() => {
      proc.kill('SIGINT');
    }, 5000);
    const terminateTimeout = setTimeout(() => {
      proc.kill('SIGTERM');
    }, 10000);
    const forceTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      discardIncompleteVideo();
      console.warn('⚠️ ffmpeg did not finalize the iOS recording; discarded incomplete video.');
      resolve(null);
    }, 15000);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startIOSRecording(driver: any): Promise<void> {
  const isRealDevice = (process.env.IOS_DEVICE_MODE || 'simulator').toLowerCase() === 'real';
  console.log(`🎥 Starting screen recording on iOS ${isRealDevice ? 'real device (MJPEG)' : 'simulator'}...`);
  try {
    lastRecordingPath = null;
    if (isRealDevice) {
      await startRealDeviceRecording();
    } else {
      await startSimulatorRecording(driver);
    }
    recordingActive = true;
    console.log('🎥 Screen recording started successfully.');
  } catch (e: any) {
    console.warn(`⚠️ Failed to start screen recording (non-fatal): ${e.message ?? e}`);
  }
}

export async function stopIOSRecording(driver: any): Promise<string | null> {
  if (!recordingActive) return lastRecordingPath && fs.existsSync(lastRecordingPath) ? lastRecordingPath : null;
  const isRealDevice = (process.env.IOS_DEVICE_MODE || 'simulator').toLowerCase() === 'real';
  console.log('🎥 Stopping screen recording on iOS device...');
  try {
    const outputPath = isRealDevice
      ? await stopRealDeviceRecording()
      : await stopSimulatorRecording(driver);
    lastRecordingPath = outputPath;
    return outputPath;
  } catch (e: any) {
    console.warn(`⚠️ Failed to stop/save screen recording (non-fatal): ${e.message ?? e}`);
    return null;
  } finally {
    recordingActive = false;
  }
}
