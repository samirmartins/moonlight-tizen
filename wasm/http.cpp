#include "moonlight_wasm.hpp"

#include <http.h>
#include <errors.h>
#include <string.h>
#include <memory>

#include <mkcert.h>
#include <openssl/bio.h>
#include <openssl/pem.h>

#include <curl/curl.h>

X509* g_Cert;
EVP_PKEY* g_PrivateKey;
char* g_UniqueId;
char* g_CertHex;

MessageResult MoonlightInstance::MakeCert() {
  CERT_KEY_PAIR certKeyPair = mkcert_generate();
  struct CertCleanup {
    CERT_KEY_PAIR value;
    ~CertCleanup() { mkcert_free(value); }
  } cleanup{certKeyPair};

  std::unique_ptr<BIO, decltype(&BIO_free)> bio(BIO_new(BIO_s_mem()), BIO_free);
  if (!bio || !certKeyPair.x509 || !certKeyPair.pkey ||
      PEM_write_bio_X509(bio.get(), certKeyPair.x509) != 1) {
    return MessageResult::Reject(emscripten::val(std::string("Error serializing certificate")));
  }

  BUF_MEM* mem = NULL;
  BIO_get_mem_ptr(bio.get(), &mem);

  std::string cert(mem->data, mem->length);

  std::unique_ptr<BIO, decltype(&BIO_free)> biokey(BIO_new(BIO_s_mem()), BIO_free);
  if (!biokey || PEM_write_bio_PrivateKey(biokey.get(), certKeyPair.pkey, NULL, NULL, 0, NULL, NULL) != 1) {
    return MessageResult::Reject(emscripten::val(std::string("Error serializing private key")));
  }
  BIO_get_mem_ptr(biokey.get(), &mem);

  std::string pkey(mem->data, mem->length);

  emscripten::val ret = emscripten::val::object();
  ret.set("cert", emscripten::val(cert));
  ret.set("privateKey", emscripten::val(pkey));

  return MessageResult::Resolve(ret);
}

LoadResult MoonlightInstance::LoadCert(const char* certStr, const char* keyStr) {
  // BIO_new_mem_buf borrows the input; both strings outlive these BIOs.
  std::unique_ptr<BIO, decltype(&BIO_free)> bio(BIO_new_mem_buf(certStr, -1), BIO_free);
  if (!bio) { return LoadResult::CertErr; }
  std::unique_ptr<X509, decltype(&X509_free)> cert(
    PEM_read_bio_X509(bio.get(), NULL, NULL, NULL), X509_free);
  if (!cert) {
    return LoadResult::CertErr;
  }
  bio.reset(BIO_new_mem_buf(keyStr, -1));
  if (!bio) { return LoadResult::PrivateKeyErr; }
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
    PEM_read_bio_PrivateKey(bio.get(), NULL, NULL, NULL), EVP_PKEY_free);
  if (!key) {
    return LoadResult::PrivateKeyErr;
  }
  // Convert the PEM cert to hex
  const size_t certLen = strlen(certStr);
  char* hex = reinterpret_cast<char*>(malloc((certLen * 2) + 1));
  if (!hex) { return LoadResult::CertErr; }
  for (size_t i = 0; i < certLen; i++) {
    sprintf(&hex[i * 2], "%02x", static_cast<unsigned char>(certStr[i]));
  }

  // Called during HTTP initialization, before requests. Failed loads above
  // leave the existing credentials untouched and release all temporaries.
  X509_free(g_Cert);
  EVP_PKEY_free(g_PrivateKey);
  free(g_CertHex);
  g_Cert = cert.release();
  g_PrivateKey = key.release();
  g_CertHex = hex;

  return LoadResult::Success;
}

MessageResult MoonlightInstance::HttpInit(std::string cert, std::string privateKey, std::string myUniqueId) {
  LoadResult res = LoadResult::Success;
  res = LoadCert(cert.c_str(), privateKey.c_str());
  if (res == LoadResult::CertErr) {
    return MessageResult::Reject(emscripten::val(std::string("Error loading cert into memory")));
  } else if (res == LoadResult::PrivateKeyErr) {
    return MessageResult::Reject(emscripten::val(std::string("Error loading private key into memory")));
  }

  g_UniqueId = strdup(myUniqueId.c_str());

  curl_global_init(CURL_GLOBAL_DEFAULT);

  return MessageResult::Resolve();
}

void MoonlightInstance::OpenUrl_private(int callbackId, std::string url, std::string ppk, bool binaryResponse) {
  // For launch/resume requests, append the additional query parameters
  if (url.find("/launch?") != std::string::npos || url.find("/resume?") != std::string::npos) {
    url += LiGetLaunchUrlQueryParameters();
  }

  PHTTP_DATA data = http_create_data();
  int err;

  if (data == NULL) {
    PostPromiseMessage(callbackId, "reject", "Error when creating data buffer.");
    return;
  }

  err = http_request(url.c_str(), ppk.empty() ? NULL : ppk.c_str(), data);
  if (err) {
    http_free_data(data);
    PostPromiseMessage(callbackId, "reject", std::to_string(err));
    return;
  }

  if (binaryResponse) {
    std::vector<uint8_t> response;
    response.resize(data->size);
    memcpy(response.data(), data->memory, data->size);
    http_free_data(data);
    PostPromiseMessage(callbackId, "resolve", response);
  } else {
    std::string response{data->memory, data->size};
    http_free_data(data);
    PostPromiseMessage(callbackId, "resolve", response);
  }
}

void MoonlightInstance::OpenUrl(int callbackId, std::string url, std::string ppk, bool binaryResponse) {
  m_Dispatcher.post_job(std::bind(&MoonlightInstance::OpenUrl_private, this, callbackId, url, ppk, binaryResponse), false);
}

MessageResult makeCert() {
  return g_Instance->MakeCert();
}

MessageResult httpInit(std::string cert, std::string privateKey, std::string myUniqueId) {
  return g_Instance->HttpInit(cert, privateKey, myUniqueId);
}

void openUrl(int callbackId, std::string url, emscripten::val ppk, bool binaryResponse) {
  std::string ppkstr = "";
  if (ppk != emscripten::val::null()) {
    ppkstr = ppk.as<std::string>();
  }
  g_Instance->OpenUrl(callbackId, url, ppkstr, binaryResponse);
}

EMSCRIPTEN_BINDINGS(http) {
  emscripten::function("makeCert", &makeCert);
  emscripten::function("httpInit", &httpInit);
  emscripten::function("openUrl", &openUrl);
}
