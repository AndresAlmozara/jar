import { readFile } from "node:fs/promises";
const paths=process.argv.slice(2);if(paths.length!==2)throw new Error("Expected baseline and filtered receipts");
const rows=await Promise.all(paths.map(async path=>JSON.parse(await readFile(path,"utf8"))));
const expected=[{tool_alpha:"PRESENT",tool_beta:"PRESENT",tool_gamma:"PRESENT"},{tool_alpha:"PRESENT",tool_beta:"ABSENT",tool_gamma:"PRESENT"}];
for(let i=0;i<2;i++){const row=rows[i];if(row.completeness!=="COMPLETE"||row.admissionId!==rows[0].admissionId||row.admittedProfileId!==rows[0].admittedProfileId)throw new Error("Capture admission/completeness mismatch");const states=Object.fromEntries(Object.keys(expected[i]).map(name=>[name,row.tools.some(t=>t.nativeId===name)?"PRESENT":"ABSENT"]));if(JSON.stringify(states)!==JSON.stringify(expected[i])||row.tools.some(t=>!Object.hasOwn(expected[i],t.nativeId)))throw new Error("Schema withholding acceptance failed");}
console.log(JSON.stringify({schemaVersion:"m11.schema-withholding-evaluation.v1",outcome:"VERIFIED_SCHEMA_WITHHOLDING",admissionId:rows[0].admissionId,admittedProfileId:rows[0].admittedProfileId},null,2));
