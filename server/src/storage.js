import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

const { storage } = config;

function makeClient(endpoint) {
  return new S3Client({
    endpoint,
    region: storage.region,
    forcePathStyle: storage.forcePathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    // R2 doesn't support the newer default checksum headers on presigned URLs.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export const s3 = makeClient(storage.endpoint);
const presignClient = makeClient(storage.presignEndpoint);
const Bucket = storage.bucket;

// Object layout. The bucket is private; none of these keys are ever handed to the browser.
const P = storage.keyPrefix;
export const keys = {
  source: (videoId) => `${P}sources/${videoId}/original`,
  hlsPrefix: (videoId) => `${P}hls/${videoId}`,
};

export async function createMultipartUpload(key, contentType) {
  const out = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
  return out.UploadId;
}

// Presigned PUT for a single part — the only kind of URL we ever presign for the browser.
export function presignUploadPart(key, uploadId, partNumber) {
  return getSignedUrl(
    presignClient,
    new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: config.upload.presignTtlSeconds },
  );
}

export function completeMultipartUpload(key, uploadId, parts) {
  return s3.send(
    new CompleteMultipartUploadCommand({
      Bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }),
  );
}

export function abortMultipartUpload(key, uploadId) {
  return s3.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
}

export function headObject(key) {
  return s3.send(new HeadObjectCommand({ Bucket, Key: key }));
}

export function getObject(key, range) {
  return s3.send(new GetObjectCommand({ Bucket, Key: key, Range: range }));
}

export function putObject(key, body, contentType, cacheControl) {
  return s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
}

export function deleteObject(key) {
  return s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}
