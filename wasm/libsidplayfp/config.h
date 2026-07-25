/* Hand-written config.h for the Emscripten build of libsidplayfp.
 * Replaces the autotools-generated header. No file-drivers, no threads,
 * no hardware SID backends - just the software emulation core + reSIDfp.
 */
#ifndef LIBSIDPLAYFP_EMCC_CONFIG_H
#define LIBSIDPLAYFP_EMCC_CONFIG_H

/* Language level: sidcxx11.h derives HAVE_CXX14/HAVE_CXX11 from this.
 * Bare define (no value) to match sidcxx11.h's own defines. */
#define HAVE_CXX17

/* Standard headers available under Emscripten/musl */
#define STDC_HEADERS 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRING_H 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define HAVE_STRCASECMP 1
#define HAVE_STRNCASECMP 1

/* wasm32: little endian, ILP32 */
#define SIZEOF_SHORT 2
#define SIZEOF_INT 4
/* WORDS_BIGENDIAN intentionally undefined */

/* No pthread, libgcrypt, or hardware SID drivers (HardSID/exSID/USBSID) */

#define PACKAGE "libsidplayfp"
#define PACKAGE_NAME "libsidplayfp"
#define PACKAGE_VERSION "2.16.1"
#define PACKAGE_STRING "libsidplayfp 2.16.1"
#define PACKAGE_BUGREPORT ""
#define PACKAGE_TARNAME "libsidplayfp"
#define PACKAGE_URL ""
#define VERSION "2.16.1"

#endif /* LIBSIDPLAYFP_EMCC_CONFIG_H */
