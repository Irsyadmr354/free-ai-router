/**
 * lib/templates.js
 * Loads prompt templates from ./templates/*.md so common prompts (code
 * review, summarize, translate, etc.) can be reused by name instead of
 * retyped every time.
 *
 * Template files are plain Markdown with optional {{placeholder}} tokens
 * that get substituted with values passed at call time.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join, basename } from "path";

const TEMPLATES_DIR = resolve(process.env.TEMPLATES_DIR ?? "./templates");

/**
 * List available template names (file basenames without .md).
 * @returns {string[]}
 */
export function listTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"));
}

/**
 * Load a template's raw content by name.
 * @param {string} name
 * @returns {string}
 */
export function loadTemplate(name) {
  const path = join(TEMPLATES_DIR, `${name}.md`);
  if (!existsSync(path)) {
    const available = listTemplates();
    throw new Error(`Template "${name}" not found in ${TEMPLATES_DIR}. Available: ${available.length ? available.join(", ") : "(none)"}`);
  }
  return readFileSync(path, "utf8");
}

/**
 * Fill {{placeholder}} tokens in a template with provided values.
 * Unfilled placeholders are left as-is (visible, so mistakes are obvious).
 * @param {string} template
 * @param {Record<string,string>} vars
 * @returns {string}
 */
export function fillTemplate(template, vars = {}) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
  });
}
