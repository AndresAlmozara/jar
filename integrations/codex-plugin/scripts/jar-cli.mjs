#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home=process.env.JAR_HOME || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(),".jar");
const current=JSON.parse(fs.readFileSync(path.join(home,"current.json"),"utf8"));
const runtime=await import(pathToFileURL(path.join(current.runtimeRoot,current.entrypoint)).href);
const command=process.argv[2] || "status";
const result=command==="doctor" ? await runtime.doctorReport({jarHome:home,current}) : await runtime.statusReport({jarHome:home,current});
process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
process.exitCode=result.ok===false?2:0;
