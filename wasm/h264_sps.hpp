#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <h264_stream.h>

namespace mlh264 {
inline unsigned int FixupSps(const uint8_t* nalu, unsigned int naluLen,
                             uint8_t* out, unsigned int outCapacity) {
  if (naluLen < 5 || outCapacity < naluLen + 32) {
    return 0;
  }

  // Locate the Annex B start code so the NAL header can be handed to the parser
  // at the right offset. Both three and four byte forms occur.
  unsigned int startLen;
  if (nalu[0] == 0x00 && nalu[1] == 0x00 && nalu[2] == 0x01) {
    startLen = 3;
  } else if (naluLen >= 6 && nalu[0] == 0x00 && nalu[1] == 0x00 &&
             nalu[2] == 0x00 && nalu[3] == 0x01) {
    startLen = 4;
  } else {
    return 0;
  }

  h264_stream_t* h = h264_new();
  if (h == nullptr) {
    return 0;
  }

  unsigned int written = 0;
  do {
    if (read_nal_unit(h, const_cast<uint8_t*>(nalu) + startLen,
                      (int)(naluLen - startLen)) < 0) {
      break;
    }
    if (h->nal->nal_unit_type != 7 || h->sps == nullptr) {
      break;  // not an SPS after all
    }

    sps_t* sps = h->sps;

    // Stage 1. The VUI is where the restrictions live, so it has to exist.
    sps->vui_parameters_present_flag = 1;
    sps->vui.bitstream_restriction_flag = 1;
    sps->vui.num_reorder_frames = 0;
    sps->vui.motion_vectors_over_pic_boundaries_flag = 1;
    sps->vui.max_bytes_per_pic_denom = 2;
    sps->vui.max_bits_per_mb_denom = 1;
    sps->vui.log2_max_mv_length_horizontal = 16;
    sps->vui.log2_max_mv_length_vertical = 16;

    // Never claim fewer reference pictures or a lower level than the host
    // encoded. Both can invalidate an otherwise valid multi-reference stream.
    sps->vui.max_dec_frame_buffering = std::max(1, sps->num_ref_frames);

    int rc = write_nal_unit(h, out + startLen, (int)(outCapacity - startLen));
    if (rc <= 0) {
      break;
    }

    // This bundled serializer's rbsp_to_nal starts at byte 1, leaving a zero
    // before the NAL header already written into its RBSP. Strip exactly that
    // spurious byte, not a payload/start-code byte. Other library users stay
    // untouched, and an unexpected header falls back to the original SPS.
    if (rc > 1 && out[startLen] == 0 && out[startLen + 1] == nalu[startLen]) {
      memmove(out + startLen, out + startLen + 1, static_cast<size_t>(--rc));
    }
    if (out[startLen] != nalu[startLen]) break;

    memcpy(out, nalu, startLen);
    written = startLen + (unsigned int)rc;
  } while (false);

  h264_free(h);
  return written;
}


} // namespace mlh264
