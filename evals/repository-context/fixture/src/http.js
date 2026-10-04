import { retryDelay } from "./retry.js";
// HTTP backoff planner consumes retry configuration supplied by the caller.
export function scheduleRequest(attempt, config) { return retryDelay(attempt, config); }
