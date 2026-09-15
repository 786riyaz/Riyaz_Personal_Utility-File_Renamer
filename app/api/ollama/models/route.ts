import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

export async function GET() {
  try {
    const response = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/tags`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const text = await response.text();
      return NextResponse.json({ error: `Ollama returned ${response.status}: ${text.slice(0, 300)}` }, { status: 502 });
    }
    const data = await response.json();
    const models = Array.isArray(data?.models)
      ? data.models.map((m: { name?: unknown }) => m?.name).filter((x: unknown): x is string => typeof x === "string")
      : [];
    return NextResponse.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: `Could not connect to Ollama at ${OLLAMA_URL}: ${message}` }, { status: 502 });
  }
}
