"use client";
import { useEffect, useMemo, useState } from "react";
import { forceSameExtension, getExtension, isWindowsSafeName, naturalCompare } from "@/lib/rename";
import { deterministicNormalize, hybridNormalize } from "@/lib/hybrid";
import { OLLAMA_BATCH_SIZE, OLLAMA_MAX_SELF_HEAL_ITEMS } from "@/lib/config";

type Kind = "file" | "folder";
type Phase = "idle" | "scanning" | "ai" | "renaming";
type WriteAccess = "unknown" | "granted" | "denied" | "unsupported";

type Row = {
  id: string;
  kind: Kind;
  relativePath: string;
  folder: string;
  original: string;
  proposed: string;
  aiNamed: boolean;
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  parentHandle: FileSystemDirectoryHandle;
};

type DirHandle = FileSystemDirectoryHandle & {
  values?: () => AsyncIterableIterator<FileSystemHandle>;
};

type MoveableFileHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> };
type MoveableDirHandle = FileSystemDirectoryHandle & { move?: (name: string) => Promise<void> };

type PermissionMode = "read" | "readwrite";
type PermissionCapableHandle = FileSystemDirectoryHandle & {
  queryPermission?: (opts: { mode: PermissionMode }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: PermissionMode }) => Promise<PermissionState>;
};

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".webm", ".flv", ".ts", ".m2ts", ".mpeg", ".mpg"]);

function isProbablyVideo(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

async function* walkDirectory(
  handle: DirHandle,
  relative = ""
): AsyncGenerator<{ handle: FileSystemHandle; relative: string; parentHandle: FileSystemDirectoryHandle }> {
  if (!handle.values) throw new Error("This browser does not expose directory iteration. Use the latest Chrome or Edge desktop.");
  for await (const entry of handle.values()) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    yield { handle: entry, relative: relativePath, parentHandle: handle };
    if (entry.kind === "directory") yield* walkDirectory(entry as DirHandle, relativePath);
  }
}

/**
 * Native FileSystemHandle.move() support is uneven across Chrome/Edge
 * versions — some ship it for files well before they ship it for
 * directories, which is why folder renames can fail with "This browser
 * does not expose the native rename operation" even though file renames
 * right above them succeed. Rather than give up, fall back to a manual
 * copy-then-delete using the older, much more broadly supported
 * getFileHandle / getDirectoryHandle / createWritable / removeEntry APIs.
 */
async function copyFileWithFallback(parent: FileSystemDirectoryHandle, source: FileSystemFileHandle, newName: string) {
  const file = await source.getFile();
  const destHandle = await parent.getFileHandle(newName, { create: true });
  const writable = await destHandle.createWritable();
  try {
    await writable.write(file);
  } finally {
    await writable.close();
  }
  await parent.removeEntry(source.name);
}

async function copyDirectoryContents(source: FileSystemDirectoryHandle, dest: FileSystemDirectoryHandle) {
  const iterableSource = source as DirHandle;
  if (!iterableSource.values) throw new Error("This browser cannot enumerate folder contents for a manual copy fallback.");
  for await (const entry of iterableSource.values()) {
    if (entry.kind === "file") {
      const fileEntry = entry as FileSystemFileHandle;
      const file = await fileEntry.getFile();
      const destFile = await dest.getFileHandle(entry.name, { create: true });
      const writable = await destFile.createWritable();
      try {
        await writable.write(file);
      } finally {
        await writable.close();
      }
    } else {
      const destSub = await dest.getDirectoryHandle(entry.name, { create: true });
      await copyDirectoryContents(entry as FileSystemDirectoryHandle, destSub);
    }
  }
}

async function copyDirectoryWithFallback(parent: FileSystemDirectoryHandle, source: FileSystemDirectoryHandle, originalName: string, newName: string) {
  const destDir = await parent.getDirectoryHandle(newName, { create: true });
  await copyDirectoryContents(source, destDir);
  await parent.removeEntry(originalName, { recursive: true });
}

function isPermissionError(e: unknown) {
  return e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
}

/**
 * Renames one row on disk. Tries the fast native move() first (preserves
 * file identity/metadata in one atomic call); if that method doesn't exist
 * on this handle in this browser, or fails for a reason other than a
 * permission problem, falls back to a manual copy + delete instead of
 * failing outright.
 */
async function renameEntry(row: Row, newName: string) {
  if (row.kind === "file") {
    const handle = row.handle as MoveableFileHandle;
    if (typeof handle.move === "function") {
      try {
        await handle.move(newName);
        return;
      } catch (e) {
        if (isPermissionError(e)) throw e;
        // fall through to the manual fallback below
      }
    }
    await copyFileWithFallback(row.parentHandle, row.handle as FileSystemFileHandle, newName);
    return;
  }
  const handle = row.handle as MoveableDirHandle;
  if (typeof handle.move === "function") {
    try {
      await handle.move(newName);
      return;
    } catch (e) {
      if (isPermissionError(e)) throw e;
    }
  }
  await copyDirectoryWithFallback(row.parentHandle, row.handle as FileSystemDirectoryHandle, row.original, newName);
}

function depth(path: string) {
  return path.split("/").length;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Directory rename/move on the File System Access API throws
 * "The request is not allowed by the user agent or the platform in the
 * current context" when the handle only has READ permission — which is
 * what showDirectoryPicker() grants by default. Requesting "readwrite" up
 * front (and re-checking it before every rename pass, since the browser can
 * silently drop the grant) is what actually fixes that error.
 */
async function ensureReadWriteAccess(handle: FileSystemDirectoryHandle): Promise<WriteAccess> {
  const h = handle as PermissionCapableHandle;
  if (!h.queryPermission || !h.requestPermission) return "unsupported";
  try {
    const existing = await h.queryPermission({ mode: "readwrite" });
    if (existing === "granted") return "granted";
    const requested = await h.requestPermission({ mode: "readwrite" });
    return requested === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

export default function Renamer() {
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [rootName, setRootName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [message, setMessage] = useState("Select a folder to begin.");
  const [filterVideos, setFilterVideos] = useState(true);
  const [includeFolders, setIncludeFolders] = useState(true);
  const [ollamaModel, setOllamaModel] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState("Checking local Ollama…");
  const [useOllama, setUseOllama] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [writeAccess, setWriteAccess] = useState<WriteAccess>("unknown");

  const changedCount = useMemo(() => rows.filter(r => r.original !== r.proposed).length, [rows]);
  const selectedChangedCount = useMemo(() => rows.filter(r => selected.has(r.id) && r.original !== r.proposed).length, [rows, selected]);

  async function loadOllamaModels() {
    try {
      const res = await fetch("/api/ollama/models", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Ollama is not reachable.");
      const models = Array.isArray(data.models) ? (data.models as string[]) : [];
      setOllamaModels(models);
      if (models.length) {
        setOllamaModel(prev => (models.includes(prev) ? prev : models[0]));
        setOllamaStatus(`${models.length} local model${models.length === 1 ? "" : "s"} found.`);
      } else {
        setOllamaModel("");
        setOllamaStatus("Ollama is running, but no models are installed.");
      }
    } catch (e) {
      setOllamaModels([]);
      setOllamaModel("");
      setOllamaStatus(e instanceof Error ? e.message : "Ollama is not reachable.");
    }
  }

  useEffect(() => {
    loadOllamaModels();
  }, []);

  async function scanDirectory(handle: FileSystemDirectoryHandle) {
    setLoading(true);
    setPhase("scanning");
    setProgress({ current: 0, total: 0, label: "Scanning folder…" });
    try {
      const found: Row[] = [];
      let seen = 0;
      for await (const item of walkDirectory(handle as DirHandle)) {
        seen++;
        if (seen % 10 === 0) setProgress({ current: seen, total: 0, label: `Scanning… ${seen} entries found` });
        const parts = item.relative.split("/");
        const original = parts[parts.length - 1];
        const kind: Kind = item.handle.kind === "directory" ? "folder" : "file";
        if (kind === "file" && filterVideos && !isProbablyVideo(original)) continue;
        if (kind === "folder" && !includeFolders) continue;
        const folder = parts.slice(0, -1).join("/");
        found.push({
          id: `${kind}:${item.relative}`,
          kind,
          relativePath: item.relative,
          folder,
          original,
          proposed: deterministicNormalize(original, kind),
          aiNamed: false,
          handle: item.handle as FileSystemFileHandle | FileSystemDirectoryHandle,
          parentHandle: item.parentHandle,
        });
      }
      // Natural Explorer-like sorting: parent path first, then numeric-aware name.
      found.sort((a, b) => naturalCompare(a.relativePath, b.relativePath));
      setRows(found);
      setSelected(new Set(found.map(r => r.id)));
      setProgress({ current: found.length, total: found.length, label: `Scan complete · ${found.length} items` });
      setMessage(`Found ${found.filter(r => r.kind === "file").length} ${filterVideos ? "video " : ""}file(s) and ${found.filter(r => r.kind === "folder").length} subfolder(s).`);
    } finally {
      setLoading(false);
      setPhase("idle");
    }
  }

  async function selectFolder() {
    setMessage("");
    try {
      if (!("showDirectoryPicker" in window)) throw new Error("Your browser does not support folder access. Use Chrome or Edge on desktop.");
      // Requesting "readwrite" here is what lets FileSystemHandle.move() work
      // later — without it the browser only grants read access, and every
      // rename fails with "The request is not allowed by the user agent or
      // the platform in the current context."
      const picker = window as Window & {
        showDirectoryPicker: (options?: { mode?: PermissionMode }) => Promise<FileSystemDirectoryHandle>;
      };
      const handle = await picker.showDirectoryPicker({ mode: "readwrite" });
      setDirectory(handle);
      setRootName(handle.name);
      setRows([]);
      setSelected(new Set());
      const access = await ensureReadWriteAccess(handle);
      setWriteAccess(access);
      await scanDirectory(handle);
      if (access === "denied") {
        setMessage("Folder loaded, but edit access was not granted — renaming will fail until you allow it. Click “Grant edit access” below.");
      } else if (access === "unsupported") {
        setMessage("Folder loaded. This browser doesn't expose permission checks; if renaming fails, reselect the folder and allow edit access when prompted.");
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setMessage(e instanceof Error ? e.message : "Could not read the folder.");
      setLoading(false);
      setPhase("idle");
    }
  }

  async function grantWriteAccess() {
    if (!directory) return;
    const access = await ensureReadWriteAccess(directory);
    setWriteAccess(access);
    setMessage(
      access === "granted"
        ? "Edit access granted. You can rename now."
        : "Edit access was not granted. Your browser may have blocked the prompt — try selecting the folder again."
    );
  }

  function updateName(id: string, proposed: string) {
    setRows(prev =>
      prev.map(r => (r.id === id ? { ...r, proposed: r.kind === "file" ? forceSameExtension(r.original, proposed) : proposed, aiNamed: false } : r))
    );
  }

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAllChanged() {
    setSelected(new Set(rows.filter(r => r.original !== r.proposed).map(r => r.id)));
  }

  async function requestOllamaBatch(targets: Row[]): Promise<{ map: Map<string, string>; warning?: string }> {
    const res = await fetch("/api/ollama", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: targets.map(r => ({ name: r.original, kind: r.kind, relativePath: r.relativePath })), model: ollamaModel }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Ollama request failed.");
    const map = new Map<string, string>();
    targets.forEach((r, i) => {
      const suggestion = data.suggestions?.[i];
      if (typeof suggestion === "string" && suggestion.trim()) map.set(r.id, suggestion);
    });
    return { map, warning: typeof data.warning === "string" ? data.warning : undefined };
  }

  async function generateWithOllama() {
    const targets = rows.filter(r => selected.has(r.id));
    if (!targets.length) return setMessage("Select at least one file or folder first.");
    if (!ollamaModel) return setMessage("Select an installed Ollama model first.");

    setLoading(true);
    setPhase("ai");
    const batches = chunkArray(targets, OLLAMA_BATCH_SIZE);
    const resultMap = new Map<string, string>();
    const batchErrors: string[] = [];

    try {
      for (let i = 0; i < batches.length; i++) {
        setProgress({
          current: i,
          total: batches.length,
          label: `Ollama batch ${i + 1}/${batches.length} · naming ${batches[i].length} item(s)…`,
        });
        try {
          const { map } = await requestOllamaBatch(batches[i]);
          map.forEach((v, k) => resultMap.set(k, v));
        } catch (e) {
          batchErrors.push(e instanceof Error ? e.message : "batch failed");
        }
      }

      // Self-heal: local 7B-class models regularly skip a handful of items
      // in a batch rather than returning the exact count. Rather than
      // failing the whole request (the old behaviour), retry once for just
      // the items that came back empty.
      const missing = targets.filter(r => !resultMap.has(r.id));
      if (missing.length && missing.length <= OLLAMA_MAX_SELF_HEAL_ITEMS) {
        setProgress({ current: batches.length, total: batches.length + 1, label: `Retrying ${missing.length} item(s) Ollama skipped…` });
        for (const retryBatch of chunkArray(missing, OLLAMA_BATCH_SIZE)) {
          try {
            const { map } = await requestOllamaBatch(retryBatch);
            map.forEach((v, k) => resultMap.set(k, v));
          } catch {
            // keep the deterministic fallback name for these
          }
        }
      }

      setRows(prev =>
        prev.map(r =>
          resultMap.has(r.id)
            ? { ...r, proposed: hybridNormalize(r.original, String(resultMap.get(r.id)), r.kind), aiNamed: true }
            : r
        )
      );

      const namedCount = targets.filter(r => resultMap.has(r.id)).length;
      setProgress({ current: batches.length, total: batches.length, label: `Ollama complete · ${namedCount}/${targets.length} item(s) named` });

      const parts = [`Ollama named ${namedCount}/${targets.length} selected item(s).`];
      if (namedCount < targets.length) parts.push(`${targets.length - namedCount} kept their cleaned-up default name.`);
      if (batchErrors.length) parts.push(`${batchErrors.length} batch request(s) failed (${batchErrors[0]}).`);
      parts.push("Review every name before renaming.");
      setMessage(parts.join(" "));
    } finally {
      setLoading(false);
      setPhase("idle");
    }
  }

  function validateTargets(targets: Row[]) {
    const invalid = targets.filter(r => !isWindowsSafeName(r.proposed.trim()) || (r.kind === "file" && getExtension(r.proposed) !== getExtension(r.original)));
    if (invalid.length) return `Fix invalid names first:\n\n${invalid.map(r => `${r.original} → ${r.proposed}`).join("\n")}`;
    // Prevent two selected siblings from becoming the same name.
    const seen = new Map<string, Row>();
    for (const row of targets) {
      const key = `${row.folder.toLowerCase()}|${row.proposed.trim().toLowerCase()}`;
      const other = seen.get(key);
      if (other && other.id !== row.id) return `Duplicate destination in the same folder:\n\n${other.proposed}\n${row.proposed}`;
      seen.set(key, row);
    }
    return null;
  }

  async function renameActual() {
    const targets = rows.filter(r => selected.has(r.id) && r.original !== r.proposed);
    if (!targets.length) return setMessage("There are no selected changes to rename.");
    const validation = validateTargets(targets);
    if (validation) return alert(validation);

    // Re-check write access right before renaming — it's the single most
    // common cause of every row failing with "not allowed by the user
    // agent or the platform in the current context."
    if (directory) {
      const access = await ensureReadWriteAccess(directory);
      setWriteAccess(access);
      if (access === "denied") {
        alert("Edit access to this folder was not granted, so nothing can be renamed. Click “Grant edit access” and try again.");
        return;
      }
    }

    const fileCount = targets.filter(r => r.kind === "file").length;
    const folderCount = targets.filter(r => r.kind === "folder").length;
    if (!confirm(`Rename ${fileCount} file(s) and ${folderCount} subfolder(s) on disk?\n\nThis changes the actual library.`)) return;

    setRenaming(true);
    setPhase("renaming");
    setProgress({ current: 0, total: targets.length, label: "Starting rename…" });
    let done = 0;
    const errors: string[] = [];
    try {
      const ordered = [...targets.filter(r => r.kind === "file"), ...targets.filter(r => r.kind === "folder").sort((a, b) => depth(b.relativePath) - depth(a.relativePath))];
      for (const row of ordered) {
        const newName = (row.kind === "file" ? forceSameExtension(row.original, row.proposed) : row.proposed).trim();
        try {
          await renameEntry(row, newName);
          done++;
        } catch (e) {
          const isPermissionError = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
          const detail = isPermissionError
            ? "permission denied — click “Grant edit access” (or reselect the folder and allow edit access), then try again"
            : e instanceof Error
              ? e.message
              : "rename failed";
          errors.push(`${row.kind}: ${row.original} → ${newName} — ${detail}`);
        }
        setProgress({ current: done + errors.length, total: ordered.length, label: `${done + errors.length}/${ordered.length} processed` });
      }
      if (directory) await scanDirectory(directory);
      setMessage(`Rename finished · ${done} succeeded${errors.length ? ` · ${errors.length} failed` : ""}.`);
    } finally {
      setRenaming(false);
      setPhase("idle");
    }
    if (errors.length) alert(`Some items could not be renamed:\n\n${errors.join("\n")}`);
  }

  const progressPercent = progress.total ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;
  const isBusy = loading || renaming;

  return (
    <main className="page">
      <section className="shell">
        <header className="hero">
          <div>
            <p className="eyebrow">LOCAL FILE TOOL</p>
            <h1>Movie File Renamer</h1>
            <p className="sub">
              {rootName ? (
                <>
                  Library: <b>{rootName}</b> → files + folders → clean names → rename on disk.
                </>
              ) : (
                "Select a folder → scan subfolders → review names → rename actual items."
              )}
            </p>
          </div>
          <button className="primary" onClick={selectFolder} disabled={isBusy}>
            {phase === "scanning" ? "Reading…" : "📁 Select Folder"}
          </button>
        </header>

        {phase !== "idle" || progress.label ? (
          <div className="progressBox">
            <div className="progressTop">
              <span>{progress.label}</span>
              <b>{progress.total ? `${progress.current}/${progress.total}` : `${progress.current} found`}</b>
            </div>
            <div className={`progressTrack ${!progress.total ? "indeterminate" : ""}`}>
              <div className="progressFill" style={{ width: progress.total ? `${progressPercent}%` : "35%" }} />
            </div>
            {phase === "renaming" && <small>Files are renamed first, then folders from deepest to shallowest.</small>}
          </div>
        ) : null}

        <div className="toolbar">
          <label className="check">
            <input type="checkbox" checked={filterVideos} onChange={e => setFilterVideos(e.target.checked)} disabled={!!rows.length || isBusy} /> Video files only
          </label>
          <label className="check">
            <input type="checkbox" checked={includeFolders} onChange={e => setIncludeFolders(e.target.checked)} disabled={!!rows.length || isBusy} /> Include subfolders
          </label>
          <button className="secondary" onClick={selectAllChanged} disabled={!rows.length || isBusy}>
            Select changed
          </button>
          <span className="stats">
            {rows.length} items · {changedCount} changes · {selectedChangedCount} selected changes
          </span>
        </div>

        <div className="ollama">
          <div className="ollamaTitle">
            <span>🤖 Optional Ollama</span>
            <small>Runs locally on your PC</small>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={useOllama}
              onChange={e => {
                setUseOllama(e.target.checked);
                if (e.target.checked) loadOllamaModels();
              }}
              disabled={isBusy}
            />{" "}
            Use Ollama suggestions
          </label>
          <select value={ollamaModel} onChange={e => setOllamaModel(e.target.value)} disabled={!useOllama || !ollamaModels.length || isBusy}>
            {!ollamaModels.length && <option value="">No Ollama model found</option>}
            {ollamaModels.map(model => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={loadOllamaModels} disabled={isBusy}>
            Refresh
          </button>
          <button className="secondary" onClick={generateWithOllama} disabled={!useOllama || !ollamaModel || isBusy || !rows.length}>
            Generate names
          </button>
        </div>

        {writeAccess === "denied" && (
          <div className="warnNotice">
            <span>⚠️ Edit access to this folder hasn&apos;t been granted, so renaming will fail. Click below and allow access when your browser prompts you.</span>
            <button className="secondary" onClick={grantWriteAccess} disabled={isBusy}>
              Grant edit access
            </button>
          </div>
        )}

        <div className="notice">{message}</div>
        <div className="ollamaStatus">Ollama: {ollamaStatus}</div>

        <div className="tableWrap">
          <div className="tableHead">
            <span>✓</span>
            <span>Type</span>
            <span>Current name</span>
            <span>New name</span>
            <span>Folder</span>
          </div>
          {rows.length === 0 && (
            <div className="empty">
              No items loaded yet. Click <b>Select Folder</b>.
            </div>
          )}
          {rows.map(row => (
            <div className="row" key={row.id}>
              <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} disabled={isBusy} />
              <div className="kind">{row.kind === "folder" ? "📁 Folder" : "🎬 File"}</div>
              <div className="current" title={row.original}>
                {row.original}
              </div>
              <input
                className={row.original !== row.proposed ? (row.aiNamed ? "changed aiNamed" : "changed") : ""}
                value={row.proposed}
                onChange={e => updateName(row.id, e.target.value)}
                disabled={isBusy}
                title={row.aiNamed ? "Named by Ollama" : undefined}
              />
              <div className="folder" title={row.folder || "."}>
                {row.folder || "."}
              </div>
            </div>
          ))}
        </div>

        <footer className="bottomBar">
          <div>
            <b>{selectedChangedCount}</b> selected rename(s) ready
          </div>
          <button className="primary big" onClick={renameActual} disabled={isBusy || selectedChangedCount === 0}>
            {renaming ? `Renaming ${progress.current}/${progress.total}…` : "Next → Rename Files & Folders"}
          </button>
        </footer>

        <details className="help">
          <summary>Rules & safety</summary>
          <ul>
            <li>Audio languages, audio channel layouts, subtitles, codecs, resolution, streaming platforms, download sites, and release groups are removed.</li>
            <li>
              Only the movie year uses parentheses: <code>Movie Title (2025).mkv</code>.
            </li>
            <li>
              Franchise numbers stay in natural sorting position: <code>Thor 1</code>, <code>Thor 2</code>, <code>Thor 10</code>.
            </li>
            <li>
              TV episodes use zero-padded <code>S01E01</code> style. Season markers are removed from TV folder names.
            </li>
            <li>Duplicate destination names in the same folder are blocked.</li>
            <li>The selected root folder is never renamed; only subfolders and files are changed.</li>
            <li>Ollama requests are sent in small batches so a large local model isn&apos;t asked to name dozens of files in one pass; any item it skips keeps its cleaned-up default name instead of failing the whole batch.</li>
            <li>Renaming needs &quot;edit&quot; permission on the folder — grant it when your browser prompts, or use the &quot;Grant edit access&quot; button if it appears.</li>
            <li>Review the proposed names before clicking rename. The operation changes the actual files/folders.</li>
          </ul>
        </details>
      </section>
    </main>
  );
}
