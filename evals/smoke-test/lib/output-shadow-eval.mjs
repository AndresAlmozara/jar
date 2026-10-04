import fs from 'node:fs';
import crypto from 'node:crypto';

const [corpusPath,truthPath]=process.argv.slice(2);
const text=fs.readFileSync(corpusPath,'utf8'),truth=JSON.parse(fs.readFileSync(truthPath,'utf8'));
const lines=text.split(/\r?\n/),critical=lines.filter(line=>/^(ERROR|STACK|ARTIFACT)\b|retry=no\b/.test(line));
const progress=lines.filter(line=>line.startsWith('PROGRESS '));
const retained=[`summary: ${progress.length} progress events processed successfully`,...critical].join('\n');
const markers=truth.mustKeepMarkers??[],recall=markers.length?markers.filter(marker=>retained.includes(marker)).length/markers.length:null;
console.log(JSON.stringify({status:'would_apply',reason:'reduced',outcome:'reduced',originalChars:text.length,retainedChars:retained.length,
  reductionRatio:(text.length-retained.length)/text.length,mustKeepMarkers:markers,mustKeepRecall:recall,recoveryAvailable:true,
  recoveryRef:'sha256:'+crypto.createHash('sha256').update(text).digest('hex'),activeRuntimeEffect:false}));
