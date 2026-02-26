import { Env } from ".";

// src/check-vectors.ts
export async function checkVectorizedData(env: Env) {
  try {
    // Get vector index stats
    const stats = await env.VECTORIZE.describe();

    // Get sample vectors to see what's stored
    const sample = await env.VECTORIZE.query(
      new Array(1024).fill(0.1), // Random query
      { topK: 5, returnMetadata: true, returnValues: false }
    );

    return {
      success: true,
      index: {
        dimensions: (stats as any).dimensions,
        vectors_count: stats.vectorsCount,
        metric: (stats as any).metric
      },
      sample_vectors: sample.matches.map(match => ({
        id: match.id,
        score: match.score,
        metadata: match.metadata
      }))
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}