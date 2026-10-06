// The widget calls this while analyze-job is already running. maxDuration stays
// under the client's abort. DuckDuckGo HTML is parsed here when the extension
// fetched it; otherwise detectReposts uses its own search.
import { jobRepostsHandler } from '../lib/server/analyze.js';

export default jobRepostsHandler;
