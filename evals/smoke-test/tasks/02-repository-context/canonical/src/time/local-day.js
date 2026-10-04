export function localDay(iso,offsetMinutes){const ms=Date.parse(iso)+offsetMinutes*60000;return new Date(ms).toISOString().slice(0,10);}
