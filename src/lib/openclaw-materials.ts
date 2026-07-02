import { runCommand } from './command'

export type MaterialSearchMode = 'keyword' | 'vector' | 'hybrid'

export interface MaterialVideo {
  name: string
  path: string
  size: number
  modifiedAt: string
}

export interface MaterialNote {
  name: string
  path: string
  modifiedAt: string
}

export interface MaterialPipeline {
  name: string
  path: string
  indexPath: string
  modifiedAt: string
  frames: number
  audioSegments: number
  shotSegments: number
  sceneSegments: number
  visualDone: number
  visualPartial: number
  visualFailed: number
  visualPending: number
}

export interface MaterialVectorStatus {
  exists: boolean
  path: string
  chunks: number
  indexedAt: string | null
  model: string | null
  dims: number | null
}

export interface MaterialProject {
  id: string
  name: string
  path: string
  modifiedAt: string
  videos: MaterialVideo[]
  notes: MaterialNote[]
  pipelines: MaterialPipeline[]
  totals: {
    videos: number
    notes: number
    scenes: number
    visualDone: number
    visualPending: number
    vectorChunks: number
  }
}

export interface MaterialsOverview {
  workspaceRoot: string
  botLearningRoot: string
  generatedAt: string
  vector: MaterialVectorStatus
  totals: {
    projects: number
    videos: number
    notes: number
    pipelines: number
    scenes: number
    visualDone: number
    visualPending: number
    vectorChunks: number
  }
  projects: MaterialProject[]
}

export interface MaterialSearchResult {
  id: string
  project: string
  pipeline: string
  sceneId: number
  label: string
  start: number | null
  end: number | null
  score: number
  source: 'keyword' | 'vector' | 'hybrid'
  snippet: string
  transcript: string
  visualSummary: string
  tags: string[]
  metadata: Record<string, unknown>
}

export interface MaterialsSearchResponse {
  query: string
  mode: MaterialSearchMode
  generatedAt: string
  vectorAvailable: boolean
  results: MaterialSearchResult[]
}

export interface MaterialsVectorIndexResult {
  ok: boolean
  dbPath: string
  model: string
  dims: number | null
  indexed: number
  skipped: number
  errors: string[]
  chunks: number
  project: string | null
  generatedAt: string
}

const DEFAULT_WORKSPACE_ROOT = '/Users/heisenbergs-1/AI-worker-second-original-workspace'
const DEFAULT_SSH_HOST = 'heisenbergs-1'
const DEFAULT_REMOTE_PYTHON = 'python3'
const DEFAULT_EMBED_MODEL = 'nomic-embed-text'

export async function getMaterialsOverview(): Promise<MaterialsOverview> {
  return runMaterialsPython<MaterialsOverview>(LIST_MATERIALS_SCRIPT, [workspaceRoot()], 60000)
}

export async function searchMaterials(options: {
  query: string
  project?: string
  mode?: MaterialSearchMode
  limit?: number
}): Promise<MaterialsSearchResponse> {
  const query = options.query.trim()
  const mode = normalizeSearchMode(options.mode)
  const limit = Math.min(Math.max(Number(options.limit || 20), 1), 80)
  return runMaterialsPython<MaterialsSearchResponse>(SEARCH_MATERIALS_SCRIPT, [
    workspaceRoot(),
    query,
    options.project || '',
    mode,
    String(limit),
    embedModel(),
  ], 90000)
}

export async function indexMaterialVectors(options: {
  project?: string
  maxChunks?: number
} = {}): Promise<MaterialsVectorIndexResult> {
  const maxChunks = Number.isFinite(Number(options.maxChunks)) ? Math.max(0, Number(options.maxChunks)) : 0
  return runMaterialsPython<MaterialsVectorIndexResult>(INDEX_MATERIALS_SCRIPT, [
    workspaceRoot(),
    options.project || '',
    String(maxChunks),
    embedModel(),
  ], 15 * 60 * 1000)
}

function workspaceRoot(): string {
  return String(process.env.MC_MATERIALS_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT).trim() || DEFAULT_WORKSPACE_ROOT
}

function embedModel(): string {
  return String(process.env.MC_MATERIALS_EMBED_MODEL || DEFAULT_EMBED_MODEL).trim() || DEFAULT_EMBED_MODEL
}

function normalizeSearchMode(mode: unknown): MaterialSearchMode {
  if (mode === 'vector' || mode === 'hybrid') return mode
  return 'keyword'
}

async function runMaterialsPython<T>(script: string, args: string[], timeoutMs: number): Promise<T> {
  const target = String(process.env.MC_OPENCLAW_PROFILE_TARGET || 'ssh').trim().toLowerCase()
  const pythonBin = String(process.env.MC_MATERIALS_REMOTE_PYTHON || DEFAULT_REMOTE_PYTHON).trim() || DEFAULT_REMOTE_PYTHON
  const bootstrap = `import base64; exec(base64.b64decode(${JSON.stringify(Buffer.from(script, 'utf8').toString('base64'))}).decode('utf-8'))`
  const commandArgs = ['-c', bootstrap, ...args]

  const result = target === 'local'
    ? await runCommand(pythonBin, commandArgs, { timeoutMs })
    : await runCommand('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      sshHost(),
      [pythonBin, ...commandArgs].map(shellQuote).join(' '),
    ], { timeoutMs })

  return parseRemoteJson<T>(result.stdout)
}

function sshHost(): string {
  return String(process.env.MC_MATERIALS_SSH_HOST || process.env.MC_OPENCLAW_PROFILE_SSH_HOST || DEFAULT_SSH_HOST).trim() || DEFAULT_SSH_HOST
}

function parseRemoteJson<T>(stdout: string): T {
  const text = stdout.trim()
  if (!text) throw new Error('远端素材命令没有返回数据')
  const startObject = text.indexOf('{')
  const startArray = text.indexOf('[')
  const starts = [startObject, startArray].filter(index => index >= 0)
  if (starts.length === 0) throw new Error(`远端素材命令返回内容无效：${text.slice(0, 200)}`)
  const start = Math.min(...starts)
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  const end = text.lastIndexOf(close)
  if (end <= start) throw new Error(`远端素材 JSON 不完整：${text.slice(0, 200)}`)
  return JSON.parse(text.slice(start, end + 1)) as T
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

const PY_SHARED = String.raw`
import hashlib
import json
import math
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".m4v"}
NOTE_EXTS = {".md", ".txt"}
SKIP_PROJECT_DIRS = {"pipeline", "learning-notes", ".vector", "__pycache__"}

def iso_from_ts(ts):
    if not ts:
        return None
    return datetime.fromtimestamp(float(ts), timezone.utc).astimezone().isoformat(timespec="seconds")

def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

def safe_json_loads(raw, fallback):
    if raw is None:
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

def material_roots(root):
    workspace = Path(root).expanduser()
    return workspace, workspace / "bot-learning"

def vector_db_path(bot_root):
    return bot_root / ".vector" / "material_vectors.sqlite"

def project_dirs(bot_root):
    if not bot_root.exists():
        return []
    rows = []
    for path in bot_root.iterdir():
        if not path.is_dir():
            continue
        if path.name.startswith(".") or path.name in SKIP_PROJECT_DIRS:
            continue
        rows.append(path)
    return sorted(rows, key=lambda p: p.name)

def pipeline_dirs(project):
    rows = []
    for path in project.iterdir():
        if path.is_dir() and path.name.startswith("pipeline") and (path / "material_index.sqlite").exists():
            rows.append(path)
    return sorted(rows, key=lambda p: (p.name != "pipeline", p.name))

def connect_readonly(db_path):
    uri = f"file:{db_path}?mode=ro"
    return sqlite3.connect(uri, uri=True)

def scalar(conn, sql, default=0):
    try:
        row = conn.execute(sql).fetchone()
        return row[0] if row and row[0] is not None else default
    except Exception:
        return default

def visual_counts(conn):
    counts = {}
    try:
        for status, count in conn.execute("select coalesce(status,''), count(*) from visual_labels group by status"):
            counts[str(status)] = int(count or 0)
    except Exception:
        pass
    return {
        "done": counts.get("done", 0),
        "partial": counts.get("partial_vl", 0) + counts.get("partial", 0),
        "failed": counts.get("failed_vl", 0) + counts.get("failed", 0),
    }

def read_pipeline(path):
    db_path = path / "material_index.sqlite"
    modified = db_path.stat().st_mtime if db_path.exists() else path.stat().st_mtime
    item = {
        "name": path.name,
        "path": str(path),
        "indexPath": str(db_path),
        "modifiedAt": iso_from_ts(modified),
        "frames": 0,
        "audioSegments": 0,
        "shotSegments": 0,
        "sceneSegments": 0,
        "visualDone": 0,
        "visualPartial": 0,
        "visualFailed": 0,
        "visualPending": 0,
    }
    try:
        with connect_readonly(db_path) as conn:
            item["frames"] = int(scalar(conn, "select count(*) from frames"))
            item["audioSegments"] = int(scalar(conn, "select count(*) from audio_segments"))
            item["shotSegments"] = int(scalar(conn, "select count(*) from shot_segments"))
            item["sceneSegments"] = int(scalar(conn, "select count(*) from scene_segments"))
            counts = visual_counts(conn)
            item["visualDone"] = counts["done"]
            item["visualPartial"] = counts["partial"]
            item["visualFailed"] = counts["failed"]
            item["visualPending"] = max(0, item["sceneSegments"] - item["visualDone"] - item["visualPartial"] - item["visualFailed"])
    except Exception:
        pass
    return item

def list_videos(project):
    raw = project / "raw-data"
    if not raw.exists():
        return []
    rows = []
    for path in sorted(raw.iterdir(), key=lambda p: p.name):
        if path.is_file() and path.suffix.lower() in VIDEO_EXTS:
            st = path.stat()
            rows.append({"name": path.name, "path": str(path), "size": st.st_size, "modifiedAt": iso_from_ts(st.st_mtime)})
    return rows

def list_notes(project):
    notes = project / "learning-notes"
    if not notes.exists():
        return []
    rows = []
    for path in sorted(notes.iterdir(), key=lambda p: p.name):
        if path.is_file() and path.suffix.lower() in NOTE_EXTS:
            st = path.stat()
            rows.append({"name": path.name, "path": str(path), "modifiedAt": iso_from_ts(st.st_mtime)})
    return rows

def vector_status(bot_root, project_name=None):
    db_path = vector_db_path(bot_root)
    status = {"exists": db_path.exists(), "path": str(db_path), "chunks": 0, "indexedAt": None, "model": None, "dims": None}
    if not db_path.exists():
        return status
    try:
        with sqlite3.connect(db_path) as conn:
            if project_name:
                row = conn.execute("select count(*), max(indexed_at), max(model), max(dims) from material_vectors where project=?", (project_name,)).fetchone()
            else:
                row = conn.execute("select count(*), max(indexed_at), max(model), max(dims) from material_vectors").fetchone()
            if row:
                status["chunks"] = int(row[0] or 0)
                status["indexedAt"] = row[1]
                status["model"] = row[2]
                status["dims"] = int(row[3]) if row[3] else None
    except Exception:
        pass
    return status

def flatten_json_text(value):
    parts = []
    if isinstance(value, dict):
        for key in ("visual_summary", "story_function", "location", "people", "actions", "objects", "environment", "shot_types", "ocr", "emotion", "material_value", "searchable_tags"):
            if key in value:
                parts.extend(flatten_json_text(value[key]))
    elif isinstance(value, list):
        for item in value:
            parts.extend(flatten_json_text(item))
    elif value is not None:
        text = str(value).strip()
        if text:
            parts.append(text)
    return parts

def scene_rows(project_filter=None):
    workspace, bot_root = material_roots(sys.argv[1])
    for project in project_dirs(bot_root):
        if project_filter and project.name != project_filter:
            continue
        for pipeline in pipeline_dirs(project):
            db_path = pipeline / "material_index.sqlite"
            try:
                with connect_readonly(db_path) as conn:
                    sql = """
                    select s.id, s.label, s.start, s.end, s.transcript, s.material_tags_json,
                           coalesce(v.status,''), coalesce(v.result_json,''), coalesce(v.raw_response,'')
                    from scene_segments s
                    left join visual_labels v on v.scene_id = s.id
                    order by s.id
                    """
                    for row in conn.execute(sql):
                        result = safe_json_loads(row[7], {})
                        tags = safe_json_loads(row[5], [])
                        result_tags = result.get("searchable_tags") if isinstance(result, dict) else []
                        all_tags = []
                        for tag in (tags if isinstance(tags, list) else []) + (result_tags if isinstance(result_tags, list) else []):
                            tag_text = str(tag).strip()
                            if tag_text and tag_text not in all_tags:
                                all_tags.append(tag_text)
                        text_parts = [str(row[1] or ""), str(row[4] or "")]
                        text_parts.extend(flatten_json_text(result))
                        text = "\n".join(part for part in text_parts if part)
                        yield {
                            "id": f"{project.name}:{pipeline.name}:{row[0]}",
                            "project": project.name,
                            "pipeline": pipeline.name,
                            "sceneId": int(row[0]),
                            "label": str(row[1] or f"scene-{int(row[0]):03d}"),
                            "start": row[2],
                            "end": row[3],
                            "transcript": str(row[4] or ""),
                            "visualSummary": str(result.get("visual_summary", "") if isinstance(result, dict) else ""),
                            "tags": all_tags[:24],
                            "text": text,
                            "metadata": result if isinstance(result, dict) else {},
                        }
            except Exception:
                continue

def lexical_score(query, text):
    q = query.strip().lower()
    t = text.lower()
    if not q:
        return 0.0
    score = 0.0
    if q in t:
        score += 8.0
    terms = [item for item in q.split() if item]
    if terms:
        score += sum(2.5 for term in terms if term in t)
    chars = [ch for ch in q if not ch.isspace()]
    if chars:
        hits = sum(1 for ch in chars if ch in t)
        score += hits / max(1, len(chars)) * 3.0
    score += SequenceMatcher(None, q[:80], t[:400]).ratio()
    return score

def snippet(query, text, fallback=""):
    body = (text or fallback or "").replace("\n", " ").strip()
    if not body:
        return ""
    q = query.strip()
    idx = body.lower().find(q.lower()) if q else -1
    if idx < 0:
        return body[:220]
    start = max(0, idx - 80)
    end = min(len(body), idx + len(q) + 140)
    return ("..." if start > 0 else "") + body[start:end] + ("..." if end < len(body) else "")

def ollama_embed(text, model):
    payload = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:11434/api/embeddings", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))
    embedding = data.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError("Ollama embedding response is empty")
    return [float(x) for x in embedding]

def cosine(left, right):
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    ln = math.sqrt(sum(a * a for a in left))
    rn = math.sqrt(sum(b * b for b in right))
    if not ln or not rn:
        return 0.0
    return dot / (ln * rn)
`

const LIST_MATERIALS_SCRIPT = `${PY_SHARED}
def main():
    workspace, bot_root = material_roots(sys.argv[1])
    vector = vector_status(bot_root)
    projects = []
    totals = {"projects": 0, "videos": 0, "notes": 0, "pipelines": 0, "scenes": 0, "visualDone": 0, "visualPending": 0, "vectorChunks": vector["chunks"]}
    for project in project_dirs(bot_root):
        videos = list_videos(project)
        notes = list_notes(project)
        pipelines = [read_pipeline(path) for path in pipeline_dirs(project)]
        project_vector = vector_status(bot_root, project.name)
        modified = project.stat().st_mtime
        for item in videos + notes:
            if item.get("modifiedAt"):
                pass
        for pipeline in pipelines:
            totals["pipelines"] += 1
            totals["scenes"] += pipeline["sceneSegments"]
            totals["visualDone"] += pipeline["visualDone"]
            totals["visualPending"] += pipeline["visualPending"]
        project_totals = {
            "videos": len(videos),
            "notes": len(notes),
            "scenes": sum(p["sceneSegments"] for p in pipelines),
            "visualDone": sum(p["visualDone"] for p in pipelines),
            "visualPending": sum(p["visualPending"] for p in pipelines),
            "vectorChunks": project_vector["chunks"],
        }
        totals["videos"] += len(videos)
        totals["notes"] += len(notes)
        projects.append({
            "id": project.name,
            "name": project.name,
            "path": str(project),
            "modifiedAt": iso_from_ts(modified),
            "videos": videos,
            "notes": notes,
            "pipelines": pipelines,
            "totals": project_totals,
        })
    totals["projects"] = len(projects)
    emit({
        "workspaceRoot": str(workspace),
        "botLearningRoot": str(bot_root),
        "generatedAt": now_iso(),
        "vector": vector,
        "totals": totals,
        "projects": projects,
    })
main()
`

const SEARCH_MATERIALS_SCRIPT = `${PY_SHARED}
def vector_results(query, project_filter, limit, model):
    workspace, bot_root = material_roots(sys.argv[1])
    db_path = vector_db_path(bot_root)
    if not db_path.exists() or not query.strip():
        return []
    query_vector = ollama_embed(query, model)
    rows = []
    with sqlite3.connect(db_path) as conn:
        if project_filter:
            cursor = conn.execute("select id, project, pipeline, scene_id, label, start, end, text, metadata_json, embedding_json from material_vectors where project=?", (project_filter,))
        else:
            cursor = conn.execute("select id, project, pipeline, scene_id, label, start, end, text, metadata_json, embedding_json from material_vectors")
        for row in cursor:
            try:
                embedding = json.loads(row[9])
            except Exception:
                continue
            score = cosine(query_vector, embedding)
            metadata = safe_json_loads(row[8], {})
            tags = metadata.get("searchable_tags", []) if isinstance(metadata, dict) else []
            rows.append({
                "id": row[0],
                "project": row[1],
                "pipeline": row[2],
                "sceneId": int(row[3]),
                "label": row[4],
                "start": row[5],
                "end": row[6],
                "score": score,
                "source": "vector",
                "snippet": snippet(query, row[7]),
                "transcript": str(metadata.get("transcript", "") if isinstance(metadata, dict) else ""),
                "visualSummary": str(metadata.get("visual_summary", "") if isinstance(metadata, dict) else ""),
                "tags": tags if isinstance(tags, list) else [],
                "metadata": metadata if isinstance(metadata, dict) else {},
            })
    return sorted(rows, key=lambda item: item["score"], reverse=True)[:limit]

def keyword_results(query, project_filter, limit):
    rows = []
    for scene in scene_rows(project_filter):
        score = lexical_score(query, scene["text"])
        if score <= 0:
            continue
        rows.append({
            "id": scene["id"],
            "project": scene["project"],
            "pipeline": scene["pipeline"],
            "sceneId": scene["sceneId"],
            "label": scene["label"],
            "start": scene["start"],
            "end": scene["end"],
            "score": score,
            "source": "keyword",
            "snippet": snippet(query, scene["text"], scene["visualSummary"] or scene["transcript"]),
            "transcript": scene["transcript"],
            "visualSummary": scene["visualSummary"],
            "tags": scene["tags"],
            "metadata": scene["metadata"],
        })
    return sorted(rows, key=lambda item: item["score"], reverse=True)[:limit]

def merge_hybrid(vector_rows, keyword_rows, limit):
    merged = {}
    for row in keyword_rows:
        merged[row["id"]] = row
    for row in vector_rows:
        if row["id"] in merged:
            existing = merged[row["id"]]
            existing["source"] = "hybrid"
            existing["score"] = float(existing["score"]) + float(row["score"]) * 10
            if not existing.get("visualSummary"):
                existing["visualSummary"] = row.get("visualSummary", "")
        else:
            merged[row["id"]] = {**row, "source": "hybrid"}
    return sorted(merged.values(), key=lambda item: item["score"], reverse=True)[:limit]

def main():
    root = sys.argv[1]
    query = sys.argv[2]
    project_filter = sys.argv[3] or None
    mode = sys.argv[4]
    limit = int(sys.argv[5])
    model = sys.argv[6]
    workspace, bot_root = material_roots(root)
    vector_available = vector_status(bot_root)["chunks"] > 0
    if not query.strip():
        emit({"query": query, "mode": mode, "generatedAt": now_iso(), "vectorAvailable": vector_available, "results": []})
        return
    try:
        if mode == "vector":
            results = vector_results(query, project_filter, limit, model)
        elif mode == "hybrid":
            results = merge_hybrid(vector_results(query, project_filter, limit, model), keyword_results(query, project_filter, limit), limit)
        else:
            results = keyword_results(query, project_filter, limit)
    except Exception:
        if mode in {"vector", "hybrid"}:
            results = keyword_results(query, project_filter, limit)
        else:
            raise
    emit({"query": query, "mode": mode, "generatedAt": now_iso(), "vectorAvailable": vector_available, "results": results})
main()
`

const INDEX_MATERIALS_SCRIPT = `${PY_SHARED}
def ensure_vector_db(db_path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("""
      create table if not exists material_vectors (
        id text primary key,
        project text not null,
        pipeline text not null,
        scene_id integer not null,
        label text not null,
        start real,
        end real,
        text text not null,
        metadata_json text not null,
        content_hash text not null,
        embedding_json text not null,
        model text not null,
        dims integer,
        indexed_at text not null,
        source_mtime real
      )
    """)
    conn.execute("create index if not exists idx_material_vectors_project on material_vectors(project)")
    conn.execute("create index if not exists idx_material_vectors_scene on material_vectors(project, pipeline, scene_id)")
    conn.execute("create table if not exists vector_meta (key text primary key, value text)")
    return conn

def main():
    root = sys.argv[1]
    project_filter = sys.argv[2] or None
    max_chunks = int(sys.argv[3] or "0")
    model = sys.argv[4]
    workspace, bot_root = material_roots(root)
    db_path = vector_db_path(bot_root)
    indexed = 0
    skipped = 0
    errors = []
    dims = None
    generated_at = now_iso()
    with ensure_vector_db(db_path) as conn:
        conn.execute("insert or replace into vector_meta(key,value) values('model',?)", (model,))
        conn.execute("insert or replace into vector_meta(key,value) values('updated_at',?)", (generated_at,))
        for scene in scene_rows(project_filter):
            if max_chunks and indexed >= max_chunks:
                break
            text = scene["text"].strip()
            if not text:
                skipped += 1
                continue
            content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            current = conn.execute("select content_hash, embedding_json from material_vectors where id=?", (scene["id"],)).fetchone()
            if current and current[0] == content_hash and current[1]:
                skipped += 1
                continue
            try:
                embedding = ollama_embed(text[:6000], model)
                dims = len(embedding)
                metadata = dict(scene["metadata"])
                metadata["transcript"] = scene["transcript"]
                metadata["visual_summary"] = scene["visualSummary"]
                metadata["searchable_tags"] = scene["tags"]
                conn.execute(
                    """insert or replace into material_vectors
                    (id, project, pipeline, scene_id, label, start, end, text, metadata_json, content_hash, embedding_json, model, dims, indexed_at, source_mtime)
                    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        scene["id"],
                        scene["project"],
                        scene["pipeline"],
                        scene["sceneId"],
                        scene["label"],
                        scene["start"],
                        scene["end"],
                        text,
                        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
                        content_hash,
                        json.dumps(embedding, separators=(",", ":")),
                        model,
                        dims,
                        generated_at,
                        time.time(),
                    ),
                )
                indexed += 1
            except Exception as exc:
                errors.append(f"{scene['id']}: {exc}")
        conn.commit()
        chunks = conn.execute("select count(*) from material_vectors").fetchone()[0]
    emit({
        "ok": len(errors) == 0,
        "dbPath": str(db_path),
        "model": model,
        "dims": dims,
        "indexed": indexed,
        "skipped": skipped,
        "errors": errors[:20],
        "chunks": chunks,
        "project": project_filter,
        "generatedAt": generated_at,
    })
main()
`
