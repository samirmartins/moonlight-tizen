'use strict';
// Exercise production RTSP transactions and parsing with deterministic I/O.
const fs = require('fs'), cp = require('child_process'), path = require('path'), assert = require('assert');
const source = fs.readFileSync('moonlight-common-c/src/RtspConnection.c', 'utf8');
function method(marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, marker);
  let end = source.indexOf('{', start) + 1, depth = 1;
  while (depth) {
    const ch = source[end++];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    assert(end <= source.length);
  }
  return source.slice(start, end);
}
const sessionStart = source.indexOf('        sessionId = getOptionContent(response.options, "Session");');
const sessionEnd = source.indexOf('        hasSessionId = true;', sessionStart);
assert(sessionStart >= 0 && sessionEnd > sessionStart);
const fixture = `
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>
#include <sys/socket.h>
#include <poll.h>
#include "Limelight.h"
#include "Rtsp.h"
#define MAX_RTSP_RESPONSE_SIZE (1024 * 1024)
#define RTSP_CONNECT_TIMEOUT_SEC 10
#define RTSP_RECEIVE_TIMEOUT_SEC 15
#define RTSP_RETRY_DELAY_MS 500
#define INVALID_SOCKET -1
#define SOCKET_ERROR -1
#define ENET_EVENT_TYPE_RECEIVE 3
#define ENET_PACKET_FLAG_RELIABLE 1
#define LC_ASSERT assert
#define Limelog(...) ((void)0)
#define CHAR_IS_DIGIT(c) ((c) >= '0' && (c) <= '9')
#define CHAR_TO_INT(c) ((c) - '0')
typedef int SOCK_RET;
typedef unsigned int SOCKADDR_LEN;
typedef struct { size_t dataLength; char* data; } ENetPacket;
typedef struct { int type; ENetPacket* packet; } ENetEvent;
static int sock, client, peer, RtspPortNumber;
static struct sockaddr_storage RemoteAddr, LocalAddr;
static int AddrLen = sizeof(LocalAddr);
static bool ConnectionInterrupted, encryptedRtspEnabled;
static size_t tcpRemaining, enetSizes[2], parsedSize;
static int enetIndex, livePackets, pollResult = 1, receiveError;
static char* sessionHeader;
static char* sessionIdString;
static int LastSocketError(void) { return EIO; }
static int LastSocketFail(void) { return EIO; }
static void PltSleepMs(int ms) { (void)ms; }
static int connectTcpSocket(void* a, int l, int p, int t) { return 1; }
static void closeSocket(int s) { (void)s; }
static void enableNoDelay(int s) { (void)s; }
static char* serializeRtspMessage(PRTSP_MESSAGE r, int* n) { *n = 1; return strdup("x"); }
static char* sealRtspMessage(PRTSP_MESSAGE r, int* n) { return serializeRtspMessage(r, n); }
static int sendMtuSafe(int s, char* b, int n) { return n; }
static char* extendBuffer(char* p, size_t n) { char* q = realloc(p, n); if (!q) free(p); return q; }
static int pollSockets(struct pollfd* p, int n, int timeout) { return pollResult; }
static int fixtureRecv(int s, char* b, size_t n, int f) {
  if (receiveError) return -1;
  if (n > tcpRemaining) n = tcpRemaining;
  memset(b, 'x', n); tcpRemaining -= n; return (int)n;
}
#define recv fixtureRecv
static int fixtureGetsockname(int s, struct sockaddr* a, SOCKADDR_LEN* len) {
  a->sa_family = AF_INET; return 0;
}
#define getsockname fixtureGetsockname
static bool unsealRtspMessage(char* b, int n, PRTSP_MESSAGE r) { parsedSize = n; return true; }
static int parseRtspMessage(PRTSP_MESSAGE r, char* b, int n) { parsedSize = n; return RTSP_ERROR_SUCCESS; }
static ENetPacket* enet_packet_create(const void* d, size_t n, int flags) {
  ENetPacket* p = malloc(sizeof(*p)); assert(p);
  p->dataLength = n; p->data = malloc(n ? n : 1); assert(p->data);
  memset(p->data, 'x', n); ++livePackets; return p;
}
static void enet_packet_destroy(ENetPacket* p) { free(p->data); free(p); --livePackets; }
static int enet_peer_send(int p, int c, ENetPacket* packet) { enet_packet_destroy(packet); return 0; }
static void enet_host_flush(int c) { (void)c; }
static int serviceEnetHost(int c, ENetEvent* e, int timeout) {
  assert(enetIndex < 2); e->type = ENET_EVENT_TYPE_RECEIVE;
  e->packet = enet_packet_create(NULL, enetSizes[enetIndex++], 0); return 1;
}
static char* getOptionContent(POPTION_ITEM options, const char* key) { return sessionHeader; }
`;
// Header prototypes are replaced by fixtures; keep the real Opus struct.
const standalone = fixture.replace('#include "Rtsp.h"', `
typedef void* POPTION_ITEM;
typedef struct { char* payload; int payloadLength; POPTION_ITEM options; } RTSP_MESSAGE, *PRTSP_MESSAGE;
#define RTSP_ERROR_SUCCESS 0`);
const code = standalone + '\n' + [
  method('static bool transactRtspMessageEnet('),
  method('static bool transactRtspMessageTcp('),
  method('static int parseOpusConfigFromParamString(')
].join('\n') + `
static int sessionTest(char* input) {
  RTSP_MESSAGE response = {0}; char* sessionId; char* strtokCtx = NULL; int ret = 0;
  sessionHeader = input;
${source.slice(sessionStart, sessionEnd)}
Exit: return ret;
}
int main(void) {
  RTSP_MESSAGE req = {0}, response = {0}; int error;
  tcpRemaining = 16385; assert(transactRtspMessageTcp(&req, &response, &error)); assert(parsedSize == 16385);
  tcpRemaining = MAX_RTSP_RESPONSE_SIZE - 1; assert(transactRtspMessageTcp(&req, &response, &error));
  tcpRemaining = MAX_RTSP_RESPONSE_SIZE + 1; assert(!transactRtspMessageTcp(&req, &response, &error)); assert(error == EMSGSIZE);
  pollResult = 0; assert(!transactRtspMessageTcp(&req, &response, &error)); assert(error == ETIMEDOUT);
  pollResult = 1; receiveError = 1; assert(!transactRtspMessageTcp(&req, &response, &error)); assert(error == EIO);
  enetSizes[0] = 17; enetSizes[1] = 31; enetIndex = 0;
  assert(transactRtspMessageEnet(&req, &response, true, &error)); assert(parsedSize == 48 && livePackets == 0);
  enetSizes[0] = MAX_RTSP_RESPONSE_SIZE + 1; enetIndex = 0;
  assert(!transactRtspMessageEnet(&req, &response, false, &error)); assert(error == EMSGSIZE && livePackets == 0);
  enetSizes[0] = 17; enetSizes[1] = MAX_RTSP_RESPONSE_SIZE; enetIndex = 0;
  assert(!transactRtspMessageEnet(&req, &response, true, &error)); assert(error == EMSGSIZE && livePackets == 0);
  OPUS_MULTISTREAM_CONFIGURATION config, old;
  memset(&config, 0x5a, sizeof(config)); old = config;
  char params[] = "4312563470";
  assert(parseOpusConfigFromParamString(params, 9, &config) != 0 && !memcmp(&config, &old, sizeof(config)));
  assert(parseOpusConfigFromParamString(params, 0, &config) != 0);
  assert(parseOpusConfigFromParamString(params, -1, &config) != 0);
  assert(parseOpusConfigFromParamString(params, 8, &config) == 0 && config.channelCount == 8);
  char stereo[] = "1101";
  assert(parseOpusConfigFromParamString(stereo, 2, &config) == 0 && config.streams == 1 && config.coupledStreams == 1);
  for (int i = 0; i < 4; ++i) { char truncated[] = "1101"; truncated[i] = 0; assert(parseOpusConfigFromParamString(truncated, 2, &config) != 0); }
  assert(sessionTest(NULL) != 0);
  char empty[] = "", separators[] = ";;;";
  assert(sessionTest(empty) != 0 && sessionTest(separators) != 0);
  char valid[] = "fixture-token;timeout=90";
  assert(sessionTest(valid) == 0 && !strcmp(sessionIdString, "fixture-token")); free(sessionIdString);
  return 0;
}
`;
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'moonlight-rtsp-test-'));
try {
  const file = path.join(tmp, 'test.c'), bin = path.join(tmp, 'test');
  fs.writeFileSync(file, code);
  cp.execFileSync('gcc', ['-std=c99', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-Imoonlight-common-c/src', file, '-o', bin], {stdio: 'inherit'});
  cp.execFileSync(bin, [], {stdio: 'inherit', env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
console.log('rtsp_defensive_test: TCP/ENet bounds, cleanup, malformed Session and Opus channel validation OK');
