import { NextRequest, NextResponse } from "next/server";
import { getMovieRenamerPrompt } from "@/lib/ollamaPrompt";
import { OLLAMA_REQUEST_TIMEOUT_MS } from "@/lib/config";

export const runtime = "nodejs";

const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:9b";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
// Safety net only — the client chunks requests to lib/config's
// OLLAMA_BATCH_SIZE by default, which is small enough for a local model to
// reliably name in one pass. This cap just stops an accidental huge
// request from tying up Ollama for minutes.
const MAX_ITEMS_PER_REQUEST = 60;
const DEBUG = process.env.OLLAMA_DEBUG === "1";

type InItem = { name: string; kind: "file" | "folder"; relativePath: string };

function stripExtension(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
function extension(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i) : "";
}

/**
 * Reasoning-capable models (qwen3.x, deepseek-r1, etc.) can put their whole
 * answer into Ollama's separate "thinking" field and leave "response"
 * completely empty — even when a structured `format` schema was requested
 * and the model answered correctly. That is exactly what was causing every
 * request to fail with "Ollama returned no usable names for this batch":
 * the JSON was there the whole time, just in a field this route never read.
 *
 * Two defenses, used together:
 *   1. The request below sends `think: false` to ask Ollama to turn
 *      reasoning off for this call, so the answer goes straight to
 *      "response" (supported on Ollama builds new enough to expose it for
 *      the given model).
 *   2. If "response" still comes back empty, fall back to "thinking", and
 *      strip any literal <think>...</think> wrapper some chat templates
 *      inline directly into plain text instead of a separate field.
 */
function extractRawText(data: { response?: unknown; thinking?: unknown }): string {
  const response = typeof data.response === "string" ? data.response.trim() : "";
  if (response) return stripThinkTags(response);
  const thinking = typeof data.thinking === "string" ? data.thinking.trim() : "";
  return stripThinkTags(thinking);
}

function stripThinkTags(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return stripped || text.trim();
}

/**
 * Parses whatever Ollama returned into a fixed-length array of suggestions
 * (one slot per input item, "" for anything the model skipped).
 *
 * This replaces the old behaviour of hard-failing the whole request with
 * "Ollama returned N names for M items." That error threw away every good
 * suggestion in the batch just because the count didn't line up exactly —
 * which happens often with local models on batches over ~15 items.
 *
 * The model is asked for {index, name} objects (see prompts/movie-renamer.txt)
 * specifically so a skipped or reordered item doesn't corrupt every
 * suggestion after it, the way a plain positional string array would.
 */
function parseSuggestions(raw: string, count: number): { suggestions: string[]; matched: number } {
  const suggestions = new Array<string>(count).fill("");
  let matched = 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Some models wrap the array in prose or code fences even when
    // structured output is requested. Try to salvage the first JSON array
    // in the text before giving up.
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return { suggestions, matched: 0 };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { suggestions, matched: 0 };
    }
  }

  // Preferred contract: array of { index, name } objects.
  if (Array.isArray(parsed) && parsed.length && parsed.every(x => x && typeof x === "object" && !Array.isArray(x))) {
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const idx = Number(entry.index);
      const name = entry.name;
      if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
      if (typeof name !== "string" || !name.trim()) continue;
      if (!suggestions[idx]) matched++;
      suggestions[idx] = name.trim();
    }
    return { suggestions, matched };
  }

  // Backward-compatible contract: a plain array of strings, matched by
  // position. Only trustworthy if the count is right, but we still take
  // whatever prefix lines up rather than discarding the whole batch.
  if (Array.isArray(parsed) && parsed.length && parsed.every(x => typeof x === "string")) {
    const arr = parsed as string[];
    for (let i = 0; i < Math.min(arr.length, count); i++) {
      if (!arr[i].trim()) continue;
      suggestions[i] = arr[i].trim();
      matched++;
    }
    return { suggestions, matched };
  }

  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { names?: unknown }).names)) {
    const arr = (parsed as { names: unknown[] }).names;
    for (let i = 0; i < Math.min(arr.length, count); i++) {
      const v = arr[i];
      if (typeof v !== "string" || !v.trim()) continue;
      suggestions[i] = v.trim();
      matched++;
    }
    return { suggestions, matched };
  }

  return { suggestions, matched: 0 };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const items: InItem[] = Array.isArray(body?.items)
      ? body.items
          .filter((x: unknown) => x && typeof x === "object" && typeof (x as { name?: unknown }).name === "string")
          .map((x: { name: string; kind?: string; relativePath?: string }) => ({
            name: x.name,
            kind: x.kind === "folder" ? ("folder" as const) : ("file" as const),
            relativePath: typeof x.relativePath === "string" ? x.relativePath : x.name,
          }))
      : [];
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;

    if (!items.length) {
      return NextResponse.json({ error: "No filenames supplied." }, { status: 400 });
    }
    if (items.length > MAX_ITEMS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Please send at most ${MAX_ITEMS_PER_REQUEST} filenames per request. The app normally chunks requests automatically into small batches — try again.` },
        { status: 400 }
      );
    }

    const prompt = getMovieRenamerPrompt(items);

    let response: Response;
    try {
      response = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          // Turn reasoning off so the answer lands in "response" instead of
          // a separate "thinking" channel. Ignored harmlessly by models
          // that don't support toggling it.
          think: false,
          format: {
            type: "array",
            minItems: items.length,
            maxItems: items.length,
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                name: { type: "string" },
              },
              required: ["index", "name"],
            },
          },
          options: { temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json(
        {
          error: timedOut
            ? `Ollama timed out after ${Math.round(OLLAMA_REQUEST_TIMEOUT_MS / 1000)}s for this batch. Try a smaller selection or a faster model.`
            : `Could not reach Ollama at ${OLLAMA_URL}: ${message}`,
        },
        { status: 502 }
      );
    }

    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json({ error: `Ollama returned ${response.status}: ${text.slice(0, 500)}` }, { status: 502 });
    }

    const data = await response.json();
    const raw = extractRawText(data);
    const { suggestions: rawSuggestions, matched } = parseSuggestions(raw, items.length);

    if (DEBUG) {
      console.log(`[ollama] model=${model} items=${items.length} matched=${matched} response_len=${(data?.response ?? "").length} thinking_len=${(data?.thinking ?? "").length}`);
    }

    if (matched === 0) {
      return NextResponse.json(
        {
          error: "Ollama returned no usable names for this batch. Try again, use a smaller selection, or switch models.",
          raw: raw.slice(0, 1000),
        },
        { status: 502 }
      );
    }

    // Server-side guard: force every suggested extension to match its source
    // extension. Unmatched slots stay "" so the client can fall back to its
    // own deterministic name for that item instead of the whole request
    // failing.
    const suggestions = rawSuggestions.map((suggestion, i) => {
      if (!suggestion) return "";
      const item = items[i];
      if (item.kind === "folder") return suggestion;
      const ext = extension(item.name);
      const withoutExt = stripExtension(suggestion);
      return `${withoutExt || stripExtension(item.name)}${ext}`;
    });

    return NextResponse.json({
      suggestions,
      model,
      matched,
      total: items.length,
      warning:
        matched < items.length
          ? `Ollama named ${matched}/${items.length} item(s) in this batch; the rest kept their cleaned-up default name.`
          : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Could not reach Ollama: ${message}` }, { status: 502 });
  }
}
