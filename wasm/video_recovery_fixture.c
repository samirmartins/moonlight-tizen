// Test-only fixture: real RTP/depacketizer, synthetic packets, no sockets or TV.
#include "Limelight-internal.h"
#include <assert.h>

int AppVersionQuad[4] = {7, 1, 500, -1};
STREAM_CONFIGURATION StreamConfig;
DECODER_RENDERER_CALLBACKS VideoCallbacks;
CONNECTION_LISTENER_CALLBACKS ListenerCallbacks;
int NegotiatedVideoFormat;
volatile bool ConnectionInterrupted;
static uint64_t fixtureNow;
static unsigned requests, packets, fecReports, nextFrame, nextSpi;
static unsigned warningCount, clearCount;
static uint16_t nextSeq;
static bool active;
static unsigned timeReads;
static uint32_t requestTimes[256];
static RTP_VIDEO_QUEUE rtp;
extern int fixture_submit(PDECODE_UNIT);

uint64_t PltGetMillis(void) { timeReads++; return fixtureNow; }
uint64_t LiGetMillis(void) { timeReads++; return fixtureNow; }
bool LiGetCurrentHostDisplayHdrMode(void) { return false; }
bool isReferenceFrameInvalidationEnabled(void) { return false; }
void LiRequestIdrFrame(void) {
    assert(requests < 256);
    requestTimes[requests++] = (uint32_t)fixtureNow;
}
void notifyKeyFrameReceived(void) {}
void connectionDetectedFrameLoss(uint32_t start, uint32_t end) { LiRequestIdrFrame(); }
void connectionSendFrameFecStatus(PSS_FRAME_FEC_STATUS status) { fecReports++; }

// DIRECT_SUBMIT never queues a decode unit. Reject an accidental queued path.
int LbqInitializeLinkedBlockingQueue(PLINKED_BLOCKING_QUEUE q, int bound) {
    memset(q, 0, sizeof(*q)); return 0;
}
PLINKED_BLOCKING_QUEUE_ENTRY LbqFlushQueueItems(PLINKED_BLOCKING_QUEUE q) {
    assert(q->currentSize == 0); return NULL;
}
PLINKED_BLOCKING_QUEUE_ENTRY LbqDestroyLinkedBlockingQueue(PLINKED_BLOCKING_QUEUE q) {
    return LbqFlushQueueItems(q);
}
int LbqOfferQueueItem(PLINKED_BLOCKING_QUEUE q, void* data, PLINKED_BLOCKING_QUEUE_ENTRY e) {
    assert(!"unexpected queued renderer"); return LBQ_BOUND_EXCEEDED;
}
void LbqSignalQueueShutdown(PLINKED_BLOCKING_QUEUE q) {}

// Extracted unchanged from ControlStream.c by the driver.
#include "control_status.inc"
// Compile the complete production depacketizer, including its recovery state.
#include DEPACKETIZER_PATH

static void statusUpdate(int status) {
    if (status == CONN_STATUS_POOR) warningCount++;
    if (status == CONN_STATUS_OKAY) clearCount++;
}
void fixture_close(void) {
    if (!active) return;
    RtpvCleanupQueue(&rtp);
    destroyVideoDepacketizer();
    active = false;
}
void fixture_reset(int codec) {
    fixture_close();
    memset(&StreamConfig, 0, sizeof(StreamConfig));
    StreamConfig.packetSize = 1392;
    StreamConfig.colorSpace = COLORSPACE_REC_709;
    VideoCallbacks.capabilities = CAPABILITY_DIRECT_SUBMIT;
    VideoCallbacks.submitDecodeUnit = fixture_submit;
    ListenerCallbacks.connectionStatusUpdate = statusUpdate;
    NegotiatedVideoFormat = codec;
    fixtureNow = 10000;
    ConnectionInterrupted = false;
    timeReads = 0;
    requests = packets = fecReports = warningCount = clearCount = 0;
    nextFrame = 1; nextSpi = 0; nextSeq = 100;
    intervalGoodFrameCount = intervalTotalFrameCount = 0;
    intervalStartTimeMs = firstFrameTimeMs = 0;
    lastSeenFrame = lastGoodFrame = 0;
    lastIntervalLossPercentage = 0;
    lastConnectionStatusUpdate = CONN_STATUS_OKAY;
    RtpvInitializeQueue(&rtp);
    initializeVideoDepacketizer(StreamConfig.packetSize);
    active = true;
}
void fixture_set_time(uint64_t now) { fixtureNow = now; }
unsigned fixture_requests(void) { return requests; }
unsigned fixture_warnings(void) { return warningCount; }
unsigned fixture_clears(void) { return clearCount; }
unsigned fixture_packets(void) { return packets; }
unsigned fixture_frame_reports(void) { return RtpvGetCurrentFrameNumber(&rtp) - 1; }
unsigned fixture_fec_reports(void) { return fecReports; }
int fixture_waiting(void) { return waitingForIdrFrame; }
int fixture_idr_processed(void) { return idrFrameProcessed; }
unsigned fixture_time_reads(void) { return timeReads; }
int fixture_request_spacing(void) {
    for (unsigned i = 1; i < requests; i++)
        if (requestTimes[i] - requestTimes[i - 1] < 500) return 0;
    return 1;
}
void fixture_service(uint64_t now) {
    fixtureNow = now;
#if RECOVERY_FIXED
    servicePendingVideoDecoderRefresh();
#endif
}
void fixture_cancel(void) { ConnectionInterrupted = true; stopVideoDepacketizer(); }

// Every frame has consecutive RTP/SPI/frame numbers and every shard arrives.
// Minimal codec headers exercise the real parser, not hardware decoding.
void fixture_deliver(int idr, int fragments) {
    assert(fragments >= 1 && fragments <= 3);
    for (int part = 0; part < fragments; part++) {
        const int capacity = StreamConfig.packetSize + MAX_RTP_HEADER_SIZE;
        unsigned char* bytes = calloc(1, capacity + sizeof(RTPV_QUEUE_ENTRY));
        assert(bytes);
        PRTP_PACKET r = (PRTP_PACKET)bytes;
        r->header = 0x90; r->sequenceNumber = nextSeq++;
        r->timestamp = nextFrame * 1500;
        PNV_VIDEO_PACKET v = (PNV_VIDEO_PACKET)(bytes + 16);
        v->frameIndex = nextFrame;
        v->streamPacketIndex = (nextSpi++) << 8;
        v->flags = FLAG_CONTAINS_PIC_DATA | (part == 0 ? FLAG_SOF : 0) |
                   (part == fragments - 1 ? FLAG_EOF : 0);
        v->multiFecFlags = 0x10;
        v->fecInfo = (fragments << 22) | (part << 12);
        unsigned char* payload = bytes + 32;
        int used = 0;
        if (part == 0) {
            payload[0] = 1; payload[3] = idr ? 2 : 1;
            // AV1 header carries the exact last-packet payload size.
            payload[4] = fragments == 1 ? 16 : 8;
            used = 8;
            if (NegotiatedVideoFormat == VIDEO_FORMAT_H264) {
                const unsigned char key[] = {
                    0,0,0,1,0x67,0x55, 0,0,0,1,0x68,0x55,
                    0,0,0,1,0x65,0x55};
                const unsigned char p[] = {0,0,0,1,0x41,0x55};
                const size_t n = idr ? sizeof(key) : sizeof(p);
                memcpy(payload + used, idr ? key : p, n); used += n;
            } else if (NegotiatedVideoFormat == VIDEO_FORMAT_H265) {
                const unsigned char key[] = {
                    0,0,0,1,64,1,0x55, 0,0,0,1,66,1,0x55,
                    0,0,0,1,68,1,0x55, 0,0,0,1,38,1,0x55};
                const unsigned char p[] = {0,0,0,1,2,1,0x55};
                const size_t n = idr ? sizeof(key) : sizeof(p);
                memcpy(payload + used, idr ? key : p, n); used += n;
            }
        }
        memset(payload + used, 0x55, 8);
        used += 8;
        if (part != fragments - 1) {
            memset(payload + used, 0x55, capacity - 32 - used);
            used = capacity - 32;
        }
        const int size = 32 + used;
        int result = RtpvAddPacket(&rtp, r, size,
                                  (PRTPV_QUEUE_ENTRY)(bytes + capacity));
        packets++;
        if (result != RTPF_RET_QUEUED) free(bytes);
        assert(result == RTPF_RET_QUEUED);
    }
    nextFrame++;
}
