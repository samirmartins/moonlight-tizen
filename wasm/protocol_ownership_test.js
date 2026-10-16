'use strict';
const fs=require('fs'),cp=require('child_process'),path=require('path');
const tmp=fs.mkdtempSync(path.join(require('os').tmpdir(),'moonlight-protocol-test-'));
try{
 fs.writeFileSync(path.join(tmp,'emscripten.h'),'#define EM_LOG_CONSOLE 0\n#define emscripten_log(...) ((void)0)\n');
 const file=path.join(tmp,'test.c'),bin=path.join(tmp,'test');
 fs.writeFileSync(file,`
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include "Rtsp.h"
static POPTION_ITEM node(int owned,char* value){
 POPTION_ITEM n=calloc(1,sizeof(*n));assert(n);
 n->option=owned?strdup("CSeq"):"CSeq";n->content=owned?strdup(value):value;
 n->flags=owned?FLAG_ALLOCATED_OPTION_FIELDS:0;return n;
}
int main(){
 for(int i=0;i<1000;i++)for(int a=0;a<2;a++)for(int b=0;b<2;b++){
  POPTION_ITEM head=NULL;insertOption(&head,node(a,"1"));insertOption(&head,node(b,"2"));
  assert(head&&!head->next&&!strcmp(getOptionContent(head,"CSeq"),"2"));
  freeOptionList(head);
 }
 char response[]="RTSP/1.0 200 OK\\r\\nCSeq: 1\\r\\nCSeq: 2\\r\\n\\r\\n";
 RTSP_MESSAGE msg;
 assert(parseRtspMessage(&msg,response,strlen(response))==RTSP_ERROR_SUCCESS);
 assert(!strcmp(getOptionContent(msg.options,"CSeq"),"2"));freeMessage(&msg);
 assert(parseRtspMessage(&msg,response,-1)==RTSP_ERROR_MALFORMED);
 assert(parseRtspMessage(&msg,NULL,3)==RTSP_ERROR_MALFORMED);
 char truncated[]="RTSP/1.0 200 OK\\r\\nCSeq: 1";
 assert(parseRtspMessage(&msg,truncated,strlen(truncated))==RTSP_ERROR_MALFORMED);
 return 0;
}
`);
 cp.execFileSync('gcc',['-std=c99','-D_POSIX_C_SOURCE=200809L','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-I'+tmp,'-Imoonlight-common-c/src',file,'moonlight-common-c/src/RtspParser.c','-o',bin],{stdio:'inherit'});
 cp.execFileSync(bin,[],{stdio:'inherit',timeout:10000,env:{...process.env,ASAN_OPTIONS:'detect_leaks=1',UBSAN_OPTIONS:'halt_on_error=1'}});
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log('protocol_ownership_test: duplicate headers with all ownership combinations, truncated and invalid inputs pass ASan/LSan/UBSan');
