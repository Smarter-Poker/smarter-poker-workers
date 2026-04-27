/**
 * TRIVIA QA VALIDATION — TS port for workers
 * ═════════════════════════════════════════════
 * Same 5-layer validation as monolith src/lib/triviaValidator.js (218 LOC).
 * Pure-functional, no Node-specific APIs — works in any TS runtime.
 *
 * Phase 2B.3 Option B port (2026-04-27).
 */

export interface TriviaQuestion {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
  category?: string;
  subcategory?: string;
  difficulty?: string;
  created_at?: string;
  last_used_at?: string | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  question: TriviaQuestion;
}

const VALID_POSITIONS = ['UTG', 'UTG+1', 'UTG+2', 'MP', 'MP+1', 'HJ', 'CO', 'BTN', 'SB', 'BB', 'EP', 'LP'];
const SPELLED_OUT_POSITIONS = [
  'Under-the-Gun', 'under-the-gun', 'middle position',
  'hijack', 'hi-jack', 'cutoff', 'cut-off', 'cut off',
  'button', 'Small-Blind', 'Big-Blind',
  'early position', 'late position',
  'on the button', 'in the blinds',
  'in the sb', 'in the bb', 'in the co', 'on the btn',
  'dealer', 'dealer button',
];
const STRATEGY_CATEGORIES = ['mtt_situations', 'cash_game_situations', 'icm_chip_ev', 'gto_scenarios', 'gto_theory'];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// CHECK 1: STRUCTURE
function checkStructure(q: TriviaQuestion): string[] {
  const errors: string[] = [];
  if (!q.question || typeof q.question !== 'string' || q.question.trim().length < 20)
    errors.push('STRUCT-01: Question text missing or too short');
  if (!Array.isArray(q.options) || q.options.length !== 4)
    errors.push(`STRUCT-02: Must have exactly 4 options (got ${q.options?.length ?? 0})`);
  else {
    q.options.forEach((opt, i) => {
      if (!opt || typeof opt !== 'string' || opt.trim().length < 3)
        errors.push(`STRUCT-03: Option ${i} is empty or too short`);
    });
    const normalized = q.options.map(o => o.toLowerCase().trim());
    if (new Set(normalized).size !== 4)
      errors.push('STRUCT-04: Duplicate options detected');
  }
  if (typeof q.correct_index !== 'number' || q.correct_index < 0 || q.correct_index > 3)
    errors.push(`STRUCT-05: Invalid correct_index: ${q.correct_index}`);
  if (!q.explanation || typeof q.explanation !== 'string' || q.explanation.trim().length < 30)
    errors.push('STRUCT-06: Explanation missing or too short');
  return errors;
}

// CHECK 2: SYNC CHECK — Answer ↔ Explanation alignment
function checkSync(q: TriviaQuestion): string[] {
  const errors: string[] = [];
  if (!q.options || !q.explanation || typeof q.correct_index !== 'number') return errors;
  const correctOption = q.options[q.correct_index];
  if (!correctOption) return ['SYNC-01: correct_index points to non-existent option'];
  const explanation = q.explanation.toLowerCase();
  const correctAction = correctOption.toLowerCase().split(/[\s,—-]+/)[0]!;
  const actionWords = ['fold', 'call', 'raise', 'shove', 'check', 'bet', 'limp', 'yes', 'no'];
  if (actionWords.includes(correctAction)) {
    const wrongOptions = q.options.filter((_, i) => i !== q.correct_index);
    for (const wrongOpt of wrongOptions) {
      const wrongAction = wrongOpt.toLowerCase().split(/[\s,—-]+/)[0]!;
      if (actionWords.includes(wrongAction) && wrongAction !== correctAction) {
        const correctCount = (explanation.match(new RegExp(`\\b${escapeRegex(correctAction)}\\b`, 'gi')) ?? []).length;
        const wrongCount = (explanation.match(new RegExp(`\\b${escapeRegex(wrongAction)}\\b`, 'gi')) ?? []).length;
        if (wrongCount > correctCount + 2)
          errors.push(`SYNC-02: Explanation mentions wrong action "${wrongAction}" (${wrongCount}x) more than correct "${correctAction}" (${correctCount}x)`);
      }
    }
  }
  const optionLetters = ['a', 'b', 'c', 'd'];
  const explicitMatch = explanation.match(/correct\s*(?:answer|option|play|choice)?\s*is\s*(?:option\s*)?([a-d])/i);
  if (explicitMatch && explicitMatch[1]) {
    const idx = optionLetters.indexOf(explicitMatch[1].toLowerCase());
    if (idx !== -1 && idx !== q.correct_index)
      errors.push(`SYNC-03: Explanation says correct answer is ${explicitMatch[1].toUpperCase()} but correct_index=${q.correct_index}`);
  }
  return errors;
}

// CHECK 3: MATH — Outs, pot odds, MDF, equity
function checkMath(q: TriviaQuestion): string[] {
  const errors: string[] = [];
  const fullText = `${q.question} ${q.explanation ?? ''}`;
  const outsPatterns = [
    { regex: /gutshot.*?(\d+)\s*outs/i, expected: 4, name: 'gutshot' },
    { regex: /(\d+)\s*outs.*?gutshot/i, expected: 4, name: 'gutshot' },
    { regex: /open.?ended\s*straight\s*draw.*?(\d+)\s*outs/i, expected: 8, name: 'OESD' },
    { regex: /OESD.*?(\d+)\s*outs/i, expected: 8, name: 'OESD' },
    { regex: /(\d+)\s*outs.*?OESD/i, expected: 8, name: 'OESD' },
    { regex: /flush\s*draw.*?(\d+)\s*outs/i, expected: 9, name: 'flush draw' },
    { regex: /(\d+)\s*outs.*?flush\s*draw/i, expected: 9, name: 'flush draw' },
  ];
  for (const pattern of outsPatterns) {
    const match = fullText.match(pattern.regex);
    if (match && match[1]) {
      const claimed = parseInt(match[1], 10);
      if (claimed !== pattern.expected)
        errors.push(`MATH-01: ${pattern.name} claimed ${claimed} outs but should be ${pattern.expected}`);
    }
  }
  const stackShoveMatch = fullText.match(/(\d+)\s*BB\s*effective.*?shoves?\s*(?:for\s*)?(\d+)\s*BB/i);
  if (stackShoveMatch && stackShoveMatch[1] && stackShoveMatch[2]) {
    const effective = parseInt(stackShoveMatch[1], 10);
    const shoveSize = parseInt(stackShoveMatch[2], 10);
    if (shoveSize > effective)
      errors.push(`MATH-02: Shove size (${shoveSize}BB) exceeds effective stack (${effective}BB)`);
  }
  const mdfMatch = fullText.match(/MDF.*?(\d+)%/i);
  if (mdfMatch && mdfMatch[1]) {
    const claimedMdf = parseInt(mdfMatch[1], 10);
    const betSizeMatch = fullText.match(/(\d+)%\s*(?:of\s*)?pot/i) ?? fullText.match(/pot[- ]?size[d]?\s*bet/i);
    if (betSizeMatch) {
      const betPct = betSizeMatch[1] ? parseInt(betSizeMatch[1], 10) : 100;
      const expectedMdf = Math.round((1 / (1 + betPct / 100)) * 100);
      if (Math.abs(claimedMdf - expectedMdf) > 5)
        errors.push(`MATH-04: MDF claimed ${claimedMdf}% but for ${betPct}% pot bet, MDF should be ~${expectedMdf}%`);
    }
  }
  return errors;
}

// CHECK 4: LOGIC — Impossible options
function checkLogic(q: TriviaQuestion): string[] {
  const errors: string[] = [];
  const isAllInSituation = /\b(shoves?\s*(all[- ]?in)?|all[- ]?in|jams?)\b/i.test(q.question);
  if (isAllInSituation) {
    const hasEqualEffective = /(\d+)\s*BB\s*effective/i.test(q.question);
    const hasRaiseOption = q.options?.some(o => /^raise/i.test(o.trim()));
    if (hasRaiseOption && hasEqualEffective) {
      const stackMentions = q.question.match(/(\d+)\s*BB/gi) ?? [];
      const uniqueStacks = new Set(stackMentions.map(s => parseInt(s, 10)));
      if (uniqueStacks.size <= 2)
        errors.push('LOGIC-01: "Raise" option when facing all-in with equal effective stacks');
    }
  }
  const isRiver = /river|final\s*board|complete\s*board|5th\s*street/i.test(q.question);
  if (isRiver) {
    const hasDrawImproveOption = q.options?.some(o =>
      /\b(draw\s*to|need.*outs|improve.*hand|chase|still\s*draw)\b/i.test(o)
    );
    if (hasDrawImproveOption)
      errors.push('LOGIC-02: Drawing/improving mentioned on the river — no more cards to come');
  }

  // --- BB ANTE RULE: Tournament antes must equal 1BB ---
  const fullText = `${q.question} ${q.explanation ?? ''}`;
  const blindsAnteMatch = fullText.match(/(\d[\d,]*)\/(\d[\d,]*).*?(\d[\d,]*)\s*ante/i);
  if (blindsAnteMatch && blindsAnteMatch[1] && blindsAnteMatch[2] && blindsAnteMatch[3]) {
    const bb = parseInt(blindsAnteMatch[2].replace(/,/g, ''), 10);
    const ante = parseInt(blindsAnteMatch[3].replace(/,/g, ''), 10);
    if (ante > 0 && ante !== bb) {
      errors.push(`LOGIC-07: Non-BB ante (blinds ${blindsAnteMatch[1]}/${blindsAnteMatch[2]}, ante ${ante}). Must use BB ante (ante = ${bb})`);
    }
  }
  if (!blindsAnteMatch) {
    const blindsOnly = fullText.match(/(\d[\d,]*)\/(\d[\d,]*)/);
    const anteOnly = fullText.match(/(\d[\d,]*)\s*ante/i) ?? fullText.match(/ante\s+(?:of\s+)?(\d[\d,]*)/i);
    if (blindsOnly && blindsOnly[2] && anteOnly && anteOnly[1]) {
      const bb2 = parseInt(blindsOnly[2].replace(/,/g, ''), 10);
      const ante2 = parseInt(anteOnly[1].replace(/,/g, ''), 10);
      if (ante2 > 0 && ante2 !== bb2) {
        errors.push(`LOGIC-07: Non-BB ante (BB=${bb2}, ante=${ante2}). Must use BB ante`);
      }
    }
  }

  return errors;
}

// CHECK 5: QUALITY — Scenario depth
function checkQuality(q: TriviaQuestion): string[] {
  const errors: string[] = [];
  if (q.category && STRATEGY_CATEGORIES.includes(q.category)) {
    if (!/\d+\s*BB/i.test(q.question))
      errors.push('QUAL-01: Strategy question missing stack size (BB)');
    const qLower = q.question.toLowerCase();
    const hasAbbrev = VALID_POSITIONS.some(pos => new RegExp(`\\b${pos}\\b`, 'i').test(q.question));
    const hasSpelled = SPELLED_OUT_POSITIONS.some(pos => qLower.includes(pos));
    if (!hasAbbrev && !hasSpelled && !/position/i.test(q.question))
      errors.push('QUAL-02: Strategy question missing position context');
    const hasCards = /[AKQJT2-9][♠♣♥♦hdcs]/i.test(q.question) || /pocket\s*[2-9AKQJT]/i.test(q.question);
    if (!hasCards)
      errors.push('QUAL-03: Strategy question missing specific hole cards');
  }
  if (q.explanation && q.explanation.length < 80)
    errors.push('QUAL-04: Explanation too brief');
  if (q.options) {
    const fillerPatterns = [/doesn't matter/i, /it's just luck/i, /who cares/i, /always fold/i, /none of the above/i];
    q.options.forEach((opt, i) => {
      for (const p of fillerPatterns)
        if (p.test(opt)) errors.push(`QUAL-06: Option ${i} looks like filler: "${opt.substring(0, 40)}"`);
    });
  }
  return errors;
}

// MASTER VALIDATOR
export function validateQuestion(q: TriviaQuestion): ValidationResult {
  const allErrors = [
    ...checkStructure(q),
    ...checkSync(q),
    ...checkMath(q),
    ...checkLogic(q),
    ...checkQuality(q),
  ];
  return { valid: allErrors.length === 0, errors: allErrors, question: q };
}

export function validateBatch(questions: TriviaQuestion[]): { valid: TriviaQuestion[]; rejected: ValidationResult[] } {
  const valid: TriviaQuestion[] = [];
  const rejected: ValidationResult[] = [];
  for (const q of questions) {
    const result = validateQuestion(q);
    if (result.valid) valid.push(q);
    else rejected.push(result);
  }
  return { valid, rejected };
}
