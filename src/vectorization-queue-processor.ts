// src/vectorization-queue-processor.ts
// Handles processing of the vectorization queue for incremental updates

import { queryAll, queryOne, queryExecute } from './db-utils';
import { vectorizeProperties, vectorizeSingleProperty } from './vectorize';

export interface Env {
  HYPERDRIVE: any;
  VECTORIZE: VectorizeIndex;
  AI: any;
}

export interface QueueJob {
  id: number;
  property_id: string;
  source_table: 'sellers' | 'rental_owners';
  action: 'insert' | 'update' | 'delete';
  created_at: string;
  retry_count: number;
}

/**
 * Process pending vectorization jobs from the queue
 * Called by scheduled handler or manually triggered
 */
export async function processVectorizationQueue(env: Env, maxJobs: number = 50): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
}> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`VECTORIZATION QUEUE PROCESSOR - Batch Size: ${maxJobs}`);
  console.log(`${'='.repeat(80)}\n`);

  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;
  const errors: string[] = [];

  try {
    // Get pending jobs (max retries: 3)
    const { results: jobs } = await queryAll<QueueJob>(
      env,
      `SELECT id, property_id, COALESCE(source_table, 'sellers') as source_table, action, created_at, retry_count
       FROM vectorization_queue
       WHERE status = 'pending' AND retry_count < 3
       ORDER BY created_at ASC
       LIMIT ?`,
      [maxJobs]
    );

    if (!jobs || jobs.length === 0) {
      console.log('✓ No pending jobs in vectorization queue');
      return {
        processed: 0,
        succeeded: 0,
        failed: 0,
        errors: []
      };
    }

    console.log(`Found ${jobs.length} pending jobs to process\n`);

    // Process each job
    for (const job of jobs) {
      try {
        processedCount++;

        // Mark as processing
        await queryExecute(
          env,
          `UPDATE vectorization_queue SET status = 'processing' WHERE id = ?`,
          [job.id]
        );

        console.log(`[Job ${job.id}] Processing ${job.action} for property ${job.property_id}...`);

        // Handle different action types
        switch (job.action) {
          case 'insert':
          case 'update':
            // Vectorize/re-vectorize the property using the correct source table
            const result = await vectorizeSingleProperty(env, job.property_id, job.source_table);

            if (result.success) {
              successCount++;
              console.log(`  ✓ Successfully vectorized property (${result.vectors_indexed} vectors)`);

              // Mark job as completed
              await queryExecute(
                env,
                `UPDATE vectorization_queue 
                 SET status = 'completed', processed_at = NOW() 
                 WHERE id = ?`,
                [job.id]
              );
            } else {
              failedCount++;
              const errorMsg = result.error || 'Unknown vectorization error';
              console.log(`  ✗ Vectorization failed: ${errorMsg}`);

              // Mark job as failed
              await queryExecute(
                env,
                `UPDATE vectorization_queue 
                 SET status = 'failed', 
                     error_message = ?,
                     retry_count = retry_count + 1,
                     processed_at = NOW()
                 WHERE id = ?`,
                [errorMsg.substring(0, 255), job.id]
              );

              errors.push(`Job ${job.id}: ${errorMsg}`);
            }
            break;

          case 'delete':
            // Delete vectors for this property from the index
            const prefix = job.source_table === 'rental_owners' ? 'rental' : 'seller';
            const vectorIds = [
              `${prefix}_${job.property_id}_main`,
              `${prefix}_${job.property_id}_keywords`
            ];
            try {
              await env.VECTORIZE.deleteByIds(vectorIds);
              console.log(`  ✓ Deleted vectors: ${vectorIds.join(', ')}`);
            } catch (delErr: any) {
              // Vectorize may throw if IDs don't exist — safe to ignore
              console.log(`  ⚠ Vector deletion note: ${delErr.message}`);
            }
            successCount++;

            // Mark job as completed
            await queryExecute(
              env,
              `UPDATE vectorization_queue
               SET status = 'completed', processed_at = NOW()
               WHERE id = ?`,
              [job.id]
            );
            break;

          default:
            throw new Error(`Unknown action type: ${job.action}`);
        }

        // Rate limiting between jobs
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (jobError: any) {
        failedCount++;
        const errorMsg = `Error processing job ${job.id}: ${jobError.message}`;
        console.error(`  ✗ ${errorMsg}`);
        errors.push(errorMsg);

        // Mark job as failed with error details
        await queryExecute(
          env,
          `UPDATE vectorization_queue 
           SET status = 'failed', 
               error_message = ?,
               retry_count = retry_count + 1,
               processed_at = NOW()
           WHERE id = ?`,
          [errorMsg.substring(0, 255), job.id]
        ).catch(err => console.warn(`Failed to update job status: ${err.message}`));
      }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`QUEUE PROCESSING COMPLETE`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Processed: ${processedCount}`);
    console.log(`Succeeded: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    if (errors.length > 0) {
      console.log(`\nErrors:`);
      errors.slice(0, 5).forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
      if (errors.length > 5) {
        console.log(`  ... and ${errors.length - 5} more`);
      }
    }

    return {
      processed: processedCount,
      succeeded: successCount,
      failed: failedCount,
      errors
    };

  } catch (error: any) {
    console.error('\n❌ FATAL QUEUE PROCESSING ERROR:', error.message);
    return {
      processed: processedCount,
      succeeded: successCount,
      failed: processedCount - successCount,
      errors: [...errors, `Fatal error: ${error.message}`]
    };
  }
}

/**
 * Get vectorization queue status
 */
export async function getQueueStatus(env: Env): Promise<{
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  oldest_pending_job?: { id: number; property_id: string; created_at: string };
}> {
  try {
    const stats = await queryAll<any>(
      env,
      `SELECT 
         status,
         COUNT(*) as count
       FROM vectorization_queue
       GROUP BY status`
    );

    const statusMap = new Map<string, number>();
    for (const row of stats.results) {
      statusMap.set(row.status, row.count);
    }

    const oldestPending = await queryOne<any>(
      env,
      `SELECT id, property_id, created_at
       FROM vectorization_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    );

    return {
      pending: statusMap.get('pending') || 0,
      processing: statusMap.get('processing') || 0,
      completed: statusMap.get('completed') || 0,
      failed: statusMap.get('failed') || 0,
      oldest_pending_job: oldestPending || undefined
    };
  } catch (error: any) {
    console.error('Error getting queue status:', error);
    throw error;
  }
}

/**
 * Clear completed jobs from queue (for maintenance)
 */
export async function clearCompletedJobs(env: Env, olderThanDays: number = 7): Promise<number> {
  try {
    const result = await queryExecute(
      env,
      `DELETE FROM vectorization_queue
       WHERE status = 'completed' 
       AND processed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [olderThanDays]
    );

    console.log(`Cleared ${result?.[0]?.affectedRows || 0} completed jobs older than ${olderThanDays} days`);
    return result?.[0]?.affectedRows || 0;
  } catch (error: any) {
    console.error('Error clearing completed jobs:', error);
    throw error;
  }
}
