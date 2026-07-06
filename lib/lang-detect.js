/**
 * lib/lang-detect.js
 * Very lightweight language hint detection — no external dependency.
 * Good enough to decide "this prompt looks like Indonesian / Spanish / etc."
 * so a system prompt can be injected in the same language for a more
 * natural response. Not a real language-ID model; falls back to English
 * when confidence is low.
 */

const HINTS = [
  { lang: "Indonesian", re: /\b(yang|dengan|tidak|untuk|adalah|saya|kamu|ini|itu|dan|akan|sudah|bisa|dari|ke|di)\b/gi },
  { lang: "Spanish",    re: /\b(el|la|los|las|de|que|y|en|un|una|es|para|con|no|por)\b/gi },
  { lang: "French",     re: /\b(le|la|les|de|des|et|un|une|est|pour|avec|pas|dans)\b/gi },
  { lang: "German",     re: /\b(der|die|das|und|ist|nicht|f\u00fcr|mit|ein|eine|sich)\b/gi },
  { lang: "Portuguese", re: /\b(o|a|os|as|de|que|e|em|um|uma|\u00e9|para|com|n\u00e3o)\b/gi },
];

/**
 * Guess the language of a prompt using keyword-frequency heuristics.
 * @param {string} text
 * @returns {string|null} language name, or null if not confidently detected (assume English)
 */
export function detectLanguageHint(text) {
  if (!text || text.length < 8) return null;

  let best = null;
  let bestScore = 0;

  for (const { lang, re } of HINTS) {
    const matches = text.match(re);
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }

  // Require a couple of hits before trusting the guess on short prompts.
  return bestScore >= 2 ? best : null;
}
