export type MatchResult<T = unknown> = {
  matched: boolean;
  data?: T;
};

export type StepResult = {
  handled: boolean;
  stop?: boolean;
};

export type PipelineStep<C, M = unknown> = {
  name: string;
  priority?: number;
  match: (ctx: C) => MatchResult<M>;
  run: (ctx: C, match: MatchResult<M>) => Promise<StepResult>;
};

export async function runPipeline<C>(ctx: C, steps: Array<PipelineStep<C, any>>): Promise<boolean> {
  const ordered = steps
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const step of ordered) {
    const match = step.match(ctx);
    if (!match.matched) continue;
    const result = await step.run(ctx, match);
    if (result.handled || result.stop) return true;
  }
  return false;
}
