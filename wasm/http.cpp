#include "moonlight_wasm.hpp"

#include <http.h>
#include <errors.h>
#include <string.h>
#include <memory>
#include <algorithm>
#include <chrono>
#include <mutex>
#include <unordered_map>
#include <curl/curl.h>
#include <emscripten/threading.h>
#include "host_discovery.hpp"

namespace {
void cancelMenuRequest(int callbackId) {
  g_Instance->CancelMenuRequest(callbackId);
}

struct MenuReply { int id; bool binary; mlhttp::Result result; };
void deliverMenuReply(void* opaque) {
  std::unique_ptr<MenuReply> reply(static_cast<MenuReply*>(opaque));
  if (reply->result.ok && reply->binary) PostPromiseMessage(reply->id, "resolve", reply->result.bytes);
  else PostPromiseMessage(reply->id, reply->result.ok ? "resolve" : "reject", reply->result.text);
}

bool menuEndpoint(const std::string& url, std::string& host, std::string& port) {
  std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> endpoint(curl_url(), curl_url_cleanup);
  if (!endpoint || curl_url_set(endpoint.get(), CURLUPART_URL, url.c_str(), 0)) return false;
  char *scheme = nullptr, *name = nullptr, *service = nullptr, *user = nullptr;
  const bool valid = !curl_url_get(endpoint.get(), CURLUPART_SCHEME, &scheme, 0) &&
    (!strcmp(scheme, "http") || !strcmp(scheme, "https")) &&
    !curl_url_get(endpoint.get(), CURLUPART_HOST, &name, 0) &&
    !curl_url_get(endpoint.get(), CURLUPART_PORT, &service, CURLU_DEFAULT_PORT) &&
    curl_url_get(endpoint.get(), CURLUPART_USER, &user, 0) == CURLUE_NO_USER;
  if (valid) { host = name; port = service; }
  curl_free(scheme); curl_free(name); curl_free(service); curl_free(user);
  return valid && !host.empty();
}
}

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

void MoonlightInstance::OpenUrlScoped(int callbackId, std::string url, std::string ppk,
                                      bool binaryResponse, int timeoutMs) {
  // Only menu metadata/artwork uses this path; launch/resume/pair stay unchanged.
  m_MenuHttp.submit(callbackId, binaryResponse, timeoutMs,
    [this, url, ppk, binaryResponse](const mlhttp::Request& request) -> mlhttp::Result {
    std::string host, port, resolve;
    std::vector<HTTP_ADDRESS_SCOPE> scopes;
    if (!menuEndpoint(url, host, port)) return {false, "Invalid menu endpoint.", {}};
    auto numeric = host;
    if (numeric.front() == '[' && numeric.back() == ']') numeric = numeric.substr(1, numeric.size() - 2);
    in_addr ipv4{}; in6_addr ipv6{};
    if (inet_pton(AF_INET, numeric.c_str(), &ipv4) != 1 && inet_pton(AF_INET6, numeric.c_str(), &ipv6) != 1) {
      auto addresses = m_MenuHttp.resolver.resolve(host, request);
      if (addresses.empty() || !request.active()) return {false, "Menu endpoint resolution failed.", {}};
      resolve = host + ":" + port + ":";
      for (const auto& address : addresses) {
        if (resolve.back() != ':') resolve += ',';
        resolve += address.text.find(':') != std::string::npos ? "[" + address.text + "]" : address.text;
        if (address.scope) {
          HTTP_ADDRESS_SCOPE scoped{};
          inet_pton(AF_INET6, address.text.c_str(), scoped.address);
          scoped.scope = address.scope; scopes.push_back(scoped);
        }
      }
    }
    const int remaining = request.remaining();
    if (remaining <= 0) return {false, "Menu request cancelled or expired.", {}};
    std::unique_ptr<HTTP_DATA, decltype(&http_free_data)> data(http_create_data(), http_free_data);
    if (!data) return {false, "Error when creating data buffer.", {}};
    const int err = http_request_menu(url.c_str(), ppk.empty() ? nullptr : ppk.c_str(),
                                      data.get(), remaining, &request.cancelled,
                                      resolve.empty() ? nullptr : resolve.c_str(), scopes.data(), scopes.size());
    if (err || !request.active()) return {false, std::to_string(err ? err : GS_FAILED), {}};
    if (!binaryResponse) return {true, std::string(data->memory, data->size), {}};
    std::vector<uint8_t> bytes(data->size);
    if (data->size) memcpy(bytes.data(), data->memory, data->size);
    return {true, {}, std::move(bytes)};
  }, [callbackId, binaryResponse](mlhttp::Result result) {
    // Own the payload until the browser consumes it. A busy UI must not hold a
    // native lane or its deadline worker; the JS callback registry drops replies
    // for cancelled requests. Legacy launch/pair replies remain unchanged.
    auto* reply = new MenuReply{callbackId, binaryResponse, std::move(result)};
    emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_VI, deliverMenuReply, reply);
  });
}

void MoonlightInstance::DiscoverHosts(int callbackId, std::string localIp, std::string subnet,
                                    std::string preferred, int port, uint32_t cursor) {
  m_MenuHttp.submit(callbackId, 2, 2000, [this, localIp, subnet, preferred, port, cursor, callbackId](const mlhttp::Request& request) -> mlhttp::Result {
    mlrediscovery::Network network;
    if (m_Running.load() || port < 1 || port > 65535 || !network.parse(localIp, subnet)) return {false, "Discovery unavailable.", {}};
    uint32_t previous = 0; mlrediscovery::ParseIp(preferred, previous);
    const auto found = mlrediscovery::Discover(network, previous, static_cast<uint16_t>(port), cursor,
      static_cast<uint16_t>(callbackId ? callbackId : 1), [&] { return request.active() && !m_Running.load(); });
    return {request.active(), mlrediscovery::Json(found), {}};
  }, [callbackId](mlhttp::Result result) {
    auto* reply = new MenuReply{callbackId, false, std::move(result)};
    emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_VI, deliverMenuReply, reply);
  });
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

void openUrlScoped(int callbackId, std::string url, emscripten::val ppk, bool binaryResponse, int timeoutMs) {
  g_Instance->OpenUrlScoped(callbackId, url, ppk == emscripten::val::null() ? "" : ppk.as<std::string>(),
                            binaryResponse, timeoutMs);
}

EMSCRIPTEN_BINDINGS(http) {
  emscripten::function("makeCert", &makeCert);
  emscripten::function("httpInit", &httpInit);
  emscripten::function("openUrl", &openUrl);
  emscripten::function("openUrlScoped", &openUrlScoped);
  emscripten::function("discoverHosts", +[](int id, std::string ip, std::string mask, std::string previous, int port, uint32_t cursor) {
    g_Instance->DiscoverHosts(id, ip, mask, previous, port, cursor);
  });
  emscripten::function("cancelMenuRequest", &cancelMenuRequest);
}
