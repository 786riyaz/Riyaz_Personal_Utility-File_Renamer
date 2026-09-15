# Riyaz_Personal_Utility-File_Renamer
to store the code of file renamer tool created for personal use


# Movie File Renamer

A local Next.js tool that scans a folder (recursively), proposes clean
`Title (YEAR).ext` / `Series SxxExx.ext` names, optionally asks a local
Ollama model for suggestions, and renames the actual files/folders on disk
using the File System Access API (Chrome/Edge desktop only).

## Run it

```bash
npm install
npm run build
npm start
```

Then open http://localhost:3000 in **Chrome or Edge on desktop** (the
File System Access API isn't available in Firefox/Safari or on mobile).

Ollama is optional. If you want AI-assisted naming, have Ollama running
locally (`ollama serve`, default `http://127.0.0.1:11434`) with at least
one model pulled (e.g. `ollama pull qwen2.5:7b`). You can override the
endpoint/model with env vars:

```bash
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b
```

## What was fixed in this pass

1. **"Ollama returned 30 names for 34 items." errors killed the whole
   batch.** The API now asks Ollama for `{"index": N, "name": "..."}`
   objects instead of a plain array of strings, matches each suggestion
   back to its item by index, and never hard-fails on a count mismatch —
   any item the model skips simply falls back to the deterministic
   cleaned-up name instead of the request erroring out. The UI also now
   sends Ollama requests in small batches (12 items by default, see
   `lib/config.ts`), since local 7B-class models get unreliable once a
   single JSON response has to contain dozens of reasoned entries. If a
   batch still comes back with gaps, the app automatically retries once for
   just the missing items.

2. **"Failed to execute 'move' ... The request is not allowed by the user
   agent or the platform in the current context."** This happened because
   `showDirectoryPicker()` only grants **read** access by default —
   `FileSystemHandle.move()` needs **readwrite**. Folder selection now
   requests `{ mode: "readwrite" }` up front, the app checks/re-requests
   that permission right before renaming, and if the browser ever denies
   it you'll see a clear "Grant edit access" button instead of every row
   failing silently with a cryptic message.

3. **Franchise / sequel numbering** (`Iron Man 1/2/3`, `Thor 2 - The Dark
   World`, `X-Men 1…12`, etc.) was already handled correctly by the prompt
   and the deterministic parser's safety checks — those rules are
   preserved as-is.

4. **"This browser does not expose the native rename operation" for
   folders, while files renamed fine.** Chrome/Edge shipped
   `FileSystemFileHandle.move()` before they shipped
   `FileSystemDirectoryHandle.move()`, so on some browser versions files
   can be renamed natively but folders can't. Renaming now tries the fast
   native `move()` first, and if that method isn't available on the handle
   (or fails for a reason other than a permission problem), automatically
   falls back to a manual copy-then-delete using `getFileHandle` /
   `getDirectoryHandle` / `createWritable` / `removeEntry` — much older,
   far more broadly supported APIs. Folders are copied recursively
   (including files not part of the rename job, e.g. `.srt`/`.nfo`
   siblings) so nothing inside gets left behind.

5. **Folder names could keep a leftover season marker** (e.g. "Operation
   Safed Sagar S01" instead of "Operation Safed Sagar") when an Ollama
   candidate name failed to strip it. The safety checks that decide
   whether to trust an AI-suggested name now explicitly reject a folder
   candidate that still has a bare `S01`-style marker when the
   deterministic parser cleanly removed it, falling back to the
   deterministic name in that case.

## Notes

- The selected root folder itself is never renamed, only its contents.
- Files are renamed before folders, and folders deepest-first.
- Duplicate destination names inside the same folder are blocked before
  any renaming starts.
- Everything runs locally; no data leaves your machine except requests to
  your own local Ollama instance.
