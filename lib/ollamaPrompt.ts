import fs from "node:fs";
import path from "node:path";

const promptPath = path.join(process.cwd(), "prompts", "movie-renamer.txt");

export function getMovieRenamerPrompt(items: Array<{ name: string; kind: "file" | "folder"; relativePath?: string }>) {
  const template = fs.readFileSync(promptPath, "utf8");
  const input = items.map((item, index) => ({
    index,
    kind: item.kind,
    name: item.name,
    relativePath: item.relativePath || item.name,
  }));
  return `${template}

INPUT BATCH — exactly ${items.length} item(s), indexes 0 to ${items.length - 1}.
You MUST return exactly ${items.length} objects in your JSON array, one per index, with no gaps and no duplicates.

${JSON.stringify(input, null, 2)}
`;
}
