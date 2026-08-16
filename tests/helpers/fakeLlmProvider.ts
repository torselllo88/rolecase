import type {
  GenerateStructuredParams,
  GenerateStructuredResult,
  LlmProvider,
} from "../../src/llm/provider.js";

/**
 * Queues canned responses per schemaName so a single fake can serve an agent
 * that makes several different structured calls (or the same call across
 * writer/critic iterations) without the test having to guess call order.
 * Falls back to repeating the last queued response once a schema's queue is
 * exhausted, so tests only need to specify what actually varies.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly calls: GenerateStructuredParams<unknown>[] = [];
  private readonly callIndexBySchema: Record<string, number> = {};

  constructor(private readonly responsesBySchema: Record<string, unknown[]>) {}

  async generateStructured<T>(
    params: GenerateStructuredParams<T>
  ): Promise<GenerateStructuredResult<T>> {
    this.calls.push(params as GenerateStructuredParams<unknown>);

    const queue = this.responsesBySchema[params.schemaName];
    if (!queue || queue.length === 0) {
      throw new Error(`FakeLlmProvider: no queued response for schema "${params.schemaName}"`);
    }

    const index = this.callIndexBySchema[params.schemaName] ?? 0;
    const data = queue[Math.min(index, queue.length - 1)] as T;
    this.callIndexBySchema[params.schemaName] = index + 1;

    return {
      data,
      model: `fake-${params.consumer}`,
      tokenUsage: { promptTokens: 42, completionTokens: 24 },
    };
  }
}
