// Prompt construction for adversarial reviews. Task text is forwarded unchanged.
// Standard review does not build a prompt: /opencode:review runs OpenCode's
// built-in /review command, which collects the diff itself.

import fs from "node:fs";
import path from "node:path";

// Same inline limits as codex-plugin-cc. Larger reviews keep a file list and
// tell the model to inspect the diff, instead of pasting it into the prompt.
const INLINE_FILE_LIMIT = 2;
const INLINE_BYTE_LIMIT = 256 * 1024;

function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => (
    Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : ""
  ));
}

function section(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

/**
 * Build the adversarial review prompt. OpenCode has no adversarial command,
 * so this follows the Codex challenge-review contract and fills it from the
 * V2 VCS diff instead of a local git paste.
 * @param {string} pluginRoot
 * @param {object} input
 * @param {string} input.targetLabel
 * @param {string} [input.focus]
 * @param {Array<{ file: string, additions?: number, deletions?: number, status?: string }>} [input.files]
 * @param {Array<{ file: string, patch?: string }>} [input.diffs]
 * @returns {string}
 */
export function buildAdversarialReviewPrompt(pluginRoot, input) {
  const files = input.files ?? [];
  const diffs = input.diffs ?? [];
  const names = [...new Set([...files.map((file) => file.file), ...diffs.map((diff) => diff.file)].filter(Boolean))];
  const patchBytes = diffs.reduce((total, diff) => total + Buffer.byteLength(diff.patch || "", "utf8"), 0);
  const includeDiff = names.length <= INLINE_FILE_LIMIT && patchBytes <= INLINE_BYTE_LIMIT;
  const fileList = names.map((name) => {
    const file = files.find((item) => item.file === name);
    if (!file || file.additions == null) return name;
    return `${name} (${file.status || "modified"}, +${file.additions}/-${file.deletions || 0})`;
  }).join("\n");
  const diffBody = diffs.map((diff) => `### ${diff.file}\n${(diff.patch || "").trimEnd()}`).join("\n\n");
  const context = [
    section("Changed Files", fileList),
    includeDiff ? section("Diff", diffBody) : "",
  ].filter(Boolean).join("\n");
  const template = fs.readFileSync(path.join(pluginRoot, "prompts", "adversarial-review.md"), "utf8");
  return interpolateTemplate(template, {
    TARGET_LABEL: input.targetLabel,
    USER_FOCUS: input.focus || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: includeDiff
      ? "Use the repository context below as primary evidence."
      : "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.",
    REVIEW_INPUT: context.trim(),
  });
}
