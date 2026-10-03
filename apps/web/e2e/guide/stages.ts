/**
 * Which numbered steps a run has - "Step n of N" - from the selected stages and
 * switches. Pure, so the numbering can be tested.
 */
import type { GuideArgs } from './args';
import type { StageId } from './types';

export type StepKey = 'prep' | 'A' | 'B' | 'C' | 'D-profile' | 'D-key' | 'D-fund' | 'D-plan' | 'D-live' | 'E';

export interface GuideStep {
  key: StepKey;
  /** The stage this step belongs to (null: the checks before and the summary after). */
  stage: StageId | null;
  title: string;
}

export function planSteps(a: Pick<GuideArgs, 'stages' | 'planOnly' | 'throwawayKey'>): GuideStep[] {
  const steps: GuideStep[] = [{ key: 'prep', stage: null, title: 'Check this computer' }];
  if (a.stages.includes('A')) steps.push({ key: 'A', stage: 'A', title: 'Offline test suites' });
  if (a.stages.includes('B')) steps.push({ key: 'B', stage: 'B', title: 'Read-only live checks' });
  if (a.stages.includes('C')) steps.push({ key: 'C', stage: 'C', title: 'Builder account and fee tiers' });
  if (a.stages.includes('D')) {
    if (a.planOnly && a.throwawayKey) {
      steps.push({ key: 'D-plan', stage: 'D', title: 'Read-only plan with a throwaway key' });
    } else if (a.planOnly) {
      steps.push({ key: 'D-profile', stage: 'D', title: 'Choose what the live run tests' });
      steps.push({ key: 'D-key', stage: 'D', title: 'The test wallet' });
      steps.push({ key: 'D-plan', stage: 'D', title: 'Read-only plan' });
    } else {
      steps.push({ key: 'D-profile', stage: 'D', title: 'Choose what the live run tests' });
      steps.push({ key: 'D-key', stage: 'D', title: 'The test wallet' });
      steps.push({ key: 'D-fund', stage: 'D', title: 'Fund the test wallet' });
      steps.push({ key: 'D-live', stage: 'D', title: 'Live money run' });
    }
  }
  steps.push({ key: 'E', stage: null, title: 'Summary' });
  return steps;
}

/** "Step 3 of 8 - Read-only live checks". Throws for a step the run does not have (a bug, not a user error). */
export function stepHeading(steps: readonly GuideStep[], key: StepKey): { n: number; total: number; title: string; stage: StageId | null } {
  const i = steps.findIndex((s) => s.key === key);
  if (i < 0) throw new Error(`step ${key} is not part of this run`);
  const s = steps[i]!;
  return { n: i + 1, total: steps.length, title: s.title, stage: s.stage };
}

/** Does this run need the dev server (web + API on :5180)? */
export function needsDevServer(a: Pick<GuideArgs, 'stages'>): boolean {
  return a.stages.includes('B') || a.stages.includes('C') || a.stages.includes('D');
}

/** Can a real-funds run happen in this invocation at all? */
export function mayMoveFunds(a: Pick<GuideArgs, 'stages' | 'planOnly'>): boolean {
  return a.stages.includes('D') && !a.planOnly;
}
