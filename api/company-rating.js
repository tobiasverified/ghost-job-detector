// Same 15s maxDuration as api/analyze-job.js. This route can run the employee-search chain.
import { companyRatingHandler } from '../lib/server/company-rating.js';

export default companyRatingHandler;
