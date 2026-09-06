import { athleteDataTools } from './athlete-data.tools';
import { sessionManagementTools } from './session-management.tools';

export * from './tool-context.helper';
export * from './athlete-data.tools';
export * from './session-management.tools';

/** Read-only tools: safe for any agent that answers questions. */
export const coachReadTools = athleteDataTools;

/** Everything the plan coach can do, including rescheduling. */
export const coachTools = {
  ...athleteDataTools,
  ...sessionManagementTools,
};
