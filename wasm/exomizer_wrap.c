/*
 * exomizer_wrap.c - WebAssembly entry point for Exomizer 3.
 *
 * Exomizer is a command line tool: it reads and writes files and reports
 * errors by calling exit(). Rather than fork the upstream sources (which we
 * vendor verbatim in wasm/exomizer/, see its README), this wrapper drives the
 * unmodified CLI in-process:
 *
 *   1. the input PRG is written to a MEMFS file
 *   2. exomizer's main() is called with a synthesised argv
 *   3. the output file is read back into a heap buffer the JS side can copy
 *
 * The module is built with -sINVOKE_RUN=0, so main() only ever runs when we
 * call it here.
 *
 * Exomizer keeps global state (named buffers, chunk pools, the sfx assembler's
 * symbol table) that it never tears down, so ONE module instance may serve only
 * ONE compression. public/exomizer-loader.js enforces that by instantiating a
 * fresh module per call; instantiating costs a few ms, and an export compresses
 * once.
 */

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* exomizer's own entry point (wasm/exomizer/src/exo_main.c). Calling main()
   from C is legal and lets us reuse the CLI without patching it. */
extern int main(int argc, char *argv[]);

#define IN_PATH  "/in.prg"
#define OUT_PATH "/out.prg"

static unsigned char *g_out = NULL;
static int g_out_len = 0;

/* Pointer to the compressed image produced by the last exo_compress_sfx()
   call, valid until exo_free() or the module is discarded. */
EMSCRIPTEN_KEEPALIVE
unsigned char *exo_output_ptr(void)
{
    return g_out;
}

EMSCRIPTEN_KEEPALIVE
int exo_output_len(void)
{
    return g_out_len;
}

EMSCRIPTEN_KEEPALIVE
void exo_free(void)
{
    free(g_out);
    g_out = NULL;
    g_out_len = 0;
}

/*
 * Crunch a C64 PRG (2-byte load address first) into a self-extracting PRG that
 * decrunches itself and jumps to jump_addr.
 *
 * no_effect != 0 passes -n, which drops exomizer's decrunch border effect. The
 * effect costs ~10 bytes and gives the user something to look at during the
 * (seconds-long) decrunch, so the default is to keep it.
 *
 * Returns the compressed length, or a negative value on failure. Errors inside
 * exomizer itself call exit() rather than returning, which surfaces to JS as an
 * ExitStatus exception - the loader catches it and reports the failure.
 */
EMSCRIPTEN_KEEPALIVE
int exo_compress_sfx(const unsigned char *prg, int len, int jump_addr, int no_effect)
{
    char jump_arg[16];
    char *argv[9];
    int argc = 0;
    FILE *f;
    long size;
    int rc;

    exo_free();

    if (prg == NULL || len < 2 || jump_addr < 0 || jump_addr > 0xffff) return -1;

    f = fopen(IN_PATH, "wb");
    if (f == NULL) return -2;
    if (fwrite(prg, 1, (size_t)len, f) != (size_t)len)
    {
        fclose(f);
        return -3;
    }
    fclose(f);
    remove(OUT_PATH);

    sprintf(jump_arg, "0x%04x", jump_addr);

    argv[argc++] = (char *)"exomizer";
    argv[argc++] = (char *)"sfx";
    argv[argc++] = jump_arg;
    argv[argc++] = (char *)"-q";
    if (no_effect) argv[argc++] = (char *)"-n";
    argv[argc++] = (char *)"-o";
    argv[argc++] = (char *)OUT_PATH;
    argv[argc++] = (char *)IN_PATH;
    argv[argc] = NULL;

    rc = main(argc, argv);
    if (rc != 0) return -4;

    f = fopen(OUT_PATH, "rb");
    if (f == NULL) return -5;
    fseek(f, 0, SEEK_END);
    size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0)
    {
        fclose(f);
        return -6;
    }
    g_out = (unsigned char *)malloc((size_t)size);
    if (g_out == NULL)
    {
        fclose(f);
        return -7;
    }
    if (fread(g_out, 1, (size_t)size, f) != (size_t)size)
    {
        fclose(f);
        exo_free();
        return -8;
    }
    fclose(f);

    g_out_len = (int)size;
    return g_out_len;
}
