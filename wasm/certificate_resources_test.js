'use strict';
// Compile the production serialization/loading methods with real OpenSSL.
// Only the JS binding and certificate generator are replaced by test fixtures.
const fs=require('fs'),cp=require('child_process'),path=require('path');
const source=fs.readFileSync('wasm/http.cpp','utf8');
const methods=source.slice(source.indexOf('X509* g_Cert;'),source.indexOf('MessageResult MoonlightInstance::HttpInit'));
if(!methods.includes('MoonlightInstance::LoadCert'))throw Error('Methods not found');
const fixture=`
#include <openssl/pem.h>
#include <openssl/pkcs12.h>
#include <memory>
#include <string>
#include <map>
#include <cstring>
#include <cassert>
#include <iostream>
namespace emscripten {
struct val {
 std::string text; std::map<std::string,std::string> fields;
 val()=default; explicit val(std::string s):text(s){}
 static val object(){return {};}
 void set(const char* k,const val& v){fields[k]=v.text;}
};
}
struct MessageResult {
 bool ok; emscripten::val data;
 static MessageResult Resolve(emscripten::val v){return {true,v};}
 static MessageResult Reject(emscripten::val v){return {false,v};}
};
enum class LoadResult {Success,CertErr,PrivateKeyErr};
class MoonlightInstance {
public: MessageResult MakeCert(); LoadResult LoadCert(const char*,const char*);
};
struct CERT_KEY_PAIR {X509* x509; EVP_PKEY* pkey; PKCS12* p12;};
bool failGeneration=false; int freedBundles=0;
CERT_KEY_PAIR mkcert_generate(){
 if(failGeneration)return {nullptr,nullptr,nullptr};
 EVP_PKEY_CTX* ctx=EVP_PKEY_CTX_new_id(EVP_PKEY_RSA,nullptr);assert(ctx);
 assert(EVP_PKEY_keygen_init(ctx)>0);assert(EVP_PKEY_CTX_set_rsa_keygen_bits(ctx,2048)>0);
 EVP_PKEY* key=nullptr;assert(EVP_PKEY_keygen(ctx,&key)>0);EVP_PKEY_CTX_free(ctx);
 X509* cert=X509_new();assert(cert);X509_set_version(cert,2);
 ASN1_INTEGER_set(X509_get_serialNumber(cert),1);
 X509_gmtime_adj(X509_get_notBefore(cert),0);X509_gmtime_adj(X509_get_notAfter(cert),86400);
 X509_set_pubkey(cert,key);auto* name=X509_get_subject_name(cert);
 X509_NAME_add_entry_by_txt(name,"CN",MBSTRING_ASC,(const unsigned char*)"fixture.invalid",-1,-1,0);
 X509_set_issuer_name(cert,name);assert(X509_sign(cert,key,EVP_sha256())>0);
 PKCS12* p12=PKCS12_create("fixture","fixture",key,cert,nullptr,0,0,0,0,0);assert(p12);
 return {cert,key,p12};
}
void mkcert_free(CERT_KEY_PAIR p){X509_free(p.x509);EVP_PKEY_free(p.pkey);PKCS12_free(p.p12);freedBundles++;}
`;
const tests=`
int main(){
 MoonlightInstance app;
 auto result=app.MakeCert();assert(result.ok && freedBundles==1);
 const auto& cert=result.data.fields.at("cert");const auto& key=result.data.fields.at("privateKey");
 for(int i=0;i<100;i++){
   assert(app.LoadCert(cert.c_str(),key.c_str())==LoadResult::Success);
   assert(X509_check_private_key(g_Cert,g_PrivateKey)==1);
   assert(strlen(g_CertHex)==cert.size()*2);
   std::string decoded;
   for(size_t j=0;j<cert.size();j++){unsigned n=0;assert(sscanf(g_CertHex+2*j,"%2x",&n)==1);decoded+=char(n);}
   assert(decoded==cert);
   auto* oldCert=g_Cert;auto* oldKey=g_PrivateKey;auto* oldHex=g_CertHex;
   assert(app.LoadCert("invalid",key.c_str())==LoadResult::CertErr);
   assert(app.LoadCert(cert.c_str(),"invalid")==LoadResult::PrivateKeyErr);
   assert(app.LoadCert("","")==LoadResult::CertErr);
   assert(g_Cert==oldCert && g_PrivateKey==oldKey && g_CertHex==oldHex);
 }
 failGeneration=true;assert(!app.MakeCert().ok && freedBundles==2);
 X509_free(g_Cert);EVP_PKEY_free(g_PrivateKey);free(g_CertHex);
 std::cout<<"certificate_resources_test: PEM output, reload, errors and temporary ownership OK\\n";
}
`;
const tmp=fs.mkdtempSync('/tmp/moonlight-cert-test-');
const cpp=path.join(tmp,'test.cpp'),bin=path.join(tmp,'test');
fs.writeFileSync(cpp,fixture+methods+tests);
cp.execFileSync('g++',['-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',cpp,'-lssl','-lcrypto','-o',bin],{stdio:'inherit'});
cp.execFileSync(bin,[],{stdio:'inherit',env:{...process.env,ASAN_OPTIONS:'detect_leaks=1',UBSAN_OPTIONS:'halt_on_error=1'}});
