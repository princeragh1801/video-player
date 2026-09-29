import { Queue } from 'bullmq';
import { createRedis } from './redis.js';

export const VIDEO_QUEUE = 'video-processing';

let queue;
export function videoQueue() {
  queue ??= new Queue(VIDEO_QUEUE, {
    connection: createRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return queue;
}

export async function enqueueTranscode({ videoId, jobId }) {
  // jobId = DB job id so a duplicate "complete" call can never enqueue twice.
  await videoQueue().add('transcode', { videoId, jobId }, { jobId });
}
