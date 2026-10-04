import {unavailable} from './unavailable.js';export const durationPerKm=(seconds,meters)=>meters>0?seconds/(meters/1000):unavailable();
