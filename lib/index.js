/**
 * dsh-mindmap-mine — host (node) half.
 *
 * A live, bidirectional mind map plugin built on the mind-elixir-core kernel.
 *
 * Host responsibilities:
 *  - Register a `mindmap` session projection (whole-value event rule): the
 *    complete MindElixirData tree is carried by each plugin record, so the
 *    projection is a trivial last-write-wins fold and every served value is
 *    self-describing. Records use the harness plugin-record contract
 *    (`plugin:` type namespace + `ignorable: true`); a non-namespaced type is
 *    refused by the harness when the session log is restored, which is what
 *    made pre-0.7.6 sessions unreadable.
 *  - Register model-facing tools (`mindmap_live_get`, `mindmap_live_set`) so the agent
 *    can read and rewrite the mind map in response to the conversation.
 *  - Register a `/mindmap` Connection RPC channel so the browser canvas can
 *    push user edits back into the session log (which drives the projection
 *    forward and broadcasts `session/projection` frames to every client).
 *
 * The browser half ships via exports["./client"], discovered through the
 * package.json `dsh.client` declaration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";

const name = "dsh-mindmap-mine";
const inject = ["tools", "webServer"];

/** Projection key the client reads with `useProjection("mindmap")`. */
const PROJECTION_KEY = "mindmap";
/** Connection RPC channel the browser canvas pushes edits through. */
const RPC_CHANNEL = "/mindmap";
const MAX_PUSH_BYTES = 8 * 1024 * 1024;
const RPC_ENDPOINT = "update";

/**
 * Sanctioned plugin-record type. The harness admits an event type it does not
 * know only when the writer marked it `ignorable: true` and the name follows
 * the `plugin:` grammar — `appendPluginRecord` is the API that does both.
 */
const RECORD_TYPE = "plugin:dsh-mindmap-mine/map";
/**
 * Pre-0.7.6 record type, kept readable so sessions written by older builds and
 * repaired logs still fold. Never written any more: it is outside the plugin
 * grammar and un-ignorable, so a log containing it fails to restore.
 */
const LEGACY_RECORD_TYPE = "mindmap/update";

// ---------------------------------------------------------------------------
// Workspace map store
//
// The truth source for a mind map is a JSON file inside the WORKSPACE
// (`<workspace>/.dsh/mindmaps/<id>.json`), not the session log. A session log
// only remembers which map it is looking at, so opening the same workspace in
// a fresh conversation lands on the same map instead of an empty canvas. The
// projection stays in place as the event-sourced mirror the browser renders.
// ---------------------------------------------------------------------------

/** Directory (workspace-relative) holding map documents and exported specs. */
const MAP_DIR_REL = path.join(".dsh", "mindmaps");
const SPEC_DIR_REL = path.join(MAP_DIR_REL, "specs");
const TASKS_DIR_REL = path.join(MAP_DIR_REL, "tasks");
const MAP_FILE_VERSION = 1;
/**
 * Map ids become file names, so they must stay path-safe while still allowing
 * a Chinese title to be used directly (`产品路线`). Path separators, control
 * characters and the Windows-reserved set are excluded; length and the
 * leading-dot rule are enforced in normalizeMapId.
 */
const MAP_ID_RE = /^[^\u0000-\u001f<>:"/\\|?*]+$/;
const MAP_ID_MAX = 64;
/** Map every conversation in a workspace shares when it names none. */
const DEFAULT_MAP_ID = "roadmap";
const DEFAULT_MAP_TITLE = "路线图";
/**
 * Optional lifecycle state a node may carry. It is plain data on the node
 * (`node.state`), so it survives a round-trip through the tree; the canvas
 * paints it, the spec export prints it, and `mindmap_mark` writes it back.
 */
const NODE_STATES = ["idea", "todo", "doing", "done", "dropped"];
const NODE_STATE_LABELS = {
  idea: "想法",
  todo: "待办",
  doing: "进行中",
  done: "已完成",
  dropped: "已废弃"
};
/** Polling window the browser uses to notice edits made in another session. */
const MAX_EXPORT_BYTES = 512 * 1024;

/**
 * The mind map carried by one committed event, or `undefined` when the event
 * belongs to some other feature. A mind map that was explicitly cleared is
 * `null`.
 * @param event - any committed session event.
 * @returns the tree, `null` for an explicit clear, or `undefined` when foreign.
 */
function mindmapTreeOf(event) {
  if (event.type === LEGACY_RECORD_TYPE) return event.data?.tree;
  const record = pluginRecordOf(event);
  if (record === undefined || record.type !== RECORD_TYPE) return undefined;
  return record.data?.tree;
}

/** Permissive schema: the tree is arbitrary MindElixir JSON (or null before first write). */
const mindmapProjectionSchema = z.any();

/**
 * A theme is only usable when it carries a non-empty palette of color strings.
 * The kernel applies data.theme verbatim and linkDiv then reads
 * `theme.palette.length` — a partial theme crashes rendering.
 */
function usableTheme(theme) {
  return (
    theme !== null &&
    typeof theme === "object" &&
    !Array.isArray(theme) &&
    Array.isArray(theme.palette) &&
    theme.palette.length > 0 &&
    theme.palette.every((c) => typeof c === "string")
  );
}

let repairIdSeq = 0;

/** Recursively repair one node; collects ids so arrows/summaries can be checked. */
function repairNode(node, usedIds) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    const fallbackId = "n" + ++repairIdSeq;
    usedIds.push(fallbackId);
    return { id: fallbackId, topic: "（未命名）", expanded: true, children: [] };
  }
  const out = { ...node };
  if (typeof out.topic !== "string") out.topic = out.topic === undefined || out.topic === null ? "" : String(out.topic);
  if (out.topic.length === 0) out.topic = "（未命名）";
  if (typeof out.id !== "string" || out.id.length === 0 || usedIds.includes(out.id)) {
    let candidate;
    do { candidate = "n" + ++repairIdSeq; } while (usedIds.includes(candidate));
    out.id = candidate;
  }
  if (out.state !== undefined && !NODE_STATES.includes(out.state)) delete out.state;
  usedIds.push(out.id);
  const rawChildren = Array.isArray(out.children) ? out.children : [];
  out.children = [];
  for (const child of rawChildren) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      out.children.push(repairNode(child, usedIds));
    }
  }
  return out;
}

/**
 * Deep-repair a structurally-valid MindElixirData into the exact shape the
 * kernel assumes. Models omit `children` on leaves, invent partial themes,
 * or leave arrows pointing at removed nodes — all of which crash rendering
 * instead of failing softly. Repaired values are PERSISTED, so bad writes
 * self-heal at the source; the client sanitizer only exists for older history.
 * @param {object} value - tree past the basic structural checks.
 * @returns {object} repaired MindElixirData.
 */
function repairTree(value) {
  const usedIds = [];
  const out = { ...value, nodeData: repairNode(value.nodeData, usedIds) };
  const exists = (id) => usedIds.includes(id);
  const arrows = Array.isArray(value.arrows) ? value.arrows : [];
  out.arrows = arrows.filter(
    (a) => a && typeof a === "object" && !Array.isArray(a) &&
      typeof a.from === "string" && exists(a.from) &&
      typeof a.to === "string" && exists(a.to)
  );
  const summaries = Array.isArray(value.summaries) ? value.summaries : [];
  out.summaries = summaries.filter(
    (s) => s && typeof s === "object" && !Array.isArray(s) &&
      typeof s.parent === "string" && exists(s.parent) &&
      typeof s.start === "number" && typeof s.end === "number"
  );
  if (out.theme !== undefined) {
    if (usableTheme(out.theme)) {
      // Renderer hooks are functions in-process but can never survive JSON;
      // a string here would be invoked as a function by changeTheme. Strip them.
      const { generateMainBranch, generateSubBranch, ...rest } = out.theme;
      void generateMainBranch; void generateSubBranch;
      out.theme = rest;
    } else {
      delete out.theme;
    }
  }
  if (out.direction !== undefined && ![0, 1, 2, 3].includes(out.direction)) delete out.direction;
  return out;
}

/**
 * Normalize whatever the caller sent into a renderable MindElixirData object.
 * Models frequently stringify the tree before sending it; accept that, then
 * enforce the one structural invariant the kernel needs (`nodeData` object)
 * and deep-repair everything else (see repairTree).
 * @param {*} tree - raw tree argument from RPC payload or tool call.
 * @returns {object} normalized MindElixirData.
 * @throws {Error} with an actionable message when the value cannot be used.
 */
function normalizeTree(tree) {
  let value = tree;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      throw new Error("tree was a string but not valid JSON — send the tree as a JSON object (MindElixirData), not a quoted/escaped string");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tree must be a MindElixirData object like { nodeData: { id, topic, children }, arrows: [], summaries: [], direction }");
  }
  if (value.nodeData === null || typeof value.nodeData !== "object" || Array.isArray(value.nodeData)) {
    throw new Error("tree.nodeData is missing — the root node object is required ({ nodeData: { id, topic, children } })");
  }
  return repairTree(value);
}


/**
 * Reject any request that did not come from a loopback socket with a
 * loopback Host/Origin pair. The canvas is same-origin, so a browser push
 * always carries a matching Origin.
 */
/** Session id under any of the names a live session object may use. */
function sessionIdOf(session) {
  const id = session?.id ?? session?.sessionId ?? session?.descriptor?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

/** First value that looks like an absolute path. */
function pickAbsPath(...candidates) {
  for (const value of candidates) {
    if (typeof value === "string" && value.startsWith("/") && value.length > 1) return value;
  }
  return null;
}

/** Pull a working directory out of a session event, whatever shape it has. */
function workingDirectoryOfEvent(event) {
  if (!event || typeof event !== "object") return null;
  const data = event.data && typeof event.data === "object" ? event.data : null;
  const top = pickAbsPath(event.workingDirectory, event.cwd);
  if (top) return top;
  const nested = data === null ? null : pickAbsPath(data.workingDirectory, data.cwd);
  if (nested) return nested;
  const rowKey = event.row !== undefined ? event.row
    : event.key !== undefined ? event.key
      : event.name !== undefined ? event.name
        : data === null ? undefined : (data.row !== undefined ? data.row : (data.key !== undefined ? data.key : data.name));
  if (rowKey === "workingDirectory" || rowKey === "cwd") {
    return pickAbsPath(event.value, data === null ? undefined : data.value);
  }
  return null;
}

/** Projection-cache file for one session, under either id spelling. */
function sessionCachePath(home, sessionId) {
  const dir = path.join(home, "storages", "session_projcache", "sessions");
  const direct = path.join(dir, `${sessionId}.json`);
  if (fs.existsSync(direct)) return direct;
  const bare = sessionId.replace(/^session-/, "");
  const alt = path.join(dir, `session-${bare}.json`);
  return fs.existsSync(alt) ? alt : direct;
}

/** Last resort: read the persisted projection row straight off disk. */
function workspaceFromDisk(sessionId) {
  const home = process.env.DSH_HOME ? process.env.DSH_HOME : path.join(os.homedir(), ".dsh");
  try {
    const raw = fs.readFileSync(sessionCachePath(home, sessionId), "utf8");
    const record = JSON.parse(raw)?.record;
    // `identity.cwd` is written once at session creation and has never been
    // missing; the projection row is the newer, more specific spelling.
    return pickAbsPath(record?.rows?.workingDirectory?.val, record?.identity?.cwd);
  } catch {
    return null;
  }
}

/**
 * Absolute workspace path a session belongs to. Tries the live session object,
 * then its event stream, then the persisted projection row, and only then the
 * process directory — a wrong answer here would write maps into the wrong
 * project, so every cheap source is exhausted first.
 * @param session - live session object (may be undefined).
 * @param sessionId - session id used for disk lookups.
 * @returns {string|null} absolute path.
 */
function workspaceOfSession(session, sessionId) {
  const direct = pickAbsPath(
    session?.cwd,
    session?.workingDirectory,
    session?.identity?.cwd,
    session?.identity?.workingDirectory,
    session?.meta?.cwd
  );
  if (direct) return direct;
  let fromEvents = null;
  try {
    const events = typeof session?.snapshotEvents === "function"
      ? session.snapshotEvents()
      : Array.isArray(session?.events) ? session.events : [];
    for (const event of events) {
      const found = workingDirectoryOfEvent(event);
      if (found) fromEvents = found;
    }
  } catch {
    // A session whose event stream cannot be read falls through to disk.
  }
  if (fromEvents) return fromEvents;
  if (typeof sessionId === "string") {
    const fromDisk = workspaceFromDisk(sessionId);
    if (fromDisk) return fromDisk;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Map documents on disk
// ---------------------------------------------------------------------------

/** `<workspace>/.dsh/mindmaps` */
function mapDirOf(workspace) {
  return path.join(workspace, MAP_DIR_REL);
}

/** `<workspace>/.dsh/mindmaps/<id>.json` */
function mapFileOf(workspace, mapId) {
  return path.join(mapDirOf(workspace), `${mapId}.json`);
}

/** Parse a map id from anything the caller sent; throws when unsafe. */
function normalizeMapId(raw, fallback = DEFAULT_MAP_ID) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const id = String(raw).trim();
  const bad = id.length === 0
    || id.length > MAP_ID_MAX
    || id.startsWith(".")
    || !MAP_ID_RE.test(id);
  if (bad) {
    throw new Error(`mapId must be 1-${MAP_ID_MAX} characters, must not start with a dot, and must not contain path separators or control characters (got ${JSON.stringify(raw)})`);
  }
  return id;
}

/** Empty canvas handed to a workspace that has never drawn a map. */
function blankMindMap(topic = "中心主题") {
  let seq = 0;
  const nextId = () => `n-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return {
    nodeData: {
      id: nextId(),
      topic,
      expanded: true,
      children: [
        { id: nextId(), topic: "分支 1", expanded: true, children: [] },
        { id: nextId(), topic: "分支 2", expanded: true, children: [] }
      ]
    },
    arrows: [],
    summaries: [],
    direction: 2
  };
}

/** Structural comparison that ignores nothing but ordering of object keys. */
function sameTree(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Read one map document.
 * @returns {{version:number,id:string,title:string,createdAt?:string,updatedAt?:string,tree:object}|null}
 *   `null` when the file is absent or unreadable.
 */
function readMapDoc(workspace, mapId) {
  let raw;
  try {
    raw = fs.readFileSync(mapFileOf(workspace, mapId), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  let tree;
  try {
    tree = normalizeTree(parsed.tree);
  } catch {
    return null;
  }
  return {
    version: MAP_FILE_VERSION,
    id: mapId,
    title: typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : mapId,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    tree
  };
}

/**
 * Atomically persist one map document. Written through a temp file + rename so
 * a half-written canvas can never be read back as the truth.
 * @returns {object} the document as written.
 */
function writeMapDoc(workspace, mapId, tree, title) {
  const dir = mapDirOf(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const previous = readMapDoc(workspace, mapId);
  const now = new Date().toISOString();
  const doc = {
    version: MAP_FILE_VERSION,
    id: mapId,
    title: typeof title === "string" && title.trim().length > 0
      ? title.trim()
      : previous?.title ?? (mapId === DEFAULT_MAP_ID ? DEFAULT_MAP_TITLE : mapId),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    tree
  };
  const target = mapFileOf(workspace, mapId);
  const temp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return doc;
}

/** Every map document in a workspace, newest edit first. */
function listMapDocs(workspace) {
  let names;
  try {
    names = fs.readdirSync(mapDirOf(workspace));
  } catch {
    return [];
  }
  const out = [];
  for (const entry of names) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!MAP_ID_RE.test(id)) continue;
    const doc = readMapDoc(workspace, id);
    if (doc === null) continue;
    out.push({
      id: doc.id,
      title: doc.title,
      updatedAt: doc.updatedAt ?? null,
      createdAt: doc.createdAt ?? null
    });
  }
  out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return out;
}

// ---------------------------------------------------------------------------
// Session <-> map binding
// ---------------------------------------------------------------------------

/** Every mind map event of a session plus the map id it carried. */
function mindMapEventsOf(session) {
  let events = [];
  try {
    events = typeof session?.snapshotEvents === "function"
      ? session.snapshotEvents()
      : Array.isArray(session?.events) ? session.events : [];
  } catch {
    return [];
  }
  const out = [];
  for (const event of events) {
    const tree = mindmapTreeOf(event);
    if (tree === undefined) continue;
    let mapId;
    if (event.type === LEGACY_RECORD_TYPE) mapId = event.data?.mapId;
    else mapId = pluginRecordOf(event)?.data?.mapId;
    out.push({ tree, mapId: typeof mapId === "string" ? mapId : undefined });
  }
  return out;
}

/** The map a session is currently looking at, or `undefined` when unbound. */
function boundMapIdOf(session) {
  const events = mindMapEventsOf(session);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].mapId) return events[i].mapId;
  }
  return undefined;
}

/** Last tree the session log carries (migration source for older canvases). */
function lastTreeOfSession(session) {
  const events = mindMapEventsOf(session);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].tree !== null && events[i].tree !== undefined) return events[i].tree;
  }
  return null;
}

/**
 * Bind a session to its workspace map and mirror the file into the session's
 * projection.
 *
 * Three cases, all idempotent:
 *  - the workspace file exists          → file wins; the session catches up.
 *  - no file, but the session has a map → that tree is migrated into the file
 *    (this is what carries existing conversations over to the workspace store).
 *  - neither                            → an empty map is created and bound.
 *
 * @returns {{ok:true,value:object}|{ok:false,error:object}}
 */
function ensureSessionMap(ctx, sessionId) {
  // A session that is closed (or not mounted yet) still has a workspace on disk
  // (`record.identity.cwd`) and the map lives in that workspace, so reads keep
  // working without a live log. Only the projection catch-up needs one.
  const session = ctx.sessions.get(sessionId) ?? null;
  const workspace = workspaceOfSession(session, sessionId);
  if (workspace === null) {
    return { ok: false, error: { code: "no-workspace", message: "could not resolve the working directory of this session" } };
  }
  let mapId;
  try {
    mapId = normalizeMapId(boundMapIdOf(session));
  } catch {
    mapId = DEFAULT_MAP_ID;
  }
  const sessionTree = lastTreeOfSession(session);
  let doc = readMapDoc(workspace, mapId);
  if (doc === null) {
    if (sessionTree === null) {
      // Nothing on disk and nothing in the log: leave the session empty so the
      // tab can offer 创建/导入. The file appears the moment the canvas writes.
      return {
        ok: true,
        value: { mapId, title: null, workspace, updatedAt: null, tree: null, maps: listMapDocs(workspace) }
      };
    }
    doc = writeMapDoc(workspace, mapId, normalizeTree(sessionTree), undefined);
  } else if (session !== null && (sessionTree === null || !sameTree(sessionTree, doc.tree))) {
    // The file is the truth source: pull the session's projection forward.
    appendPluginRecord(session, RECORD_TYPE, { tree: doc.tree, mapId });
  }
  return {
    ok: true,
    value: {
      mapId: doc.id,
      title: doc.title,
      workspace,
      updatedAt: doc.updatedAt ?? null,
      tree: doc.tree,
      maps: listMapDocs(workspace)
    }
  };
}

// ---------------------------------------------------------------------------
// Requirement export
// ---------------------------------------------------------------------------

/** Pick a file-safe slug from a user title, keeping CJK intact. */
function slugifyTitle(title, fallback) {
  const cleaned = String(title ?? "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Render a tree as a requirement document.
 *
 * Plain-language rule: the tree's structure is the outline, every node's `note`
 * is the requirement detail under it, and numbering (`1.2.3`) gives each node a
 * stable handle the spec, the commits and the acceptance run can all cite.
 * Nodes without a note still appear — an unwritten requirement is information.
 */
function specMarkdownOf(doc) {
  const lines = [];
  const title = doc.title ?? doc.id;
  const exportTime = new Date().toLocaleString("zh-CN", { hour12: false });
  lines.push(`# ${title}`, "");
  lines.push(`> 由思维导图导出 · ${exportTime}`);
  lines.push(`> 来源：\`.dsh/mindmaps/${doc.id}.json\``, "");

  let requirementCount = 0;
  const stateCounts = Object.create(null);
  const walk = (node, depth, prefix) => {
    const topic = typeof node.topic === "string" && node.topic.length > 0 ? node.topic : "（未命名）";
    const note = typeof node.note === "string" ? node.note.trim() : "";
    const state = NODE_STATES.includes(node.state) ? node.state : null;
    if (depth > 0) {
      requirementCount += 1;
      if (state !== null) stateCounts[state] = (stateCounts[state] ?? 0) + 1;
      const heading = "#".repeat(Math.min(depth + 1, 6));
      const badge = state === "done" ? " ✅" : state === "dropped" ? " ⛔" : state === "doing" ? " 🚧" : state === "todo" ? " ⬜" : "";
      const shown = state === "done" || state === "dropped" ? `~~${topic}~~` : topic;
      lines.push(`${heading} ${prefix} ${shown}${badge}`.trim(), "");
      if (note.length > 0) lines.push(note, "");
    }
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child) => {
      const index = children.indexOf(child);
      const number = depth === 0 ? `${index + 1}` : `${prefix}.${index + 1}`;
      walk(child, depth + 1, number);
    });
  };
  walk(doc.tree.nodeData, 0, "0");

  if (requirementCount === 0) {
    lines.push("_这张导图还没有分支：先加几个节点，再导出。_", "");
  }
  lines.push("---", "", `共 ${requirementCount} 个节点。每个节点下方若出现段落，即该节点的标注（需求细节 / 验收标准）。`, "");
  const order = NODE_STATES.filter((key) => stateCounts[key]);
  if (order.length > 0) {
    lines.push(`状态分布：${order.map((key) => `${NODE_STATE_LABELS[key]} ${stateCounts[key]}`).join(" / ")}`, "");
  }
  return lines.join("\n");
}

/** Depth-first walk over nodeData; `fn` runs on every node including the root. */
function forEachNode(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) forEachNode(child, fn);
}

/** Count nodes per lifecycle state across a whole tree. */
function countStates(tree) {
  const counts = Object.create(null);
  forEachNode(tree?.nodeData, (node) => {
    if (NODE_STATES.includes(node.state)) counts[node.state] = (counts[node.state] ?? 0) + 1;
  });
  return counts;
}

/** One-line "待办 3 / 进行中 1" rendering of a state histogram. */
function formatStateCounts(counts) {
  const parts = NODE_STATES.filter((key) => counts && counts[key]).map((key) => `${NODE_STATE_LABELS[key]} ${counts[key]}`);
  return parts.length > 0 ? parts.join(" / ") : "无";
}

/**
 * Write the requirement document next to the map.
 * @returns {{ok:true,value:{path:string,mapId:string,bytes:number}}|{ok:false,error:object}}
 */
function exportSpec(ctx, sessionId, rawMapId) {
  const bound = ensureSessionMap(ctx, sessionId);
  if (bound.ok === false) return bound;
  const workspace = bound.value.workspace;
  let mapId;
  try {
    mapId = normalizeMapId(rawMapId ?? bound.value.mapId);
  } catch (e) {
    return { ok: false, error: { code: "bad-request", message: e.message } };
  }
  const doc = readMapDoc(workspace, mapId);
  if (doc === null) {
    return { ok: false, error: { code: "empty", message: "这张导图还没有内容，先画点东西再导出" } };
  }
  const markdown = specMarkdownOf(doc);
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > MAX_EXPORT_BYTES) {
    return { ok: false, error: { code: "too-large", message: `spec would be ${bytes} bytes (limit ${MAX_EXPORT_BYTES})` } };
  }
  const dir = path.join(workspace, SPEC_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${slugifyTitle(doc.title, mapId)}.md`);
  fs.writeFileSync(target, markdown, "utf8");
  return { ok: true, value: { path: target, mapId, bytes } };
}

// ---------------------------------------------------------------------------
// Task list (L3+): what the agent should do next, one line per marked node
// ---------------------------------------------------------------------------

/**
 * Walk the tree and keep every node carrying a lifecycle state. The numbering
 * mirrors the spec export (`1`, `1.1`, ...) so a task line can be traced back
 * to the requirement document the user read.
 */
function walkTaskNodes(node, depth, prefix, rows) {
  const children = Array.isArray(node.children) ? node.children : [];
  children.forEach((child, index) => {
    const no = prefix.length > 0 ? `${prefix}.${index + 1}` : String(index + 1);
    const state = NODE_STATES.includes(child.state) ? child.state : null;
    if (state !== null) {
      rows.push({
        id: child.id,
        no,
        topic: String(child.topic ?? ""),
        state,
        note: typeof child.note === "string" && child.note.length > 0 ? child.note : null,
        depth
      });
    }
    walkTaskNodes(child, depth + 1, no, rows);
  });
  return rows;
}

function taskRowsOf(doc) {
  const rows = [];
  walkTaskNodes(doc.tree.nodeData, 0, "", rows);
  const open = rows.filter((row) => row.state === "todo" || row.state === "doing");
  const done = rows.filter((row) => row.state === "done");
  const ideas = rows.filter((row) => row.state === "idea");
  return { rows, open, done, ideas };
}

function taskLine(row, checked) {
  const lines = [`- [${checked ? "x" : " "}] **${row.no} ${row.topic}** \`${row.id}\``];
  if (row.note !== null) {
    for (const piece of row.note.split("\n")) {
      lines.push(`  > ${piece}`);
    }
  }
  return lines.join("\n");
}

function tasksMarkdownOf(doc) {
  const title = doc.title ?? doc.id;
  const exportTime = new Date().toLocaleString("zh-CN", { hour12: false });
  const { rows, open, done, ideas } = taskRowsOf(doc);
  const lines = [];
  lines.push(`# 任务清单 · ${title}`, "");
  lines.push(`> 由思维导图导出 · ${exportTime}`);
  lines.push(`> 来源：\`.dsh/mindmaps/${doc.id}.json\``);
  lines.push("> 用法：逐条实现；每完成一条，调用 mindmap_mark 把反引号里的节点 id 标成 done。", "");

  if (open.length > 0) {
    lines.push("## 待办 / 进行中", "");
    for (const row of open) lines.push(taskLine(row, false), "");
  } else {
    lines.push("## 待办 / 进行中", "", "_没有标成待办或进行中的节点。_", "");
  }

  if (done.length > 0) {
    lines.push("## 已完成", "");
    for (const row of done) lines.push(taskLine(row, true), "");
  }

  if (ideas.length > 0) {
    lines.push("## 想法（尚未确认）", "");
    for (const row of ideas) lines.push(taskLine(row, false), "");
  }

  lines.push("---", "");
  lines.push(`共 ${rows.length} 个已标记节点。状态分布：${formatStateCounts(countStates(doc.tree))}`);
  return lines.join("\n");
}

function tasksJsonOf(doc) {
  const { rows } = taskRowsOf(doc);
  return {
    version: 1,
    map: doc.id,
    title: doc.title ?? doc.id,
    exportedAt: new Date().toISOString(),
    source: `.dsh/mindmaps/${doc.id}.json`,
    tasks: rows.map((row) => ({
      id: row.id,
      no: row.no,
      topic: row.topic,
      state: row.state,
      note: row.note
    }))
  };
}

function exportTasks(ctx, sessionId, rawMapId) {
  const bound = ensureSessionMap(ctx, sessionId);
  if (bound.ok === false) return bound;
  const workspace = bound.value.workspace;
  let mapId;
  try {
    mapId = normalizeMapId(rawMapId ?? bound.value.mapId);
  } catch (e) {
    return { ok: false, error: { code: "bad-request", message: e.message } };
  }
  const doc = readMapDoc(workspace, mapId);
  if (doc === null) {
    return { ok: false, error: { code: "empty", message: "这张导图还没有内容，先画点东西再导出" } };
  }
  const { rows } = taskRowsOf(doc);
  if (rows.length === 0) {
    return {
      ok: false,
      error: { code: "no-tasks", message: "还没有节点带状态：选中节点按 2 标成待办再试" }
    };
  }
  const markdown = tasksMarkdownOf(doc);
  const json = `${JSON.stringify(tasksJsonOf(doc), null, 2)}\n`;
  const bytes = Buffer.byteLength(markdown, "utf8") + Buffer.byteLength(json, "utf8");
  if (bytes > MAX_EXPORT_BYTES) {
    return { ok: false, error: { code: "too-large", message: `tasks would be ${bytes} bytes (limit ${MAX_EXPORT_BYTES})` } };
  }
  const slug = slugifyTitle(doc.title, mapId);
  const dir = path.join(workspace, TASKS_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `${slug}.md`);
  const jsonPath = path.join(dir, `${slug}.json`);
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(jsonPath, json, "utf8");
  return { ok: true, value: { path: mdPath, jsonPath, mapId, count: rows.length, bytes } };
}

// ---------------------------------------------------------------------------
// Map management (L2): create / switch / rename / delete inside a workspace
// ---------------------------------------------------------------------------

/** A title the user typed, trimmed and length-capped; null when unusable. */
function normalizeMapTitle(raw) {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, 80);
  return title.length > 0 ? title : null;
}

/** Derive a free `mapId` from a title, appending -2, -3 … until it is unused. */
function uniqueMapId(workspace, base) {
  let stem;
  try {
    stem = normalizeMapId(slugifyTitle(base, "map"));
  } catch {
    stem = "map";
  }
  const taken = new Set();
  try {
    for (const entry of fs.readdirSync(mapDirOf(workspace))) {
      if (entry.endsWith(".json")) taken.add(entry.slice(0, -5));
    }
  } catch {
    // No directory yet: every id is free.
  }
  if (!taken.has(stem)) return stem;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${stem.slice(0, MAP_ID_MAX - 4)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `map-${Date.now().toString(36)}`;
}

/** The envelope every map-management action returns (same shape as `/state`). */
function mapStateOf(workspace, doc) {
  return {
    mapId: doc === null ? null : doc.id,
    title: doc === null ? null : doc.title,
    workspace,
    updatedAt: doc === null ? null : (doc.updatedAt ?? null),
    tree: doc === null ? null : doc.tree,
    maps: listMapDocs(workspace)
  };
}

/** Mirror one map into the session log so every client repaints from it. */
function bindSessionToDoc(session, doc) {
  if (session === null || doc === null) return;
  appendPluginRecord(session, RECORD_TYPE, { tree: doc.tree, mapId: doc.id });
}

/**
 * Create, switch, rename or delete a workspace map.
 *
 * Every action returns the same envelope the tab already renders, so the client
 * never has to recompute state: it swaps the canvas for `value.tree` and the
 * picker for `value.maps`.
 */
function manageMaps(ctx, sessionId, action, payload) {
  const session = ctx.sessions.get(sessionId) ?? null;
  const workspace = workspaceOfSession(session, sessionId);
  if (workspace === null) {
    return { ok: false, error: { code: "no-workspace", message: "could not resolve the working directory of this session" } };
  }
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const readId = () => {
    try {
      return { mapId: normalizeMapId(payload?.mapId) };
    } catch (e) {
      return { error: e.message };
    }
  };

  if (action === "create") {
    const title = normalizeMapTitle(payload?.title) ?? "新导图";
    const mapId = uniqueMapId(workspace, title);
    let doc;
    try {
      doc = writeMapDoc(workspace, mapId, blankMindMap(title), title);
    } catch (e) {
      return fail("write-failed", String(e && e.message ? e.message : e));
    }
    bindSessionToDoc(session, doc);
    return { ok: true, value: mapStateOf(workspace, doc) };
  }

  if (action === "switch") {
    const id = readId();
    if (id.error) return fail("bad-request", id.error);
    const doc = readMapDoc(workspace, id.mapId);
    if (doc === null) return fail("not-found", `map ${id.mapId} does not exist`);
    bindSessionToDoc(session, doc);
    return { ok: true, value: mapStateOf(workspace, doc) };
  }

  if (action === "rename") {
    const id = readId();
    if (id.error) return fail("bad-request", id.error);
    const doc = readMapDoc(workspace, id.mapId);
    if (doc === null) return fail("not-found", `map ${id.mapId} does not exist`);
    const title = normalizeMapTitle(payload?.title);
    if (title === null) return fail("bad-request", "title is required");
    let next;
    try {
      next = writeMapDoc(workspace, id.mapId, doc.tree, title);
    } catch (e) {
      return fail("write-failed", String(e && e.message ? e.message : e));
    }
    return { ok: true, value: mapStateOf(workspace, next) };
  }

  if (action === "delete") {
    const id = readId();
    if (id.error) return fail("bad-request", id.error);
    if (readMapDoc(workspace, id.mapId) === null) return fail("not-found", `map ${id.mapId} does not exist`);
    let bound = DEFAULT_MAP_ID;
    try {
      bound = normalizeMapId(boundMapIdOf(session));
    } catch {
      bound = DEFAULT_MAP_ID;
    }
    // Deleting the last map would leave the session's projection pointing at a
    // file that no longer exists, and the next read would migrate the old tree
    // straight back onto disk. Refuse instead of resurrecting it.
    if (listMapDocs(workspace).length <= 1) {
      return fail("last-map", "至少保留一张导图");
    }
    try {
      fs.unlinkSync(mapFileOf(workspace, id.mapId));
    } catch (e) {
      return fail("delete-failed", String(e && e.message ? e.message : e));
    }
    if (id.mapId !== bound) {
      const current = readMapDoc(workspace, bound);
      return { ok: true, value: mapStateOf(workspace, current) };
    }
    const rest = listMapDocs(workspace);
    const fallback = rest.length > 0 ? readMapDoc(workspace, rest[0].id) : null;
    bindSessionToDoc(session, fallback);
    return { ok: true, value: mapStateOf(workspace, fallback) };
  }

  return fail("bad-request", `unknown action ${JSON.stringify(action)}`);
}

/**
 * Once a task list has been exported, keep it in step with the map: every later
 * write (a new node, a state flipped with 1-5, an agent calling mindmap_mark)
 * re-renders the same two files. Nothing is created for maps that were never
 * exported — the user opted in by clicking the button once.
 */
function refreshTasksIfAny(workspace, doc) {
  const slug = slugifyTitle(doc.title ?? doc.id, doc.id);
  const dir = path.join(workspace, TASKS_DIR_REL);
  const jsonPath = path.join(dir, `${slug}.json`);
  if (!fs.existsSync(jsonPath)) return false;
  const markdown = tasksMarkdownOf(doc);
  if (Buffer.byteLength(markdown, "utf8") > MAX_EXPORT_BYTES) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.md`), markdown, "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(tasksJsonOf(doc), null, 2)}\n`, "utf8");
  return true;
}

function isLoopbackPush(req) {
  const address = String(req.socket && req.socket.remoteAddress || "");
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (bare !== "127.0.0.1" && bare !== "::1") return false;
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = String(req.headers.origin || "");
  if (origin === "") return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_PUSH_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/**
 * Persist one canvas push: the workspace file is written first (it is the
 * truth source), then the session log records the same tree so the projection
 * and every other client in this session move with it.
 * @returns {{ok:true,value:object}|{ok:false,error:object}} envelope.
 */
function pushResult(ctx, payload) {
  const sessionId = payload?.sessionId;
  const tree = payload?.tree;
  if (typeof sessionId !== "string" || tree === void 0 || tree === null) {
    return { ok: false, error: { code: "bad-request", message: "payload requires sessionId and tree" } };
  }
  let normalized;
  let mapId;
  try {
    normalized = normalizeTree(tree);
  } catch (e) {
    return { ok: false, error: { code: "bad-request", message: e.message } };
  }
  const session = ctx.sessions.get(sessionId);
  if (session === void 0) {
    return { ok: false, error: { code: "not-found", message: `session ${sessionId} is not live` } };
  }
  const workspace = workspaceOfSession(session, sessionId);
  if (workspace === null) {
    return { ok: false, error: { code: "no-workspace", message: "could not resolve the working directory of this session" } };
  }
  try {
    mapId = normalizeMapId(payload?.mapId ?? boundMapIdOf(session));
  } catch (e) {
    return { ok: false, error: { code: "bad-request", message: e.message } };
  }
  let doc;
  try {
    doc = writeMapDoc(
      workspace,
      mapId,
      normalized,
      typeof payload?.title === "string" ? payload.title : undefined
    );
  } catch (e) {
    return { ok: false, error: { code: "write-failed", message: String(e && e.message ? e.message : e) } };
  }
  appendPluginRecord(session, RECORD_TYPE, { tree: doc.tree, mapId: doc.id });
  try {
    refreshTasksIfAny(workspace, doc);
  } catch (e) {
    console.error("[dsh-mindmap-mine] task list refresh failed", e);
  }
  return {
    ok: true,
    value: { accepted: true, mapId: doc.id, title: doc.title, updatedAt: doc.updatedAt }
  };
}

/** Read the JSON body of a push request. */
async function readPushBody(req, res) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    sendText(res, 415, "content type must be application/json");
    return undefined;
  }
  try {
    return await readJsonBody(req);
  } catch {
    sendText(res, 400, "body is not JSON");
    return undefined;
  }
}

/** `POST /mindmap/update` — canvas push (client-request envelope, as before). */
async function handleUpdate(ctx, req, res) {
  const body = await readPushBody(req, res);
  if (body === undefined) return;
  const rpcId = typeof body?.rpcId === "string" ? body.rpcId : "00000000-0000-0000-0000-000000000000";
  if (body === null || typeof body !== "object" || body.type !== "client-request" || body.method !== RPC_ENDPOINT) {
    sendJson(res, 200, { type: "server-response", rpcId, result: { ok: false, error: { code: "gateway/bad-request", message: "invalid client-request message", details: { issues: [] } } } });
    return;
  }
  let result;
  try {
    result = pushResult(ctx, body.payload);
  } catch (e) {
    sendText(res, 500, `handler failure: ${String(e)}`);
    return;
  }
  sendJson(res, 200, { type: "server-response", rpcId, result });
}

/** `GET /mindmap/state?sessionId=` — bind the session and mirror the file in. */
function handleState(ctx, req, res, searchParams) {
  const sessionId = searchParams.get("sessionId");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 400, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
    return;
  }
  let result;
  try {
    result = ensureSessionMap(ctx, sessionId);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: { code: "state-failed", message: String(e && e.message ? e.message : e) } });
    return;
  }
  sendJson(res, 200, result);
}

/** `POST /mindmap/export` — write `specs/<title>.md` from the current map. */
async function handleExport(ctx, req, res) {
  const body = await readPushBody(req, res);
  if (body === undefined) return;
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 400, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
    return;
  }
  let result;
  try {
    result = exportSpec(ctx, sessionId, body?.mapId);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: { code: "export-failed", message: String(e && e.message ? e.message : e) } });
    return;
  }
  sendJson(res, 200, result);
}

/**
 * `POST /mindmap/maps` — create / switch / rename / delete a workspace map.
 *
 * Body: `{ sessionId, action, mapId?, title? }`. The reply is the same envelope
 * `/mindmap/state` returns, so a client can replace both canvas and picker from
 * one response.
 */
async function handleTasks(ctx, req, res) {
  const body = await readPushBody(req, res);
  if (body === undefined) return;
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 400, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
    return;
  }
  let result;
  try {
    result = exportTasks(ctx, sessionId, body?.mapId);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: { code: "tasks-failed", message: String(e && e.message ? e.message : e) } });
    return;
  }
  sendJson(res, 200, result);
}

async function handleMaps(ctx, req, res) {
  const body = await readPushBody(req, res);
  if (body === undefined) return;
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    sendJson(res, 400, { ok: false, error: { code: "bad-request", message: "sessionId is required" } });
    return;
  }
  let result;
  try {
    result = manageMaps(ctx, sessionId, body?.action, body);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: { code: "maps-failed", message: String(e && e.message ? e.message : e) } });
    return;
  }
  sendJson(res, 200, result);
}

/**
 * Route every request under the plugin's own channel.
 *
 * Loopback only: the canvas is same-origin, so a browser request always carries
 * a matching Origin and a loopback Host. Anything else is refused before a
 * single filesystem call happens.
 */
async function handleRoute(ctx, req, res) {
  const url = String(req.url || "");
  const pathname = url.split("?")[0];
  if (pathname !== RPC_CHANNEL && !pathname.startsWith(`${RPC_CHANNEL}/`)) {
    sendText(res, 404, "not found");
    return;
  }
  if (!isLoopbackPush(req)) {
    sendText(res, 403, "forbidden");
    return;
  }
  const searchParams = new URL(url, "http://127.0.0.1").searchParams;
  if (req.method === "GET" && pathname === `${RPC_CHANNEL}/state`) {
    handleState(ctx, req, res, searchParams);
    return;
  }
  if (req.method === "POST" && pathname === `${RPC_CHANNEL}/${RPC_ENDPOINT}`) {
    await handleUpdate(ctx, req, res);
    return;
  }
  if (req.method === "POST" && pathname === `${RPC_CHANNEL}/export`) {
    await handleExport(ctx, req, res);
    return;
  }
  if (req.method === "POST" && pathname === `${RPC_CHANNEL}/tasks`) {
    await handleTasks(ctx, req, res);
    return;
  }
  if (req.method === "POST" && pathname === `${RPC_CHANNEL}/maps`) {
    await handleMaps(ctx, req, res);
    return;
  }
  sendText(res, 404, "not found");
}

function apply(ctx) {
  // Session projection: whole-value last-write-wins over the mind map record.
  // The `wire` block makes the unit client-visible: without it the registry
  // drives the unit but never serves its value in snapshots.
  ctx.inject(["sessionProjections"], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateSchema: mindmapProjectionSchema,
      init: () => null,
      apply: (state, event) => {
        const tree = mindmapTreeOf(event);
        return tree === undefined ? state : tree;
      },
      wire: {
        viewSchema: mindmapProjectionSchema,
        view: (state) => state
      },
      stateVersion: 1
    });
  });

  // Client -> host RPC: the browser canvas pushes user edits here, which
  // appends a mind map plugin record to the owning session log.
  // Registered straight on the web server as a loopback-only JSON endpoint
  // (`POST /mindmap/update`): the Connection channel API this release ships
  // (`connection.rpc.handle`) resolves the channel owner against a context
  // that cannot read `webServer`, so the route is mounted directly instead.
  ctx.inject(["sessions", "webServer"], (netCtx) => {
    netCtx.effect(() => netCtx.webServer.register({
      kind: "prefix",
      path: RPC_CHANNEL,
      handler: (req, res) => { void handleRoute(netCtx, req, res); }
    }), `dsh-mindmap-mine: ${RPC_CHANNEL} rpc channel`);
  });

  // Model-facing tools: read and rewrite the whole mind map.
  ctx.tools.register(defineTool({
    name: "mindmap_live_get",
    description: "Read the current mind map tree (MindElixirData) for the owning session. Returns null when no mind map has been created yet. Use this before mindmap_live_set so you know what is already on the canvas. Any node may carry a `note` string — the long-form annotation the user attached to that node (rendered as a badge next to the topic, not as topic text). Treat `note` as the requirement detail for that node; keep it when you rewrite the tree.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tree: { type: "json", description: "The current MindElixirData tree, or null." },
          mapId: { type: "json", description: "Workspace map id the tree belongs to." },
          title: { type: "json", description: "Map title, or null." },
          path: { type: "json", description: "Absolute path of the workspace map file, or null." }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.tree
          ? "当前思维导图（JSON，节点上的 `note` 是该节点的标注/需求细节，改树时必须原样带回来）：\n"
            + JSON.stringify(value.tree, null, 2)
            + (value.path ? "\n\n工作区文件：" + value.path : "")
          : "当前思维导图为空。"
      }]
    },
    execute(_args, exec) {
      const session = exec.agent?.session;
      if (!session) throw new Error("mindmap_live_get requires an owning agent session");
      const sessionId = sessionIdOf(session);
      const workspace = workspaceOfSession(session, sessionId);
      let mapId = DEFAULT_MAP_ID;
      try {
        mapId = normalizeMapId(boundMapIdOf(session));
      } catch {
        mapId = DEFAULT_MAP_ID;
      }
      if (workspace !== null) {
        const doc = readMapDoc(workspace, mapId);
        if (doc !== null) return Promise.resolve({ tree: doc.tree, mapId: doc.id, title: doc.title, path: mapFileOf(workspace, doc.id) });
        // No file yet: seed it from the session log so the canvas and the
        // workspace document start out identical.
        const legacy = lastTreeOfSession(session);
        if (legacy !== null) {
          const written = writeMapDoc(workspace, mapId, legacy, undefined);
          return Promise.resolve({ tree: written.tree, mapId: written.id, title: written.title, path: mapFileOf(workspace, written.id) });
        }
        return Promise.resolve({ tree: null, mapId, title: null, path: null });
      }
      return Promise.resolve({ tree: lastTreeOfSession(session), mapId, title: null, path: null });
    }
  }));

  ctx.tools.register(defineTool({
    name: "mindmap_live_set",
    description: [
      "Replace the ENTIRE mind map tree for the owning session. Send the COMPLETE tree every call — it REPLACES the previous map (no partial updates). Call mindmap_live_get first to see the current tree.",
      "Exact shape (plain JSON object, NOT a string, no markdown fences):",
      '{"nodeData":{"id":"n0","topic":"中心主题","expanded":true,"children":[{"id":"n1","topic":"分支一","children":[]},{"id":"n2","topic":"分支二","children":[]}]},"arrows":[],"summaries":[],"direction":2}',
      "Hard rules:",
      "1. EVERY node is an object with: string topic (non-empty), array children (MUST be present, [] for leaves), unique string id. Omitting children is the #1 rendering failure.",
      "2. arrows and summaries: keep [] unless the user asks for cross-links/summaries; entries must reference existing node ids.",
      "3. direction: 2 = both sides of the root (default, recommended), 1 = all left, 0 = all right.",
      "4. Valid JSON only: no comments, no trailing commas, no functions.",
      "5. Optional per node: `note` (string) — long-form annotation/requirement detail for that node. Preserve existing notes verbatim; add one when the user wants detail that would clutter the topic itself."
    ].join("\n"),
    parameters: {
      tree: {
        type: "json",
        required: true,
        description: "The complete MindElixirData object per the shape in the tool description: { nodeData: { id, topic, expanded, children: [] }, arrows: [], summaries: [], direction }."
      },
      map: {
        type: "string",
        description: "Optional workspace map id to write (default: the map this session is already bound to, else `roadmap`)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string", description: "Failure reason; present only when ok is false." },
          mapId: { type: "json", description: "Map id that was written." },
          path: { type: "json", description: "Absolute path of the map file, or null." }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok ? "思维导图已更新。" : `思维导图更新失败：${value.error ?? "未知原因"}`
      }]
    },
    execute(args, exec) {
      const session = exec.agent?.session;
      if (!session) throw new Error("mindmap_live_set requires an owning agent session");
      let tree;
      try {
        tree = normalizeTree(args.tree);
      } catch (e) {
        return Promise.resolve({ ok: false, error: e.message });
      }
      let mapId;
      try {
        mapId = normalizeMapId(args.map ?? boundMapIdOf(session));
      } catch (e) {
        return Promise.resolve({ ok: false, error: e.message });
      }
      const sessionId = sessionIdOf(session);
      const workspace = workspaceOfSession(session, sessionId);
      if (workspace !== null) {
        try {
          const doc = writeMapDoc(workspace, mapId, tree, undefined);
          appendPluginRecord(session, RECORD_TYPE, { tree: doc.tree, mapId: doc.id });
          return Promise.resolve({ ok: true, mapId: doc.id, path: mapFileOf(workspace, doc.id) });
        } catch (e) {
          return Promise.resolve({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      }
      appendPluginRecord(session, RECORD_TYPE, { tree, mapId });
      return Promise.resolve({ ok: true, mapId });
    }
  }));

  // Target one node at a time: mark lifecycle state without resending the tree.
  ctx.tools.register(defineTool({
    name: "mindmap_mark",
    description: [
      "Set the lifecycle state of nodes on the current mind map WITHOUT rewriting the tree.",
      "States: \"idea\" (想法), \"todo\" (待办), \"doing\" (进行中), \"done\" (已完成), \"dropped\" (已废弃). Pass state: null to clear a mark.",
      "Call mindmap_live_get first to learn node ids. Use this to write back progress after you finish or verify a task — it costs one line per node instead of resending the whole tree."
    ].join("\n"),
    parameters: {
      marks: {
        type: "json",
        required: true,
        description: 'Array of {"id": "<node id>", "state": "done" | "doing" | "todo" | "idea" | "dropped" | null}.'
      },
      map: {
        type: "string",
        description: "Optional workspace map id to write (default: the map this session is already bound to, else `roadmap`)."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          error: { type: "string", description: "Failure reason; present only when ok is false." },
          updated: { type: "json", description: "Node ids that were marked." },
          missing: { type: "json", description: "Node ids that were not found in the tree." },
          counts: { type: "json", description: "State -> node count across the whole map." },
          mapId: { type: "json", description: "Map id that was written." },
          path: { type: "json", description: "Absolute path of the map file, or null." }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok
          ? `已标记 ${Array.isArray(value.updated) ? value.updated.length : 0} 个节点`
            + (Array.isArray(value.missing) && value.missing.length > 0 ? `；未找到：${value.missing.join(", ")}` : "")
            + `。当前分布：${formatStateCounts(value.counts)}`
          : `标记失败：${value.error ?? "未知原因"}`
      }]
    },
    execute(args, exec) {
      const session = exec.agent?.session;
      if (!session) throw new Error("mindmap_mark requires an owning agent session");
      const list = Array.isArray(args.marks) ? args.marks : null;
      if (!list || list.length === 0) return Promise.resolve({ ok: false, error: "marks 必须是非空数组" });
      let mapId;
      try {
        mapId = normalizeMapId(args.map ?? boundMapIdOf(session));
      } catch (e) {
        return Promise.resolve({ ok: false, error: e.message });
      }
      const sessionId = sessionIdOf(session);
      const workspace = workspaceOfSession(session, sessionId);
      if (workspace === null) return Promise.resolve({ ok: false, error: "无法确定当前工作区，导图没有落盘" });
      const doc = readMapDoc(workspace, mapId);
      if (doc === null) return Promise.resolve({ ok: false, error: `导图 ${mapId} 不存在` });
      const wanted = new Map();
      const invalid = [];
      for (const item of list) {
        const id = item && typeof item === "object" ? item.id : null;
        const state = item && typeof item === "object" ? item.state : undefined;
        if (typeof id !== "string" || id.length === 0) { invalid.push(String(id)); continue; }
        if (state !== null && state !== undefined && !NODE_STATES.includes(state)) { invalid.push(`${id}:${String(state)}`); continue; }
        wanted.set(id, state === undefined ? null : state);
      }
      if (invalid.length > 0) {
        return Promise.resolve({ ok: false, error: `无效的标记：${invalid.join(", ")}（state 只能是 ${NODE_STATES.join(" | ")} 或 null）` });
      }
      const updated = [];
      const seen = new Set();
      forEachNode(doc.tree.nodeData, (node) => {
        if (!wanted.has(node.id)) return;
        seen.add(node.id);
        const state = wanted.get(node.id);
        if (state === null) delete node.state; else node.state = state;
        updated.push(node.id);
      });
      const missing = [...wanted.keys()].filter((id) => !seen.has(id));
      const written = writeMapDoc(workspace, doc.id, doc.tree, doc.title);
      appendPluginRecord(session, RECORD_TYPE, { tree: written.tree, mapId: written.id });
      try {
        refreshTasksIfAny(workspace, written);
      } catch (e) {
        console.error("[dsh-mindmap-mine] task list refresh failed", e);
      }
      return Promise.resolve({
        ok: true,
        updated,
        missing,
        counts: countStates(written.tree),
        mapId: written.id,
        path: mapFileOf(workspace, written.id)
      });
    }
  }));
}

export { apply, inject, name };
