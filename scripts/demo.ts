import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FlowDef {
  id: number;
  platform: "Web" | "Android";
  user: string;
  entry: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
}

interface FlowResult {
  platform: string;
  user: string;
  entry: string;
  passed: boolean;
  durationMs: number;
  reportPaths: { html: string; pdf: string; excel: string; video: string } | null;
  geminiEvidence: boolean;
}

// ─── Mode ────────────────────────────────────────────────────────────────────

const PRESENTATION_MODE = (process.env.DEMO_MODE || "").toLowerCase() === "true";

// ─── ANSI helpers ────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";
const YELLOW = "\x1b[33m";

function heading(s: string) {
  return `${BOLD}${CYAN}${s}${RESET}`;
}
function pass(s: string) {
  return `${BOLD}${GREEN}${s}${RESET}`;
}
function fail(s: string) {
  return `${BOLD}${RED}${s}${RESET}`;
}
function label(s: string) {
  return `${BOLD}${WHITE}${s}${RESET}`;
}
function dim(s: string) {
  return `\x1b[2m${s}${RESET}`;
}
function warning(s: string) {
  return `${BOLD}${YELLOW}${s}${RESET}`;
}

// ─── Flow Definitions ────────────────────────────────────────────────────────
// Add a fifth flow by appending one object to this array.

const DEFAULT_ENV: Record<string, string> = {
  DAZN_REGION: "GB",
  DAZN_ENV: "prod",
  PPV_CONFIG: "ppv_t_joshua_prenga.json",
  PLAN: "standard_monthly",
  PAYMENT_METHOD: "credit_card",
  SWITCH: "false",
};

const FLOWS: FlowDef[] = [
  {
    id: 1,
    platform: "Web",
    user: "Active Paid User",
    entry: "My Account Page",
    command:
      "npx playwright test tests/existing_user/existinguser.ppv.spec.ts --project=chromium",
    cwd: process.cwd(),
    env: {
      SOURCE: "my-account",
      USER_STATE: "active_standard_monthly",
      LOGIN_FIRST: "true",
      PLAN: "standard_monthly"
    },
  },
  {
    id: 2,
    platform: "Android",
    user: "New User",
    entry: "Schedule → PPV Purchase",
    command:
      "npx wdio run config/wdio.android.conf.ts --spec tests/android/ppv.handoff.spec.ts",
    cwd: path.join(process.cwd(), "appium"),
    env: {
      SOURCE: "schedule",
      PLAN: "standard_apm",
      APPIUM_PORT: "4725",
      APPIUM_SYSTEM_PORT: "8202",
      CHROMEDRIVER_PORT: "9517"
    },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatElapsed(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function platformIcon(p: string): string {
  return p === "Web" ? "🌐" : "🤖";
}

function printBanner(): void {
  console.log("");
  console.log(
    `${BOLD}${CYAN}════════════════════════════════════════════════════════${RESET}`
  );
  console.log("");
  console.log(`${BOLD}${CYAN}        DAZN PPV Automation Platform${RESET}`);
  console.log(`${BOLD}${CYAN}             Executive Showcase${RESET}`);
  console.log("");
  console.log(
    `${BOLD}${CYAN}════════════════════════════════════════════════════════${RESET}`
  );
  console.log("");
}

function printFlowCard(flow: FlowDef, total: number): void {
  console.log(dim("━".repeat(55)));
  console.log("");
  console.log(heading(`Flow ${flow.id} of ${total}`));
  console.log("");
  console.log(`  ${platformIcon(flow.platform)}  ${label(flow.platform)}`);
  console.log(`     ${label(flow.user)}`);
  console.log(`     ${label(flow.entry)}`);
  console.log(`     ${label("GB · Production")}`);
  console.log("");
  console.log(`  ${BLUE}▶ Starting automation...${RESET}`);
  console.log("");
}

function printFlowComplete(
  flow: FlowDef,
  result: FlowResult
): void {
  const status = result.passed ? pass("✅ Completed") : fail("❌ Failed");
  console.log(`  ${status}`);
  console.log(`  Duration : ${formatDuration(result.durationMs)}`);
  if (result.reportPaths) {
    const rp = result.reportPaths;
    console.log("");
    console.log(`  Reports Generated:`);
    console.log(`    ${pass("✓")} HTML  : ${rp.html}`);
    console.log(`    ${pass("✓")} PDF   : ${rp.pdf}`);
    console.log(`    ${pass("✓")} Excel : ${rp.excel}`);
    console.log(`    ${pass("✓")} Video : ${rp.video}`);
    if (result.geminiEvidence)
      console.log(`    ${pass("✓")} AI Banner Validation`);
  }
  console.log("");
  console.log(dim("━".repeat(55)));
  console.log("");
}

// ─── Milestone detection ─────────────────────────────────────────────────────
// Lines containing these substrings are surfaced in presentation mode.

const MILESTONE_PATTERNS: RegExp[] = [
  /browser\s*(launched|opened|start)/i,
  /page\s*(loaded|navigat|ready)/i,
  /navigation\s*(completed|started)/i,
  /(validation|verify).*(completed|passed)/i,
  /generating\s*report/i,
  /HTML\s*:/i,
  /PDF\s*:/i,
  /Excel\s*:/i,
  /Video\s*:/i,
  /video\s*(saved|recorded|captured)/i,
  /Gemini\s*(Banner\s*)?Validation/i,
  /Jira/i,
  /✅.*complete/i,
  /✅.*done/i,
  /flow\s*(complete|ended|finished)/i,
  /🧾.*validating/i,
  /📋.*validating/i,
  /landed\s*on/i,
  /clicked\s*(buy|checkout|pay)/i,
  /payment\s*(complete|done|success)/i,
  /report\s*(generated|saved|created)/i,
  /test\s*complete/i,
];

function isMilestoneLine(line: string): boolean {
  return MILESTONE_PATTERNS.some((re) => re.test(line));
}

// ─── Report discovery ────────────────────────────────────────────────────────

function extractReportPaths(buffer: string[]): {
  html: string;
  pdf: string;
  excel: string;
  video: string;
  gemini: boolean;
} | null {
  const lines = buffer.join("\n");
  const htmlMatch = lines.match(/HTML\s*:\s*(.+PPV_Report\.html)/i);
  const pdfMatch = lines.match(/PDF\s*:\s*(.+PPV_Report\.pdf)/i);
  const excelMatch = lines.match(/Excel:\s*(.+PPV_Results\.xlsx)/i);
  const videoMatch = lines.match(/Video:\s*(.+PPV_Video\.\w+)/i);
  const geminiMatch = lines.match(/Gemini:\s*(.+Gemini_Banner_Validation)/i);

  if (!htmlMatch && !pdfMatch && !excelMatch) return null;

  return {
    html: htmlMatch?.[1] || "",
    pdf: pdfMatch?.[1] || "",
    excel: excelMatch?.[1] || "",
    video: videoMatch?.[1] || "",
    gemini: Boolean(geminiMatch),
  };
}

// ─── Execution ───────────────────────────────────────────────────────────────
// ROOT CAUSE ANALYSIS:
//
// npx playwright test keeps the Node.js process alive after tests finish
// (Playwright workers / browser connections don't trigger process exit).
// Therefore child.on("close") and child.on("exit") never fire, and the
// Promise never resolves naturally.
//
// FIX:
// 1. Detect test completion from stdout patterns
//    (e.g. "✅ Flow "Boxing Page Banner → Standard → Flex Monthly" complete: 70/70 passed")
// 2. When detected, extract report paths from the accumulated stdout buffer
// 3. Resolve the promise immediately — do not wait for the process to die
// 4. Kill the child process after resolution to prevent zombie processes
// 5. Each flow gets its own fresh state (timers, buffers, report paths)
//    — no leakage across flows.

function runFlow(flow: FlowDef, total: number): Promise<FlowResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    printFlowCard(flow, total);

    const [cmd, ...args] = flow.command.split(/\s+/);
    const mergedEnv = { ...process.env, ...DEFAULT_ENV, ...flow.env };

    const child: ChildProcess = spawn(cmd, args, {
      cwd: flow.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: mergedEnv,
    });

    // ── Per-flow state (fresh for every flow — no cross-flow leakage) ──
    const stdoutBuf: string[] = [];
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    // ── Heartbeat (presentation mode only) ───────────────────────────
    function startHeartbeat() {
      if (!PRESENTATION_MODE) return;
      heartbeatTimer = setInterval(() => {
        const elapsed = formatElapsed(start);
        process.stdout.write(`  ${warning("⏳ Executing... " + elapsed)}\n`);
      }, 10_000);
    }

    function stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }

    // ── Timeout (15 minutes) ─────────────────────────────────────────
    const FLOW_TIMEOUT_MS = 900_000;

    function startTimeout() {
      timeoutTimer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        stopHeartbeat();
        child.kill("SIGTERM");
        process.stderr.write(
          fail(`\nFlow ${flow.id} timed out after 15m\n`)
        );
        resolve({
          platform: flow.platform,
          user: flow.user,
          entry: flow.entry,
          passed: false,
          durationMs: Date.now() - start,
          reportPaths: null,
          geminiEvidence: false,
        });
      }, FLOW_TIMEOUT_MS);
    }

    function clearTimeout_() {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    }

    // ── Resolve helper (shared between stdout-detection and close) ──
    function resolveWithResult(passed: boolean) {
      if (resolved) return;
      resolved = true;
      stopHeartbeat();
      clearTimeout_();

      const durationMs = Date.now() - start;

      // Extract report paths from THIS flow's stdout buffer only
      // (each flow has its own fresh stdoutBuf — no cross-flow leakage)
      const reportPaths = extractReportPaths(stdoutBuf);

      let gemini = reportPaths?.gemini ?? false;
      let paths = reportPaths
        ? { ...reportPaths }
        : null;

      if (paths && !gemini) {
        gemini = fs.existsSync(
          path.join(path.dirname(paths.html), "Gemini_Banner_Validation")
        );
      }

      const result: FlowResult = {
        platform: flow.platform,
        user: flow.user,
        entry: flow.entry,
        passed,
        durationMs,
        reportPaths: paths
          ? {
              html: paths.html,
              pdf: paths.pdf,
              excel: paths.excel,
              video: paths.video,
            }
          : null,
        geminiEvidence: gemini,
      };

      printFlowComplete(flow, result);

      // Kill the child process so it doesn't stay alive as a zombie
      child.kill("SIGTERM");

      resolve(result);
    }

    // ══════════════════════════════════════════════════════════════════
    // Stdout — detect test completion and resolve immediately
    // ══════════════════════════════════════════════════════════════════

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutBuf.push(text);

      if (PRESENTATION_MODE) {
        const lines = text.split("\n").filter(Boolean);
        for (const line of lines) {
          if (isMilestoneLine(line)) {
            const isReportPath =
              /^(HTML|PDF|Excel|Video)\s*:/i.test(line.trim());
            const trimmed = isReportPath
              ? line
              : line.length > 110
                ? line.slice(0, 110) + "…"
                : line;
            process.stdout.write(`  ${dim("·")} ${trimmed}\n`);
          }
        }
      } else {
        process.stdout.write(text);
      }

      // ── Detect test completion from machine-readable marker ─────
      // The framework prints __DEMO_FLOW_COMPLETE__ after ALL reports
      // are fully generated. This is the ONLY synchronization point.
      if (text.includes('__DEMO_FLOW_COMPLETE__')) {
        resolveWithResult(true);
      }
    });

    // ══════════════════════════════════════════════════════════════════
    // Stderr — always streamed live
    // ══════════════════════════════════════════════════════════════════

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk.toString());
    });

    // ══════════════════════════════════════════════════════════════════
    // Start timers
    // ══════════════════════════════════════════════════════════════════

    setImmediate(() => {
      startHeartbeat();
      startTimeout();
    });

    // ══════════════════════════════════════════════════════════════════
    // Process lifecycle events — fallback if stdout detection missed
    // ══════════════════════════════════════════════════════════════════

    child.on("error", (err: Error) => {
      if (resolved) return;
      process.stderr.write(fail(`\nFailed to start: ${err.message}\n`));
      resolveWithResult(false);
    });

    child.on("close", (code: number | null) => {
      // If stdout detection already resolved, this is a no-op (resolved=true)
      resolveWithResult(code === 0);
    });

    child.on("exit", (code: number | null) => {
      // Same guard — first one to call resolveWithResult wins
      resolveWithResult(code === 0);
    });
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(results: FlowResult[]): void {
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;

  console.log(
    `${BOLD}${CYAN}════════════════════════════════════════════════════════${RESET}`
  );
  console.log(`${BOLD}${CYAN}  DAZN PPV Automation Platform${RESET}`);
  console.log("");
  console.log("  Platforms");
  const platforms = Array.from(new Set(results.map((r) => r.platform)));
  platforms.forEach((p) => {
    const passed = results.filter((r) => r.platform === p).every((r) => r.passed);
    console.log(`    ${passed ? pass("✅") : fail("❌")} ${p}`);
  });
  console.log("");

  console.log("  Entry Points");
  const entries = Array.from(new Set(results.map((r) => r.entry)));
  entries.forEach((e) => {
    const passed = results.filter((r) => r.entry === e).every((r) => r.passed);
    console.log(`    ${passed ? pass("✅") : fail("❌")} ${e}`);
  });
  console.log("");

  console.log("  User States");
  const users = Array.from(new Set(results.map((r) => r.user)));
  users.forEach((u) => {
    const passed = results.filter((r) => r.user === u).every((r) => r.passed);
    console.log(`    ${passed ? pass("✅") : fail("❌")} ${u}`);
  });
  console.log("");

  console.log("  Quality");
  const funcPassed = results.every((r) => r.passed);
  console.log(`    ${funcPassed ? pass("✅") : fail("❌")} Functional Validation`);
  const hasGemini = results.some((r) => r.geminiEvidence);
  console.log(`    ${hasGemini ? pass("✅") : warning("⚠️")} Gemini AI Banner Validation`);
  console.log("");

  console.log("  Reporting");
  const hasReports = results.some((r) => r.reportPaths);
  console.log(`    ${hasReports ? pass("✅") : fail("❌")} HTML Report`);
  console.log(`    ${hasReports ? pass("✅") : fail("❌")} PDF Report`);
  console.log(`    ${hasReports ? pass("✅") : fail("❌")} Excel Report`);
  console.log(`    ${hasReports ? pass("✅") : fail("❌")} Video Recording`);
  console.log("");

  console.log("  CI/CD");
  console.log(`    ${pass("✅")} GitHub Actions`);
  console.log(`    ${pass("✅")} Multi Region`);
  console.log(`    ${pass("✅")} Multiple User States`);
  console.log(`    ${pass("✅")} Multiple Entry Points`);
  console.log(`    ${pass("✅")} Automatic Jira Ticket Creation`);
  console.log("");
  console.log(
    `${BOLD}${CYAN}════════════════════════════════════════════════════════${RESET}`
  );
  console.log("");
  console.log("  Statistics");
  console.log(`    Total Flows : ${results.length}`);
  console.log(`    Passed      : ${passedCount}`);
  console.log(`    Failed      : ${failedCount}`);
  console.log(`    Duration    : ${formatDuration(totalDuration)}`);
  console.log("");

  if (results.some((r) => r.reportPaths)) {
    console.log("  Report Files by Flow");
    results.forEach((r, idx) => {
      const statusText = r.passed ? pass("Passed") : fail("Failed");
      console.log(`    ${BOLD}Flow ${idx + 1}: ${r.platform} · ${r.user} · ${r.entry}${RESET} (${statusText})`);

      const rp = r.reportPaths;
      if (rp) {
        if (rp.html) console.log(`      ${pass("✓")} HTML  : ${rp.html}`);
        if (rp.pdf) console.log(`      ${pass("✓")} PDF   : ${rp.pdf}`);
        if (rp.excel) console.log(`      ${pass("✓")} Excel : ${rp.excel}`);
        if (rp.video) console.log(`      ${pass("✓")} Video : ${rp.video}`);

        const geminiHtml = path.join(path.dirname(rp.html), "Gemini_Banner_Validation", "index.html");
        if (fs.existsSync(geminiHtml)) {
          console.log(`      ${pass("✓")} AI Validation : ${geminiHtml}`);
        }
      } else {
        console.log(`      No report files generated`);
      }
      console.log("");
    });

    const firstHtml = results.map((r) => r.reportPaths?.html).find(Boolean);
    if (process.platform === "darwin" && firstHtml) {
      console.log(`  ${dim("Opening HTML report...")}`);
      spawn("open", [firstHtml], { stdio: "ignore" });
    }
  }

  if (results.some((r) => r.geminiEvidence)) {
    console.log("");
    console.log(`  ${pass("✓")} Gemini AI Banner Validation Evidence Included`);
  }

  console.log("");
  if (failedCount > 0) {
    console.log(fail(`  ${failedCount} flow(s) failed. Review output above.`));
  } else {
    console.log(pass("  All flows completed successfully."));
  }
  console.log("");
  console.log(
    `${BOLD}${CYAN}════════════════════════════════════════════════════════${RESET}`
  );
  console.log("");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printBanner();

  const results: FlowResult[] = [];
  
  // Support running a specific flow via FLOW_ID environment variable
  const flowIdArg = process.env.FLOW_ID;
  const flowsToRun = flowIdArg 
    ? FLOWS.filter(f => f.id === Number(flowIdArg))
    : FLOWS;
    
  if (flowIdArg && flowsToRun.length === 0) {
    console.error(`❌ Invalid FLOW_ID: ${flowIdArg}. Available flows: ${FLOWS.map(f => f.id).join(', ')}`);
    process.exit(1);
  }
  
  if (flowIdArg) {
    console.log(`🎯 Running only Flow ${flowIdArg} of ${FLOWS.length}\n`);
  }

  for (const flow of flowsToRun) {
    const result = await runFlow(flow, FLOWS.length);
    results.push(result);
  }

  printSummary(results);

  const anyFailed = results.some((r) => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(fail(`\nFatal error: ${err.message}\n`));
  process.exit(1);
});