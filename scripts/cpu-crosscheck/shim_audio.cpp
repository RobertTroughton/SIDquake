// Exposes the file-static 6510 core inside wasm/sid_audio.cpp to the
// cross-check harness. Including the .cpp is what gives access to it.

#include "sid_audio.cpp"

extern "C" {

void aud_set_state(const uint8_t* image, uint16_t pc, uint8_t a, uint8_t x,
                   uint8_t y, uint8_t sp, uint8_t st) {
    memcpy(S.memory, image, 0x10000);
    S.pc = pc; S.a = a; S.x = x; S.y = y; S.sp = sp; S.st = st;
    S.sidCount = 1;
    for (int i = 0; i < MAX_SID_CHIPS; i++) S.sid[i].reset();
}

int aud_step() { return cpu_step(); }

uint16_t aud_pc()  { return S.pc; }
uint8_t  aud_a()   { return S.a; }
uint8_t  aud_x()   { return S.x; }
uint8_t  aud_y()   { return S.y; }
uint8_t  aud_sp()  { return S.sp; }
uint8_t  aud_st()  { return S.st; }
uint8_t* aud_mem() { return S.memory; }

}
