// driver.cpp - runs the engines' C API natively so ASan/UBSan or valgrind can
// watch them: for each engine linked in, render tune A, then B, then A again
// and say whether the two renders of A match; with the analyser linked in, run
// sid_analyze on every tune. See README.md.
#include <cstdint>
#include <cstdio>
#include <vector>
#include <algorithm>

extern "C" {
void audio_init(double);
int audio_load_sid(const uint8_t*, int);
void audio_set_subtune(int);
int audio_generate(int16_t*, int);
#ifdef WITH_ANALYSER
void sid_init();
int sid_load(uint8_t*, uint32_t);
int sid_analyze(uint32_t, void (*)(uint32_t, uint32_t));
uint32_t sid_get_modified_count();
#endif
}

static std::vector<uint8_t> readFile(const char* f) {
    std::vector<uint8_t> v;
    FILE* fp = fopen(f, "rb");
    if (!fp) { fprintf(stderr, "cannot open %s\n", f); return v; }
    int c;
    while ((c = fgetc(fp)) != EOF) v.push_back((uint8_t)c);
    fclose(fp);
    return v;
}

static std::vector<int16_t> render(const char* f, int n) {
    std::vector<uint8_t> b = readFile(f);
    std::vector<int16_t> o(n);
    audio_init(44100);
    if (audio_load_sid(b.data(), (int)b.size()) < 0) { fprintf(stderr, "%s: load failed\n", f); return o; }
    audio_set_subtune(0);
    for (int g = 0; g < n;) {
        int k = audio_generate(o.data() + g, std::min(4096, n - g));
        if (k <= 0) break;
        g += k;
    }
    return o;
}

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s A.sid B.sid [more.sid...]\n", argv[0]); return 2; }
    const int n = 44100 * 2;
    std::vector<int16_t> a = render(argv[1], n);
    render(argv[2], n / 4);
    std::vector<int16_t> again = render(argv[1], n);
    int first = -1;
    for (int i = 0; i < n; i++) if (a[i] != again[i]) { first = i; break; }
    printf("render of %s after %s: %s\n", argv[1], argv[2],
           first < 0 ? "identical" : "differs");
    if (first >= 0) printf("  first difference at sample %d\n", first);
#ifdef WITH_ANALYSER
    sid_init();
    for (int i = 1; i < argc; i++) {
        std::vector<uint8_t> b = readFile(argv[i]);
        int r = sid_load(b.data(), (uint32_t)b.size());
        if (r == 0) r = sid_analyze(3000, nullptr);
        printf("sid_analyze %s: %d, %u modified\n", argv[i], r, r == 0 ? sid_get_modified_count() : 0);
    }
#endif
    return first < 0 ? 0 : 1;
}
