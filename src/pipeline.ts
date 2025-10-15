import { GitRepository } from './types/git';

export interface PipelineOptions {
  readonly repo: GitRepository;
}

export async function runPipeline(_options: PipelineOptions): Promise<void> {
  throw new Error('Pipeline engine not implemented yet.');
}
