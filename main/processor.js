const FILLERS = [
  'uhm', 'uh', 'uhh', 'uhhh', 'umm', 'um', 'umh', 'erm', 'ah', 'ahh', 'er', 'hmm'
];

function cleanupText(text) {
  if (!text) return '';

  let processed = text.trim();

  // 1. Filler removal (case insensitive)
  const fillerRegex = new RegExp(`\\b(${FILLERS.join('|')})\\b`, 'gi');
  processed = processed.replace(fillerRegex, '');

  // 2. Duplicate word removal (case insensitive, captures "word word")
  // This will keep the first occurrence
  processed = processed.replace(/\b(\w+)\s+\1\b/gi, '$1');

  // 3. Whitespace normalization
  processed = processed.replace(/\s+/g, ' ');
  processed = processed.trim();

  // 4. Basic punctuation/grammar (Simple rules as requested)
  // Capitalize first letter only if there's content
  if (processed.length > 0) {
    processed = processed.charAt(0).toUpperCase() + processed.slice(1);
  }

  // Only add period if:
  // - Text is longer than 20 chars (likely a sentence, not a command)
  // - Doesn't already end with punctuation
  if (processed.length > 20 && !/[.!?]$/.test(processed)) {
    processed += '.';
  }

  return processed;
}

module.exports = { cleanupText };
