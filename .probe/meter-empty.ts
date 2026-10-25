import { contextMeterText, contextMeterTitle } from '../packages/core/src/models/Usage';
const fill = { usedTokens: 100, windowTokens: 200_000, autoCompaction: { off: 'unknown_window' as const, model: '' } };
console.log(contextMeterText(fill));
console.log(contextMeterTitle(fill));
