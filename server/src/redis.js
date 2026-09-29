import { Redis } from 'ioredis';
import { config } from './config.js';

// maxRetriesPerRequest: null is required by BullMQ for blocking connections.
export function createRedis() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

export const redis = createRedis();
