import { sha256 } from "../../core/src/hash.js";
import { positiveLimit } from "./contracts.js";
import { readRepositoryFile } from "./local-repository.js";

const STOP=new Set("a an the for of to in and or is are find files file where responsible".split(" "));
export function contextTokens(text) { return [...new Set(String(text).replace(/([a-z0-9])([A-Z])/g,"$1 $2").toLowerCase().match(/[a-z0-9]+/g)?.filter(t=>t.length>1&&!STOP.has(t))??[])]; }
const stem=path=>path.split("/").at(-1).replace(/\.(test|spec)(?=\.)/g,"").replace(/^(test_|spec_)/,"").replace(/\.[^.]+$/,"");
export class LexicalCandidateGenerator {
  constructor({candidateLimit=40,maxFileBytes=65536,maxTotalBytes=4*1024*1024,excerptChars=2000}={}) {
    Object.assign(this,{candidateLimit:positiveLimit(candidateLimit,"candidateLimit"),maxFileBytes:positiveLimit(maxFileBytes,"maxFileBytes"),maxTotalBytes:positiveLimit(maxTotalBytes,"maxTotalBytes"),excerptChars:positiveLimit(excerptChars,"excerptChars")});
  }
  async generate({task,repository}) {
    const terms=contextTokens(task.text),candidates=[],skipped=[];let readBytes=0,readFiles=0;
    for(const file of repository.files){
      if(readBytes>=this.maxTotalBytes){skipped.push({path:file,reason:"total_read_budget"});continue}
      const data=await readRepositoryFile(repository,file,Math.min(this.maxFileBytes,this.maxTotalBytes-readBytes));
      if(!data){skipped.push({path:file,reason:"size_or_non_text"});continue}
      readBytes+=data.byteLength;readFiles++;
      if(data.text===null){skipped.push({path:file,reason:"size_or_non_text"});continue}
      const pathTerms=new Set(contextTokens(file)),contentTerms=new Set(contextTokens(data.text));
      const pathMatches=terms.filter(t=>pathTerms.has(t)),contentMatches=terms.filter(t=>contentTerms.has(t));
      const score=pathMatches.length*2+contentMatches.length;if(!score)continue;
      const offset=Math.max(0,data.text.toLowerCase().indexOf(contentMatches[0]??"")-150);
      candidates.push({id:sha256({repositoryId:repository.repositoryId,path:file}),repositoryId:repository.repositoryId,path:file,sourceHash:data.sourceHash,
        excerpt:data.text.slice(offset,offset+this.excerptChars),retrieval:{method:"path-content-token-v1",score,pathMatches,contentMatches,
          relatedPaths:repository.files.filter(other=>other!==file&&stem(other)===stem(file)).slice(0,5)}});
    }
    candidates.sort((a,b)=>b.retrieval.score-a.retrieval.score||(a.path<b.path?-1:a.path>b.path?1:0));
    const matchedCount=candidates.length;
    return {candidates:candidates.slice(0,this.candidateLimit),evidence:{discoveredCount:repository.discoveredCount,listedCount:repository.files.length,readFiles,readBytes,matchedCount,skipped,discoveryTruncated:repository.discoveryTruncated,
      limits:{candidateLimit:this.candidateLimit,maxFileBytes:this.maxFileBytes,maxTotalBytes:this.maxTotalBytes,excerptChars:this.excerptChars}}};
  }
}
