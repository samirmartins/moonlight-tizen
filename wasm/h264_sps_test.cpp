#include "h264_sps.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
static unsigned prefix(const std::vector<uint8_t>& v,size_t n) {
  if(n+4<=v.size()&&!v[n]&&!v[n+1]&&!v[n+2]&&v[n+3]==1)return 4;
  if(n+3<=v.size()&&!v[n]&&!v[n+1]&&v[n+2]==1)return 3;
  return 0;
}
int main(int argc,char** argv) {
  // Exp-Golomb payloads can use 63 bits without shifting a 32-bit value by 32+.
  for (uint32_t value : {0u, 1u, 65535u, 0x3fffffffu, 0x7fffffffu}) {
    uint8_t storage[16] = {};
    bs_t bits;
    bs_init(&bits, storage, sizeof(storage));
    bs_write_ue(&bits, value);
    assert(!bs_overrun(&bits));
    bs_init(&bits, storage, sizeof(storage));
    assert(bs_read_ue(&bits) == value && !bs_overrun(&bits));
  }
  for (int32_t value : {-1073741823, -1, 0, 1, 1073741824}) {
    uint8_t storage[16] = {};
    bs_t bits;
    bs_init(&bits, storage, sizeof(storage));
    bs_write_se(&bits, value);
    assert(!bs_overrun(&bits));
    bs_init(&bits, storage, sizeof(storage));
    assert(bs_read_se(&bits) == value && !bs_overrun(&bits));
  }
  {
    uint8_t storage[16] = {};
    bs_t bits;
    bs_init(&bits, storage, sizeof(storage));
    bs_read_ue(&bits);
    assert(bs_overrun(&bits));
    bs_init(&bits, storage, sizeof(storage));
    bs_write_u(&bits, 33, 0);
    assert(bs_overrun(&bits));
  }
  // Reject bounded malformed prefixes and undersized/truncated headers.
  uint8_t invalid[] = {3, 2, 1, 0x67, 0x00, 0x00};
  uint8_t scratch[128] = {};
  for (unsigned n = 0; n < sizeof(invalid); ++n)
    assert(mlh264::FixupSps(invalid, n, scratch, sizeof(scratch)) == 0);
  const uint8_t aud[] = {0, 0, 1, 9, 0xf0};
  assert(mlh264::FixupSps(aud, sizeof(aud), scratch, sizeof(scratch)) == 0);
  assert(argc==3);std::ifstream in(argv[1],std::ios::binary);
  std::vector<uint8_t> input((std::istreambuf_iterator<char>(in)),{}),output;
  assert(!input.empty());unsigned rewritten=0;
  for(size_t i=0;i<input.size();) {
    const auto p=prefix(input,i);assert(p);size_t end=i+p;
    while(end<input.size()&&!prefix(input,end))++end;
    if((input[i+p]&31)==7) {
      std::vector<uint8_t> nal(input.begin()+i,input.begin()+end),out(nal.size()+32);
      const auto length=mlh264::FixupSps(nal.data(),nal.size(),out.data(),out.size());assert(length);
      h264_stream_t* before=h264_new();h264_stream_t* after=h264_new();assert(before&&after);
      assert(read_nal_unit(before,nal.data()+p,nal.size()-p)>0);
      std::vector<uint8_t> legacy(nal.size()+32);
      const int legacyLength=write_nal_unit(before,legacy.data(),legacy.size());
      assert(legacyLength>1&&legacy[0]==0&&(legacy[1]&31)==7);
      assert((out[p]&31)==7); // No unspecified NAL type 0 from legacy serializer.
      assert(read_nal_unit(after,out.data()+p,length-p)>0);
      assert(before->sps->num_ref_frames==after->sps->num_ref_frames);
      assert(before->sps->level_idc==after->sps->level_idc);
      assert(before->sps->profile_idc==after->sps->profile_idc);
      assert(after->sps->vui.num_reorder_frames==0);
      assert(after->sps->vui.max_dec_frame_buffering>=after->sps->num_ref_frames);
      std::cout<<"SPS preserved refs="<<after->sps->num_ref_frames<<" level="<<after->sps->level_idc<<"\n";
      // Exercise both Annex B prefix forms and a deliberately short output.
      if(p==4) {nal.erase(nal.begin());std::vector<uint8_t> three(nal.size()+32);assert(mlh264::FixupSps(nal.data(),nal.size(),three.data(),three.size()));}
      assert(mlh264::FixupSps(input.data()+i,end-i,out.data(),4)==0);
      h264_free(before);h264_free(after);
      output.insert(output.end(),out.begin(),out.begin()+length);++rewritten;
    } else output.insert(output.end(),input.begin()+i,input.begin()+end);
    i=end;
  }
  assert(rewritten);std::ofstream file(argv[2],std::ios::binary);
  file.write(reinterpret_cast<const char*>(output.data()),output.size());
}
