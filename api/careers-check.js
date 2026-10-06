// Called after the score card is drawn, and only when analyze-job did not
// already compare a board. A cached open-roles board is reused.
import { careersHandler } from '../lib/server/analyze.js';

export default careersHandler;
