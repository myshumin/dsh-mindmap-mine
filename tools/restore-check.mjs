// Restore-check a session log through the harness' OWN read path, loaded
// straight out of app.asar (run with ELECTRON_RUN_AS_NODE=1).
//
// It mirrors SessionLogScanner in @deepseek-ai/dsh-session-persistence-jsonl:
//   parseHeaderRecord -> sessionFormatCatalog.createRestore(header)
//   per row: assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES) -> restore.decodeRow(row)
//   finally: restore.finish()
// so a PASS means the running harness can load the log.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ASAR = "file:///Applications/DSH%20NEXT.app/Contents/Resources/app.asar/node_modules/@deepseek-ai/";
const { KNOWN_SESSION_EVENT_TYPES } = await import(ASAR + "dsh-session/lib/index.js");
const { sessionFormatCatalog } = await import(ASAR + "dsh-session-format-catalog/lib/index.js");
const { assertV4RowAdmission } = await import(ASAR + "dsh-session-format-v3-to-v4/lib/index.js");
const { validateStoredEvents } = await import(ASAR + "dsh-session-persistence/lib/index.js");

const files = process.argv.slice(2);
let failed = 0;

function readRows(file) {
  const bytes = readFileSync(file);
  // Harness logs are multi-frame zstd; zlib's one-shot decoder stops after the
  // first frame, so shell out to the CLI.
  const raw = bytes[0] === 0x28 && bytes[1] === 0xb5
    ? execFileSync("/opt/homebrew/bin/zstd", ["-dc", file], { maxBuffer: 1 << 30 }).toString("utf8")
    : bytes.toString("utf8");
  return raw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

for (const file of files) {
  const label = file.split("/").slice(-2).join("/");
  try {
    const [headerRow, ...eventRows] = readRows(file);
    const restore = sessionFormatCatalog.createRestore(headerRow, {
      recovery: "strict",
      validation: "transformed"
    });
    for (const row of eventRows) {
      assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES);
      restore.decodeRow(row);
    }
    const artifact = restore.finish();
    const events = artifact?.events ?? [];
    // The load path ends on the persistence-layer gate — this is the exact check
    // that produced "unknown to this harness and not marked ignorable".
    const meta = {
      version: 4,
      id: headerRow.id,
      createdAt: headerRow.createdAt,
      isSeeded: headerRow.isSeeded,
      delegationDepth: headerRow.delegationDepth,
      ...(headerRow.cwd === undefined ? {} : { cwd: headerRow.cwd }),
      ...(headerRow.parentSession === undefined ? {} : { parentSession: headerRow.parentSession }),
      ...(headerRow.origin === undefined ? {} : { origin: headerRow.origin }),
      ...(headerRow.agentPreset === undefined ? {} : { agentPreset: headerRow.agentPreset })
    };
    validateStoredEvents(meta, events, { kind: "jsonl", path: file });
    console.log(`PASS ${label}  events=${events.length}  id=${headerRow.id}`);
  } catch (error) {
    failed += 1;
    const name = error?.constructor?.name ?? "Error";
    console.log(`FAIL ${label}\n     ${name}: ${String(error?.message ?? error).slice(0, 400)}`);
  }
}

console.log(failed === 0 ? "\nall logs restore through the harness read path" : `\n${failed} log(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
