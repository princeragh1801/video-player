// Bucket setup: create it if missing and set CORS so browsers can PUT multipart parts directly and
// read the ETag. Only PUT is allowed cross-origin — there is no browser GET access to the bucket.
import { fileURLToPath } from 'node:url';
import { PutBucketCorsCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { s3 } from './storage.js';
import { config } from './config.js';
import { logger } from './logger.js';

export async function ensureBucket() {
  const Bucket = config.storage.bucket;
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
    logger.info({ bucket: Bucket }, 'created bucket');
  }
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket,
        CORSConfiguration: {
          CORSRules: [
            { AllowedOrigins: config.corsOrigins, AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 },
          ],
        },
      }),
    );
    logger.info({ bucket: Bucket, origins: config.corsOrigins }, 'bucket CORS set');
  } catch (err) {
    if (err.name !== 'NotImplemented') throw err;
    logger.warn('bucket CORS not supported by this storage backend — skipping');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await ensureBucket();
}
