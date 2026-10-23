// Synthetic transport regression driver. No network, TV or hardware decoding.
#include <stdio.h>
#include <stdarg.h>
#include "transport_base.inc"
#include "VideoRecoveryLog.h"
#undef assert
#define assert(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #x); abort(); } } while (0)

static unsigned accepted, offered, failNext, idrLogs, lossLogs, summaries;
static uint64_t payloadHash;
void emscripten_log(int unused, const char* format, ...) {
    if (strstr(format, "Waiting for IDR")) idrLogs++;
    if (strstr(format, "Unrecoverable frame")) lossLogs++;
    if (strstr(format, "suppressed")) summaries++;
}
int fixture_submit(PDECODE_UNIT d) {
    offered++;
    if (failNext) { failNext--; return DR_NEED_IDR; }
    accepted++;
    payloadHash = payloadHash * 31 + d->frameNumber;
    payloadHash = payloadHash * 31 + d->presentationTimeMs;
    for (PLENTRY p = d->bufferList; p; p = p->next)
        for (int i = 0; i < p->length; i++) payloadHash = payloadHash * 31 + (unsigned char)p->data[i];
    return DR_OK;
}
static void reset(int codec) {
    fixtureSwap = fixtureDropTail = fixtureRfi = false;
    fixture_reset(codec);
    accepted = offered = failNext = idrLogs = lossLogs = summaries = 0;
    payloadHash = 0;
}
int main(void) {
    const int codecs[] = {VIDEO_FORMAT_H264, VIDEO_FORMAT_H265, VIDEO_FORMAT_AV1_MAIN8};
    for (unsigned c = 0; c < 3; c++) {
        reset(codecs[c]);
        fixture_deliver(1, 3);
        for (unsigned i = 0; i < 120; i++) {
            fixture_set_time(10020 + i * 17);
            fixture_deliver(0, 3);
        }
        assert(accepted == 121 && requests == 0);
        printf("HEALTHY codec=%d accepted=%u hash=%llu reads=%u logs=%u/%u\n",
            codecs[c], accepted, (unsigned long long)payloadHash, timeReads, idrLogs, lossLogs);

        reset(codecs[c]); fixture_deliver(1, 3);
        fixtureSwap = true; fixture_set_time(10017); fixture_deliver(0, 3); fixtureSwap = false;
        fixture_set_time(10034); fixture_deliver(0, 3);
#if TRANSPORT_FIXED
        assert(accepted == 3 && requests == 0 && !waitingForIdrFrame);
#else
        assert(accepted == 1 && waitingForIdrFrame);
#endif
        printf("REORDER codec=%d accepted=%u requests=%u\n", codecs[c], accepted, requests);

        reset(codecs[c]); fixture_deliver(1, 3);
        rtp.receivedOosData = true; fixtureSwap = true; fixture_deliver(0, 3);
        fixtureSwap = false; fixture_deliver(0, 3);
        assert(accepted == 3 && requests == 0);
        printf("KNOWN_REORDER codec=%d hash=%llu\n", codecs[c], (unsigned long long)payloadHash);

        reset(codecs[c]); fixture_deliver(1, 1);
        fixtureDropTail = true; fixture_deliver(0, 3); fixtureDropTail = false;
        fixture_deliver(0, 3); assert(accepted == 1 && waitingForIdrFrame);
        fixture_deliver(1, 1); assert(accepted == 2 && !waitingForIdrFrame);
        printf("REAL_LOSS codec=%d accepted=%u requests=%u\n", codecs[c], accepted, requests);

        reset(codecs[c]); fixture_deliver(1, 1);
        failNext = 1; fixture_set_time(10010); fixture_deliver(0, 1); assert(requests == 1);
        failNext = 1; fixture_set_time(10020); fixture_deliver(1, 1);
        assert(decoderRefreshRequestPending && requests == 1);
        fixtureDropTail = true;
        for (unsigned i = 0; i < 60; i++) {
            fixture_set_time(10030 + i * 17); fixture_deliver(0, 3);
        }
#if TRANSPORT_FIXED
        assert(requests == 2 && !decoderRefreshRequestPending);
        assert(requestTimes[1] - requestTimes[0] >= 500 && requestTimes[1] <= 10510 + 17);
        assert(lossLogs <= 2);
#else
        assert(requests == 1 && decoderRefreshRequestPending);
        assert(lossLogs >= 50);
#endif
        printf("PARTIAL codec=%d requests=%u loss_logs=%u\n", codecs[c], requests, lossLogs);
        fixtureDropTail = false; fixture_deliver(1, 3); assert(!waitingForIdrFrame);
#if TRANSPORT_FIXED
        assert(summaries > 0);
#endif

        reset(codecs[c]); fixture_deliver(1, 1);
        failNext = 1; fixture_set_time(10010); fixture_deliver(0, 1);
        for (unsigned i = 0; i < 60; i++) {
            fixture_set_time(10020 + i * 17); fixture_deliver(0, 1);
        }
#if TRANSPORT_FIXED
        assert(idrLogs == 2 && summaries > 0);
#else
        assert(idrLogs == 60);
#endif
        printf("WAIT codec=%d logs=%u\n", codecs[c], idrLogs);
        fixture_deliver(1, 1);
        unsigned before = idrLogs;
        failNext = 1; fixture_deliver(0, 1); fixture_deliver(0, 1);
        assert(idrLogs == before + 1); // first message of a new episode survives

        // Pending recovery must not survive stop or session reinitialization.
        fixture_cancel(); fixture_service(20000);
        unsigned beforeStop = requests; fixture_service(21000); assert(requests == beforeStop);
        reset(codecs[c]); fixture_deliver(1, 1); assert(requests == 0);
    }
    // Negotiated RFI keeps its original speculative behavior.
    reset(VIDEO_FORMAT_H265); fixtureRfi = true;
    initializeVideoDepacketizer(StreamConfig.packetSize);
    fixture_deliver(1, 3); fixtureSwap = true; fixture_deliver(0, 3); fixtureSwap = false;
    fixture_deliver(0, 3);
    printf("RFI accepted=%u requests=%u\n", accepted, requests);
#if TRANSPORT_FIXED
    VIDEO_RECOVERY_LOG gate = {0};
    fixtureNow = UINT32_MAX - 100;
    assert(videoRecoveryLogAllowed(&gate));
    fixtureNow += 999; assert(!videoRecoveryLogAllowed(&gate));
    fixtureNow++; assert(videoRecoveryLogAllowed(&gate));
    videoRecoveryLogRecovered(&gate); assert(videoRecoveryLogAllowed(&gate));
#endif
    fixture_close();
    return 0;
}
