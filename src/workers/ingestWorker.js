#!/usr/bin/env node

const { parentPort } = require('worker_threads');
const path = require('path');
const { ingestImage } = require('../insert');

if (!parentPort) {
    throw new Error('ingestWorker must be run as a worker thread');
}

function resolvePath(filePath) {
    if (!filePath) return filePath;
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(process.cwd(), filePath);
}

async function handleIngest(job) {
    const { file, discoverIterations = 0 } = job;
    try {
        const resolvedFile = resolvePath(file);
        const result = await ingestImage(resolvedFile, discoverIterations);
        parentPort.postMessage({
            type: 'result',
            payload: {
                file: resolvedFile,
                ...result,
            },
        });
    } catch (error) {
        parentPort.postMessage({
            type: 'error',
            payload: {
                file: job.file,
                message: error?.message ?? 'Unknown ingestion failure',
                stack: error?.stack,
            },
        });
    }
}

parentPort.on('message', async (message) => {
    if (!message || typeof message.type !== 'string') {
        return;
    }
    switch (message.type) {
        case 'ingest':
            await handleIngest(message.payload ?? {});
            break;
        case 'shutdown':
            parentPort.postMessage({ type: 'shutdown_ack' });
            process.exit(0);
            break;
        default:
            parentPort.postMessage({
                type: 'error',
                payload: { message: `Unknown message type '${message.type}'` },
            });
    }
});
