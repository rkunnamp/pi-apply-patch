import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyChanges,
  deriveNewContentsFromChunks,
  parsePatch,
  resolvePathInRoot,
  type ApplyPatchFileChange,
} from "./patch";

function loadDescription(): string {
  const p = path.join(__dirname, "apply_patch.txt");
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "Apply a high-level apply_patch diff to modify files.";
  }
}

async function writeTempFile(prefix: string, content: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "pi-apply-patch");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${Date.now()}.txt`);
  await fsp.writeFile(file, content, "utf-8");
  return file;
}

export default function applyPatchExtension(pi: ExtensionAPI) {
  const description = loadDescription();

  pi.registerTool({
    name: "apply_patch",
    label: "Apply Patch",
    description,
    parameters: Type.Object({
      patchText: Type.String({
        description: "The full apply_patch text between *** Begin Patch and *** End Patch",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const root = path.resolve(ctx.cwd);

      onUpdate?.({ content: [{ type: "text", text: "Parsing patch..." }] });
      const { hunks } = parsePatch(params.patchText);
      if (hunks.length === 0) {
        return {
          content: [{ type: "text", text: "No changes found in patch." }],
          details: { changed: [] },
        };
      }

      // Build a list of resolved file changes (absolute paths), and a diff preview.
      const changes: ApplyPatchFileChange[] = [];
      let diff = "";

      for (const hunk of hunks) {
        if (signal?.aborted) throw new Error("Cancelled");

        const p = resolvePathInRoot(root, hunk.path);

        if (hunk.type === "add") {
          changes.push({ type: "add", path: p.abs, content: hunk.contents });
          continue;
        }

        if (hunk.type === "delete") {
          changes.push({ type: "delete", path: p.abs });
          continue;
        }

        // update
        const moveAbs = hunk.move_path ? resolvePathInRoot(root, hunk.move_path).abs : undefined;
        const upd = deriveNewContentsFromChunks(p.abs, hunk.chunks);
        changes.push({
          type: "update",
          path: p.abs,
          move_path: moveAbs,
          new_content: upd.content,
          unified_diff: upd.unified_diff,
        });
        if (upd.unified_diff) {
          diff += `*** Update File: ${path.relative(root, moveAbs ?? p.abs)}\n`;
          diff += upd.unified_diff + "\n";
        }
      }

      // No confirmation prompt (always YOLO apply).

      onUpdate?.({ content: [{ type: "text", text: `Applying patch to ${changes.length} file(s)...` }] });
      const changedAbs = await applyChanges(changes, signal);
      const changedRel = changedAbs.map((p) => path.relative(root, p));

      // Store full diff in temp file if large; keep details small.
      let diffFile: string | undefined;
      let diffForContext = diff;
      const trunc = truncateHead(diffForContext, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      if (trunc.truncated) {
        diffFile = await writeTempFile("diff", diffForContext);
        diffForContext = trunc.content;
      }

      const summary = `${changedRel.length} file(s) changed`;
      const diffNote = diffFile ? `\n\n[Diff truncated. Full diff saved to: ${diffFile}]` : "";
      return {
        content: [
          {
            type: "text",
            text: `Patch applied successfully. ${summary}\n${changedRel.map((x) => "  " + x).join("\n")}${diffNote}`,
          },
        ],
        details: {
          changed: changedRel,
          diff: diffForContext,
          diffFile,
        },
      };
    },
  });
}
