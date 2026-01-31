import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

export interface UpdateFileChunk {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
}

export type ApplyPatchFileChange =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string; content?: string }
  | {
      type: "update";
      path: string;
      unified_diff: string;
      move_path?: string;
      new_content: string;
    };

export interface ParsedApplyPatch {
  hunks: Hunk[];
}

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];

  if (line.startsWith("*** Add File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith("*** Delete File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith("*** Update File:")) {
    const filePath = line.split(":", 2)[1]?.trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;

    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].split(":", 2)[1]?.trim();
      nextIdx++;
    }

    return filePath ? { filePath, movePath, nextIdx } : null;
  }

  return null;
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("@@")) {
      const contextLine = lines[i].substring(2).trim();
      i++;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      let isEndOfFile = false;

      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
        const changeLine = lines[i];

        if (changeLine === "*** End of File") {
          isEndOfFile = true;
          i++;
          break;
        }

        if (changeLine.startsWith(" ")) {
          const content = changeLine.substring(1);
          oldLines.push(content);
          newLines.push(content);
        } else if (changeLine.startsWith("-")) {
          oldLines.push(changeLine.substring(1));
        } else if (changeLine.startsWith("+")) {
          newLines.push(changeLine.substring(1));
        }

        i++;
      }

      chunks.push({
        old_lines: oldLines,
        new_lines: newLines,
        change_context: contextLine || undefined,
        is_end_of_file: isEndOfFile || undefined,
      });
    } else {
      i++;
    }
  }

  return { chunks, nextIdx: i };
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  let content = "";
  let i = startIdx;

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) {
      content += lines[i].substring(1) + "\n";
    }
    i++;
  }

  if (content.endsWith("\n")) content = content.slice(0, -1);
  return { content, nextIdx: i };
}

export function parsePatch(patchText: string): ParsedApplyPatch {
  const lines = patchText.split("\n");
  const hunks: Hunk[] = [];

  const beginMarker = "*** Begin Patch";
  const endMarker = "*** End Patch";

  const beginIdx = lines.findIndex((l) => l.trim() === beginMarker);
  const endIdx = lines.findIndex((l) => l.trim() === endMarker);

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers");
  }

  let i = beginIdx + 1;
  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i++;
      continue;
    }

    if (lines[i].startsWith("*** Add File:")) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({ type: "add", path: header.filePath, contents: content });
      i = nextIdx;
      continue;
    }

    if (lines[i].startsWith("*** Delete File:")) {
      hunks.push({ type: "delete", path: header.filePath });
      i = header.nextIdx;
      continue;
    }

    if (lines[i].startsWith("*** Update File:")) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
      hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks });
      i = nextIdx;
      continue;
    }

    i++;
  }

  return { hunks };
}

export function resolvePathInRoot(rootAbs: string, p: string): { abs: string; rel: string } {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(rootAbs, p);
  const rel = path.relative(rootAbs, abs);
  if (rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))) {
    return { abs, rel: rel || "." };
  }
  throw new Error(`Path escapes project root: ${p}`);
}

export function deriveNewContentsFromChunks(fileAbsPath: string, chunks: UpdateFileChunk[]): {
  unified_diff: string;
  content: string;
} {
  let originalContent: string;
  try {
    originalContent = fs.readFileSync(fileAbsPath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read file ${fileAbsPath}: ${String(error)}`);
  }

  let originalLines = originalContent.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") originalLines.pop();

  const replacements = computeReplacements(originalLines, fileAbsPath, chunks);
  const newLines = applyReplacements(originalLines, replacements);

  // ensure trailing newline
  if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("");

  const newContent = newLines.join("\n");
  return {
    unified_diff: generateUnifiedDiff(originalContent, newContent),
    content: newContent,
  };
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.change_context) {
      const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
      if (contextIdx === -1) {
        throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
      }
      lineIndex = contextIdx + 1;
    }

    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.new_lines]);
      continue;
    }

    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(originalLines, pattern, lineIndex);

    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex);
    }

    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice]);
      lineIndex = found + pattern.length;
    } else {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
    }
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines];
  for (let i = replacements.length - 1; i >= 0; i--) {
    const [startIdx, oldLen, newSegment] = replacements[i];
    result.splice(startIdx, oldLen);
    for (let j = 0; j < newSegment.length; j++) result.splice(startIdx + j, 0, newSegment[j]);
  }
  return result;
}

function seekSequence(lines: string[], pattern: string[], startIndex: number): number {
  if (pattern.length === 0) return -1;

  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      if (lines[i + j] !== pattern[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  return -1;
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let diff = "@@ -1 +1 @@\n";
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] ?? "";
    const newLine = newLines[i] ?? "";

    if (oldLine !== newLine) {
      if (oldLine) diff += `-${oldLine}\n`;
      if (newLine) diff += `+${newLine}\n`;
      hasChanges = true;
    } else if (oldLine) {
      diff += ` ${oldLine}\n`;
    }
  }

  return hasChanges ? diff : "";
}

export async function applyChanges(changes: ApplyPatchFileChange[], signal?: AbortSignal): Promise<string[]> {
  const changed: string[] = [];

  for (const change of changes) {
    if (signal?.aborted) throw new Error("Cancelled");

    if (change.type === "add") {
      const dir = path.dirname(change.path);
      if (dir !== "." && dir !== "/") await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(change.path, change.content, "utf-8");
      changed.push(change.path);
      continue;
    }

    if (change.type === "delete") {
      await fsp.unlink(change.path).catch(() => {});
      changed.push(change.path);
      continue;
    }

    // update
    if (change.move_path) {
      const dir = path.dirname(change.move_path);
      if (dir !== "." && dir !== "/") await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(change.move_path, change.new_content, "utf-8");
      await fsp.unlink(change.path).catch(() => {});
      changed.push(change.move_path);
      continue;
    }

    await fsp.writeFile(change.path, change.new_content, "utf-8");
    changed.push(change.path);
  }

  return changed;
}
