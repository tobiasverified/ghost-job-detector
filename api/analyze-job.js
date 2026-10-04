// maxDuration is 15s in vercel.json. background.js aborts this call at 12s
// and lib/widget.js waits 18s for the whole enrich message. Keep 15 above 12.
import { analyzeHandler } from '../lib/server/analyze.js';

export default analyzeHandler;
