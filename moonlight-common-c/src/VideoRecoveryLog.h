#pragma once

// Receive-thread-only state. A healthy stream does not read the clock here.
typedef struct _VIDEO_RECOVERY_LOG {
    uint32_t lastMs;
    unsigned int suppressed;
    bool emitted;
} VIDEO_RECOVERY_LOG;

static inline bool videoRecoveryLogAllowed(VIDEO_RECOVERY_LOG* state) {
    const uint32_t now = (uint32_t)PltGetMillis();
    if (!state->emitted || now - state->lastMs >= 1000) {
        state->emitted = true;
        state->lastMs = now;
        if (state->suppressed) {
            Limelog("Video recovery: suppressed %u repeated messages\n", state->suppressed);
            state->suppressed = 0;
        }
        return true;
    }
    if (state->suppressed != UINT32_MAX) state->suppressed++;
    return false;
}

static inline void videoRecoveryLogRecovered(VIDEO_RECOVERY_LOG* state) {
    if (state->suppressed) {
        Limelog("Video recovery resumed: suppressed %u repeated messages\n", state->suppressed);
    }
    memset(state, 0, sizeof(*state));
}
