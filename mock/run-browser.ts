import { resolve } from 'node:path';
import { browserSmoke } from './browser-smoke.js';
import { rsiSmoke } from '../rsi/smoke.js';

const output = resolve('artifacts/browser');
console.log(JSON.stringify({ browser: await browserSmoke(output), selfImprovement: await rsiSmoke(resolve('artifacts/self-improvement')) }, null, 2));
